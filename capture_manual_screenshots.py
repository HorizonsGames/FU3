#!/usr/bin/env python3
"""
Automate a tour of the main Fractured Universe UI and save PNGs for the instruction manual.

Requires: pip install playwright
Browser: uses Chromium bundled with Playwright, or set PLAYWRIGHT_CHANNEL=msedge.

Start the game server first, e.g.:
  python -m http.server 8000

Then:
  python capture_manual_screenshots.py
  python build_player_manual_pdf.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "manual_assets" / "screenshots"
BASE = os.environ.get("MANUAL_BASE_URL", "http://127.0.0.1:8000/fractured-universe-commander-update.html")
VIEWPORT = {"width": 1680, "height": 960}


def snap(page, stem: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{stem}.png"
    page.screenshot(path=str(path), full_page=False)
    print(f"  saved {path.name}")
    return path


def close_chat(page) -> None:
    page.evaluate(
        """() => {
            if (window.chatManager && typeof window.chatManager.closeChat === 'function') {
                window.chatManager.closeChat();
            }
        }"""
    )


def wait_game(page, timeout: float = 90.0) -> None:
    page.wait_for_selector("#mapCanvas", state="attached", timeout=int(timeout * 1000))
    page.wait_for_function(
        "() => window.game && typeof window.game.switchPlanetTab === 'function'",
        timeout=int(timeout * 1000),
    )
    time.sleep(2.0)


def inject_demo_ship(page) -> None:
    page.evaluate(
        """() => {
            if (!window.game) return;
            window.game.ships['Scout Vessel'] = {
                name: 'Scout Vessel',
                researched: true,
                count: 12,
                icon: '🛸',
                damage: 40,
                hitPoints: 200,
                hull: 25
            };
        }"""
    )


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    # Prefer system Edge/Chrome so we do not rely on Playwright's headless-shell (often blocked by disk space).
    channel = os.environ.get("PLAYWRIGHT_CHANNEL", "msedge").strip()

    with sync_playwright() as p:
        launch_kw: dict = {"headless": True, "channel": channel}
        try:
            browser = p.chromium.launch(**launch_kw)
        except Exception:
            try:
                launch_kw = {"headless": True, "channel": "chrome"}
                browser = p.chromium.launch(**launch_kw)
            except Exception as e2:
                print("Launch failed (msedge and chrome channels). Error:", repr(e2))
                print("Install Edge or Chrome, or set PLAYWRIGHT_CHANNEL and ensure browser exists.")
                return 1

        context = browser.new_context(viewport=VIEWPORT)
        page = context.new_page()

        print(f"Loading {BASE} ...")
        try:
            page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        except PlaywrightTimeout:
            print("ERROR: Could not load page. Is python -m http.server running in this folder?")
            browser.close()
            return 1

        try:
            wait_game(page)
        except PlaywrightTimeout:
            print("ERROR: Game UI did not appear in time.")
            browser.close()
            return 1

        close_chat(page)
        time.sleep(0.4)
        inject_demo_ship(page)

        # Core layout (matches build_player_manual_pdf.py FIGURES)
        snap(page, "01-main-hud")

        for tab_id, stem in [
            ("planetTabOwned", "02-owned-tab"),
            ("planetTabAvailable", "03-available-tab"),
            ("planetTabEnemy", "04-enemy-tab"),
            ("planetTabClusters", "05-clusters-tab"),
            ("planetTabBuildings", "06-buildings-tab"),
        ]:
            page.click(f"#{tab_id}")
            time.sleep(0.5)
            snap(page, stem)

        # Ship production (click tabs — switchBuildTab() expects click event.target from HTML)
        page.get_by_role("button", name="Build Ships", exact=True).click()
        time.sleep(0.4)
        snap(page, "07-ship-build")

        page.get_by_role("button", name="My Fleet", exact=True).click()
        time.sleep(0.5)
        snap(page, "08-my-fleet")

        page.once("dialog", lambda d: d.accept("Player Guide Fleet"))
        page.get_by_role("button", name="CREATE FLEET", exact=False).click()
        time.sleep(0.8)
        try:
            page.wait_for_selector("#fleetShipSelectorModal", state="visible", timeout=8000)
            snap(page, "09-add-ships")
        except PlaywrightTimeout:
            print("  (warn) add-ships modal not shown; saving fleet view anyway")
            snap(page, "09-add-ships")
        page.evaluate(
            """() => {
                const m = document.getElementById('fleetShipSelectorModal');
                if (m && m.parentNode) m.parentNode.removeChild(m);
            }"""
        )

        page.get_by_role("button", name="Maintenance", exact=True).click()
        time.sleep(0.4)
        snap(page, "10-maintenance")

        # Research
        page.click("#researchTabAvailable")
        time.sleep(0.5)
        snap(page, "11-research")

        page.click("#researchTabRankings")
        time.sleep(0.6)
        snap(page, "12-rankings")

        # Bounties (must be on Owned)
        page.click("#planetTabOwned")
        time.sleep(0.3)
        page.evaluate("() => { if (typeof showBountiesPanel === 'function') showBountiesPanel(); }")
        time.sleep(0.6)
        snap(page, "13-bounties")
        page.evaluate("() => { if (typeof hideBountiesPanel === 'function') hideBountiesPanel(); }")
        time.sleep(0.3)

        # Extra panels (best-effort — some builds differ)
        def extra_panel(name: str, fn) -> None:
            try:
                fn()
                time.sleep(0.5)
                snap(page, name)
            except Exception as ex:
                print(f"  (warn) {name}: {ex}")

        def open_chat() -> None:
            page.evaluate("() => { if (window.chatManager) window.chatManager.openChat(); }")

        def close_extra_ui() -> None:
            close_chat(page)
            page.evaluate("() => { try { hideBountiesPanel(); } catch (e) {} }")
            page.evaluate("() => { try { window.guildUI.closeGuildPanel(); } catch (e) {} }")
            page.evaluate("() => { try { window.game.closeTechTree(); } catch (e) {} }")
            page.evaluate("() => { try { window.game.closeInventory(); } catch (e) {} }")
            page.evaluate(
                """() => {
                    try {
                        if (window.game && window.game.commanderManager) window.game.commanderManager.closePanel();
                    } catch (e) {}
                }"""
            )
            page.evaluate("() => { try { marketUI.closeMarket(); } catch (e) {} }")

        extra_panel("14-chat", open_chat)
        close_chat(page)
        time.sleep(0.3)

        extra_panel(
            "15-guild",
            lambda: page.evaluate("() => window.guildUI.openGuildPanel()"),
        )
        page.evaluate("() => { try { window.guildUI.closeGuildPanel(); } catch (e) {} }")
        time.sleep(0.2)

        extra_panel(
            "16-tech-tree",
            lambda: page.evaluate("() => window.game.openTechTree()"),
        )
        page.evaluate("() => { try { window.game.closeTechTree(); } catch (e) {} }")
        time.sleep(0.2)

        def open_market() -> None:
            page.locator("[title='Player Market']").click()

        extra_panel("17-market", open_market)
        try:
            page.locator(".market-panel-close").click(timeout=5000)
        except Exception:
            pass
        time.sleep(0.2)

        extra_panel(
            "18-inventory",
            lambda: page.evaluate("() => window.game.openInventory()"),
        )
        page.evaluate("() => { try { window.game.closeInventory(); } catch (e) {} }")
        time.sleep(0.2)

        def open_commanders() -> None:
            page.locator("button.header-commanders-btn").first.click()

        extra_panel("19-commanders", open_commanders)
        close_extra_ui()
        time.sleep(0.2)

        browser.close()

    print(f"Done. PNGs in {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
