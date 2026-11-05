/**
 * Wall-clock catch-up for ship research, tech research, and ship builds.
 * Progress continues while the browser is closed or the player is logged out:
 * GET /api/state applies elapsed time since `researchCaughtUpAt` and persists.
 */

const MAX_CATCHUP_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function parseTs(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Date.parse(String(value));
    return Number.isFinite(n) ? n : null;
}

function shipResearchRate(state) {
    const unlocked = state.unlockedRaceTechs || state._unlockedRaceTechs || {};
    return unlocked.shipwright_trance ? 1.25 : 1;
}

function techResearchRate(state) {
    const unlocked = state.unlockedRaceTechs || state._unlockedRaceTechs || {};
    return unlocked.chronal_focus ? 1.3 : 1;
}

function ensureShip(state, name, seed) {
    if (!state.ships || typeof state.ships !== 'object') state.ships = {};
    if (!state.ships[name]) {
        state.ships[name] = {
            name,
            count: 0,
            researched: false,
            ...(seed && typeof seed === 'object' ? seed : {}),
        };
    }
    return state.ships[name];
}

function applyTechEffects(state, effects) {
    if (!Array.isArray(effects) || !effects.length) return;
    if (!state.techBonuses || typeof state.techBonuses !== 'object') state.techBonuses = {};
    for (const effect of effects) {
        if (!effect || typeof effect !== 'object') continue;
        if (effect.type === 'resource' && effect.resource) {
            state.techBonuses[effect.resource] = (state.techBonuses[effect.resource] || 0) + (Number(effect.value) || 0);
        } else if ((effect.type === 'combat' || effect.type === 'defense' || effect.type === 'special') && effect.stat) {
            state.techBonuses[effect.stat] = (state.techBonuses[effect.stat] || 0) + (Number(effect.value) || 0);
        }
    }
}

function completeShipResearch(state, item) {
    const ship = ensureShip(state, item.name, {
        icon: item.icon,
        damage: item.damage,
        hitPoints: item.hitPoints,
    });
    ship.researched = true;
    ship.count = Math.max(0, Math.floor(Number(ship.count) || 0)) + 1;
}

function completeBuild(state, item) {
    const name = item.shipName || item.name;
    if (!name) return;
    const seed = item.isSpecial && item.specialShipData && typeof item.specialShipData === 'object'
        ? { ...item.specialShipData, researched: true }
        : { researched: true };
    const ship = ensureShip(state, name, seed);
    if (item.isSpecial) ship.researched = true;
    ship.count = Math.max(0, Math.floor(Number(ship.count) || 0)) + Math.max(1, Math.floor(Number(item.quantity) || 1));
}

function completeTechResearch(state, item) {
    if (!state.technologies || typeof state.technologies !== 'object') state.technologies = {};
    const id = item.id;
    const saved = state.technologies[id] && typeof state.technologies[id] === 'object'
        ? { ...state.technologies[id] }
        : {};
    saved.researched = true;
    saved.researching = false;
    saved.progress = Math.max(Number(saved.progress) || 0, Number(item.time) || Number(item.progress) || 0);
    state.technologies[id] = saved;
    applyTechEffects(state, item.effects);
}

/**
 * Advance timed queues by wall-clock elapsed time since researchCaughtUpAt.
 * Mutates and returns state. Sets researchCaughtUpAt to `nowMs`.
 */
