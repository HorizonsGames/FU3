#!/usr/bin/env python3
"""
Build Fractured Universe — Player Guide (PDF).

- Generates figure images in manual_assets/figures/ (placeholders styled like the game UI).
- If you add real screenshots as PNG files in manual_assets/screenshots/ with matching names,
  those are used instead (same basename as in FIGURES, e.g. 01-main-hud.png).

Run: python build_player_manual_pdf.py
Output: Fractured-Universe-Player-Guide.pdf
"""

from __future__ import annotations

import os
from pathlib import Path

from fpdf import FPDF
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
FIG_DIR = ROOT / "manual_assets" / "figures"
SHOT_DIR = ROOT / "manual_assets" / "screenshots"
OUT_PDF = ROOT / "Fractured-Universe-Player-Guide.pdf"

# fpdf core fonts only support Latin-1; we need TTF for em dashes, bullets, etc.
FONT_FAMILY = "BodyUI"


def register_pdf_fonts(pdf: FPDF) -> None:
    win = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    regular = win / "segoeui.ttf"
    bold = win / "segoeuib.ttf"
    italic = win / "segoeuii.ttf"
    bold_italic = win / "segoeuiz.ttf"
    if not regular.is_file():
        raise FileNotFoundError(
            f"Need a Unicode TTF (e.g. Segoe UI at {regular}). "
            "Install Windows fonts or edit register_pdf_fonts() in build_player_manual_pdf.py."
        )
    pdf.add_font(FONT_FAMILY, "", str(regular))
    pdf.add_font(FONT_FAMILY, "B", str(bold if bold.is_file() else regular))
    pdf.add_font(FONT_FAMILY, "I", str(italic if italic.is_file() else regular))
    pdf.add_font(
        FONT_FAMILY,
        "BI",
        str(bold_italic if bold_italic.is_file() else (bold if bold.is_file() else regular)),
    )

# (file stem, title line, hint line)
FIGURES: list[tuple[str, str, str]] = [
    ("01-main-hud", "The main screen", "Left: planets · Center: map · Right: research · Bottom: resources"),
    ("02-owned-tab", "Planet list — Owned", "Your worlds: rename, search, or remove. Scout and Bounties live here too."),
    ("03-available-tab", "Planet list — Available", "Unclaimed worlds. Use Claim when you are ready to settle."),
    ("04-enemy-tab", "Planet list — Enemy", "Opponent worlds. Attack when you want to fight for control."),
    ("05-clusters-tab", "Clusters", "Combine many planets into bigger groups. Higher tiers need more planets."),
    ("06-buildings-tab", "Buildings", "Pick a planet you own first, then upgrade structures here."),
    ("07-ship-build", "Ship Production — Build", "Queue ships you have already researched. Watch the build timer."),
    ("08-my-fleet", "Ship Production — My Fleet", "Create fleets, add ships, duel, and save templates."),
    ("09-add-ships", "Adding ships to a fleet", "Up to 10 ship stacks per fleet. Use MAX to fill from your dock."),
    ("10-maintenance", "Ship Production — Maintenance", "Ships cost credits every hour. Smaller fleets = lower bills."),
    ("11-research", "Ship Research — Available", "Unlock new hulls. Locked entries show what to research first."),
    ("12-rankings", "Rankings", "See how you compare. Score mixes planets and military power."),
    ("13-bounties", "Bounties", "Filter big rewards, search names, and track active targets."),
]


def ensure_dirs() -> None:
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    SHOT_DIR.mkdir(parents=True, exist_ok=True)