function catchUpResearch(state, nowMs = Date.now()) {
    if (!state || typeof state !== 'object') {
        return { state, changed: false, completed: [] };
    }

    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const completed = [];
    let changed = false;

    const lastRaw = parseTs(state.researchCaughtUpAt);
    // First stamp: establish baseline without inventing offline progress we can't measure.
    if (lastRaw == null) {
        state.researchCaughtUpAt = new Date(now).toISOString();
        return { state, changed: true, completed };
    }

    let elapsedMs = now - lastRaw;
    if (elapsedMs < 0) elapsedMs = 0;
    if (elapsedMs > MAX_CATCHUP_MS) elapsedMs = MAX_CATCHUP_MS;

    // No meaningful time passed — leave watermark alone (avoid write amplification on GET).
    if (elapsedMs < 250) {
        return { state, changed: false, completed };
    }

    // Refresh watermark so the same elapsed window is never applied twice.
    state.researchCaughtUpAt = new Date(now).toISOString();
    changed = true;

    const elapsedSec = elapsedMs / 1000;
    const shipRate = shipResearchRate(state);
    const techRate = techResearchRate(state);

    // ── Ship research (parallel) ──
    if (Array.isArray(state.researchQueue) && state.researchQueue.length) {
        const next = [];
        for (const item of state.researchQueue) {
            if (!item || typeof item !== 'object') continue;
            let remaining;
            const endsAt = parseTs(item.endsAt);
            if (endsAt != null) {
                remaining = (endsAt - now) / 1000;
            } else {
                remaining = (Number(item.timeRemaining) || 0) - elapsedSec * shipRate;
            }
            if (remaining <= 0) {
                completeShipResearch(state, item);
                completed.push({ type: 'ship', name: item.name });
                changed = true;
            } else {
                item.timeRemaining = remaining;
                if (endsAt == null && item.totalTime) {
                    item.endsAt = now + (remaining / shipRate) * 1000;
                }
                next.push(item);
                changed = true;
            }
        }
        state.researchQueue = next;
    }

    // ── Tech research (sequential — only head of queue burns time) ──
    if (Array.isArray(state.techResearchQueue) && state.techResearchQueue.length) {
        let budget = elapsedSec * techRate;
        while (state.techResearchQueue.length && budget > 0) {
            const item = state.techResearchQueue[0];
            if (!item || typeof item !== 'object') {
                state.techResearchQueue.shift();
                changed = true;
                continue;
            }
            const need = Math.max(0, (Number(item.time) || 0) - (Number(item.progress) || 0));
            if (need <= 0) {
                completeTechResearch(state, item);
                state.techResearchQueue.shift();
                completed.push({ type: 'tech', id: item.id });
                changed = true;
                continue;
            }
            if (budget >= need) {
                budget -= need;
                item.progress = Number(item.time) || (Number(item.progress) || 0) + need;
                completeTechResearch(state, item);
                state.techResearchQueue.shift();
                completed.push({ type: 'tech', id: item.id });
                changed = true;
            } else {
                item.progress = (Number(item.progress) || 0) + budget;
                budget = 0;
                if (!state.technologies) state.technologies = {};
                const saved = state.technologies[item.id] && typeof state.technologies[item.id] === 'object'
                    ? { ...state.technologies[item.id] }
                    : {};
                saved.researching = true;
                saved.researched = false;
                saved.progress = item.progress;
                state.technologies[item.id] = saved;
                changed = true;
            }
        }
        // Mark remaining queue heads as researching for client UI
        const active = new Set(state.techResearchQueue.map((r) => r && r.id).filter(Boolean));
        if (state.technologies && typeof state.technologies === 'object') {
            for (const [id, tech] of Object.entries(state.technologies)) {
                if (!tech || typeof tech !== 'object') continue;
                if (tech.researched) {
                    tech.researching = false;
                } else {
                    tech.researching = active.has(id);
                }
            }
        }
    }

    // ── Ship build queue (parallel) ──
    if (Array.isArray(state.buildQueue) && state.buildQueue.length) {
        const next = [];
        for (const item of state.buildQueue) {
            if (!item || typeof item !== 'object') continue;
            let remaining;
            const endsAt = parseTs(item.endsAt);
            if (endsAt != null) {
                remaining = (endsAt - now) / 1000;
            } else {
                remaining = (Number(item.timeRemaining) || 0) - elapsedSec;
            }
            if (remaining <= 0) {
                completeBuild(state, item);
                completed.push({ type: 'build', name: item.shipName || item.name, quantity: item.quantity });
                changed = true;
            } else {
                item.timeRemaining = remaining;
                if (endsAt == null && item.totalTime) {
                    item.endsAt = now + remaining * 1000;
                }
                next.push(item);
                changed = true;
            }
        }
        state.buildQueue = next;
    }

    return { state, changed, completed };
}

module.exports = {
    catchUpResearch,
    MAX_CATCHUP_MS,
};