def make_placeholder_png(path: Path, title: str, hint: str) -> None:
    w, h = 960, 540
    img = Image.new("RGB", (w, h), (15, 23, 42))
    draw = ImageDraw.Draw(img)
    # Simple gradient bands
    for y in range(h):
        t = y / h
        r = int(15 + t * 25)
        g = int(23 + t * 40)
        b = int(42 + t * 60)
        draw.line([(0, y), (w, y)], fill=(r, g, b))
    # Accent bar
    draw.rectangle([0, 0, w, 8], fill=(0, 217, 255))
    draw.rectangle([0, h - 8, w, h], fill=(0, 217, 255))
    # Text
    try:
        segoe = Path(os.environ.get("WINDIR", "C:\\Windows")) / "Fonts" / "segoeui.ttf"
        font_title = ImageFont.truetype(str(segoe), 36)
        font_hint = ImageFont.truetype(str(segoe), 22)
        font_small = ImageFont.truetype(str(segoe), 18)
    except OSError:
        font_title = ImageFont.load_default()
        font_hint = ImageFont.load_default()
        font_small = ImageFont.load_default()
    draw.text((40, 80), title, fill=(226, 232, 240), font=font_title)
    draw.text((40, 160), hint, fill=(148, 163, 184), font=font_hint)
    draw.text(
        (40, h - 120),
        "Placeholder figure — run the game and your screen will match this area.",
        fill=(100, 116, 139),
        font=font_small,
    )
    draw.text(
        (40, h - 85),
        "Tip: drop a real PNG in manual_assets/screenshots/ with the same name to replace this.",
        fill=(100, 116, 139),
        font=font_small,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")


def resolve_image(stem: str) -> Path:
    shot = SHOT_DIR / f"{stem}.png"
    if shot.is_file():
        return shot
    fig = FIG_DIR / f"{stem}.png"
    if not fig.is_file():
        title = next((t for s, t, _ in FIGURES if s == stem), stem)
        hint = next((h for s, _, h in FIGURES if s == stem), "")
        make_placeholder_png(fig, title, hint)
    return fig


class GuidePDF(FPDF):
    def __init__(self) -> None:
        super().__init__()
        self.set_auto_page_break(auto=True, margin=18)

    def footer(self) -> None:
        self.set_y(-14)
        self.set_font(FONT_FAMILY, "I", 9)
        self.set_text_color(120, 120, 120)
        self.cell(0, 10, f"Page {self.page_no()}", align="C")


def add_wrapped(pdf: FPDF, text: str, size: int = 11) -> None:
    pdf.set_font(FONT_FAMILY, size=size)
    pdf.set_text_color(30, 30, 30)
    pdf.multi_cell(pdf.epw, 6, text)


def main() -> None:
    ensure_dirs()

    pdf = GuidePDF()
    register_pdf_fonts(pdf)
    pdf.add_page()

    # Title
    pdf.set_font(FONT_FAMILY, "B", 22)
    pdf.set_text_color(0, 120, 140)
    pdf.multi_cell(pdf.epw, 10, "Fractured Universe")
    pdf.set_font(FONT_FAMILY, "B", 16)
    pdf.set_text_color(40, 40, 40)
    pdf.multi_cell(pdf.epw, 8, "Player Guide (no story spoilers)")
    pdf.ln(4)

    pdf.set_font(FONT_FAMILY, size=11)
    pdf.set_text_color(50, 50, 50)
    intro = (
        "Welcome! This short guide helps you start the game, understand what each part of the screen "
        "is for, and avoid common headaches. It does not reveal plot or surprise content.\n\n"
        "The pictures in this PDF are either your own screenshots (if you added them) or simple "
        "placeholders with the same layout labels. When you play, your real UI will match those labels."
    )
    pdf.multi_cell(pdf.epw, 6, intro)
    pdf.ln(3)

    pdf.set_font(FONT_FAMILY, "B", 14)
    pdf.set_text_color(0, 100, 120)
    pdf.cell(0, 10, "Start the game (easy steps)", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font(FONT_FAMILY, size=11)
    pdf.set_text_color(40, 40, 40)
    steps = (
        "1. Open PowerShell.\n"
        '2. Go to the game folder, for example:\n   cd "C:\\Users\\YourName\\Downloads\\FU-Commander-Update2.01"\n'
        "3. Start a tiny local server:\n   python -m http.server 8000\n"
        "4. In Chrome or Edge, open:\n   http://127.0.0.1:8000/fractured-universe-commander-update.html\n\n"
        "Why not double-click the HTML file? Some browsers block that mode for bigger games. "
        "Using the address above avoids that. Press Ctrl+C in PowerShell when you are done playing."
    )
    pdf.multi_cell(pdf.epw, 6, steps)
    pdf.ln(2)

    pdf.set_font(FONT_FAMILY, "B", 14)
    pdf.set_text_color(0, 100, 120)
    pdf.cell(0, 10, "How you play", new_x="LMARGIN", new_y="NEXT")
    add_wrapped(
        pdf,
        "You mostly click. Tabs switch views. The bottom bar shows your resources. "
        "The center map has + and - to zoom and a circle button to reset the view. "
        "Type in chat or search boxes when you see them; Enter often sends a chat message.",
    )
    pdf.ln(2)

    pdf.set_font(FONT_FAMILY, "B", 14)
    pdf.set_text_color(0, 100, 120)
    pdf.cell(0, 10, "Saving your progress", new_x="LMARGIN", new_y="NEXT")
    add_wrapped(
        pdf,
        "The game saves on its own about every half minute while you are playing. "
        "Data lives in your browser storage, so use the same browser and the same address "
        "(for example always 127.0.0.1:8000) if you want the same empire. "
        "Clearing site data or switching browsers starts you fresh.",
    )
    pdf.ln(4)

    # Figures + sections
    section_bodies: dict[str, str] = {
        "01-main-hud": (
            "This is home base. Top row: commanders, optional coin shop, sound, chat, guild, tech tree, "
            "market, inventory, your faction name, and account menu. Left column is all planet work. "
            "Center is the star map and ship yard. Right column is ship research and rankings."
        ),
        "02-owned-tab": (
            "Here are the worlds you control. Rename for clarity, Search to look for artifacts, "
            "Destroy only if you really mean it. Scout New Planet spends credits and fuel to reveal "
            "another world after a short wait. Bounties opens the bounty board."
        ),
        "03-available-tab": (
            "Neutral planets waiting for someone to claim them. Claim costs resources. "
            "Grow here when you are stable on income and defense."
        ),
        "04-enemy-tab": (
            "Worlds held by other factions. Attack starts a fight. Expect notifications and "
            "event-log messages so you know what happened."
        ),
        "05-clusters-tab": (
            "Late-game organization: merge many planets into one cluster tier by tier. "
            "Buttons stay gray until you have enough pieces for that tier."
        ),
        "06-buildings-tab": (
            "After you select a planet (or cluster) under Owned, open Buildings to construct or "
            "upgrade. Each building shows metal and credit costs and a max level."
        ),
        "07-ship-build": (
            "Build only ships you finished researching. Pick a quantity, press Build, "
            "and watch the queue. Costs come from your bottom-bar resources."
        ),
        "08-my-fleet": (
            "Fleets are groups of ships for travel and fights. Create Fleet, then add ships. "
            "Try Fleet Duel for practice. Save Template if you like a setup and want to reuse it."
        ),
        "09-add-ships": (
            "You can mix ship types until you hit the stack limit shown at the top of the window. "
            "MAX fills one row up to what you own. Confirm to move ships into the fleet."
        ),
        "10-maintenance": (
            "Every ship adds an hourly credit cost. If this number feels high, retire old hulls "
            "or keep fewer ships in service."
        ),
        "11-research": (
            "Research unlocks hulls for building. Complete marks what you already have. "
            "Research starts a timer. Locked means you need another hull first."
        ),
        "12-rankings": (
            "A friendly scoreboard. The mix of planets and firepower decides rank—check the formula "
            "on screen when you open it."
        ),
        "13-bounties": (
            "Browse contracts on players. Filters help you focus on huge payouts or your own listings. "
            "Search narrows the list by name."
        ),
    }

    for stem, title, _hint in FIGURES:
        pdf.add_page()
        img_path = resolve_image(stem)
        pdf.set_font(FONT_FAMILY, "B", 16)
        pdf.set_text_color(0, 100, 120)
        pdf.cell(0, 10, title, new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)
        # Fit image to printable width (~180mm)
        iw = 180
        try:
            with Image.open(img_path) as im:
                wpx, hpx = im.size
                ih = iw * hpx / wpx
                if ih > 120:
                    ih = 120
                    iw = ih * wpx / hpx
            pdf.image(str(img_path), w=iw)
        except Exception:
            pdf.set_font(FONT_FAMILY, "I", 11)
            pdf.multi_cell(pdf.epw, 6, f"(Could not load image: {img_path.name})")
        pdf.ln(3)
        add_wrapped(pdf, section_bodies.get(stem, ""))
        pdf.ln(2)

    pdf.add_page()
    pdf.set_font(FONT_FAMILY, "B", 14)
    pdf.set_text_color(0, 100, 120)
    pdf.cell(0, 10, "Quick tips", new_x="LMARGIN", new_y="NEXT")
    tips = (
        "• Scout and claim in bursts when your income is positive.\n"
        "• Research before you mass-build—otherwise build buttons stay empty.\n"
        "• Read the red warnings; they usually mean missing resources or prerequisites.\n"
        "• If audio never starts, click anywhere once, then hit the speaker icon again.\n"
        "• Guild, market, and chat are on the top icon row—handy when you need people or trades."
    )
    add_wrapped(pdf, tips)
    pdf.ln(3)

    pdf.set_font(FONT_FAMILY, "B", 14)
    pdf.set_text_color(0, 100, 120)
    pdf.cell(0, 10, "If something goes wrong", new_x="LMARGIN", new_y="NEXT")
    fix = (
        "Blank page: use http://127.0.0.1:8000/... not file://. Make sure python -m http.server is running.\n"
        "Wrong save: you might have opened a different port or browser before. Stick to one address.\n"
        "Stuck UI: refresh once; if still bad, clear site data for 127.0.0.1 and start clean.\n"
        "Replace placeholder art: save PNG files under manual_assets/screenshots/ using names like "
        "01-main-hud.png, then run this script again."
    )
    add_wrapped(pdf, fix)

    pdf.output(OUT_PDF)
    print(f"Wrote {OUT_PDF}")


if __name__ == "__main__":
    main()
