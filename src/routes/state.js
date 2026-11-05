const express = require('express');
const db = require('../db');
const auth = require('../auth');
const eco = require('../economyLib');
const offline = require('../offlineLib');

const router = express.Router();

// Full game state is stored as one JSON blob for non-economy progress.
// resources / inventory / horizonCoins are server-authoritative and ignored
// from the client body on PUT (mutate via /api/economy/* and /api/market/*).
const MAX_STATE_BYTES = 2 * 1024 * 1024; // 2MB safety cap per player

function parseTs(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Date.parse(String(value));
    return Number.isFinite(n) ? n : null;
}

/** Prefer the later watermark so clients cannot rewind researchCaughtUpAt to invent offline progress. */
function mergeResearchWatermark(serverState, clientState) {
    const s = parseTs(serverState && serverState.researchCaughtUpAt);
    const c = parseTs(clientState && clientState.researchCaughtUpAt);
    if (s == null && c == null) return null;
    if (s == null) return clientState.researchCaughtUpAt;
    if (c == null) return serverState.researchCaughtUpAt;
    return s >= c ? serverState.researchCaughtUpAt : clientState.researchCaughtUpAt;
}

async function persistState(playerId, state, horizonCoins) {
    await db.query(
        'UPDATE players SET state = $1, horizon_coins = $2 WHERE id = $3',
        [state, horizonCoins, playerId]
    );
}

router.get('/state', auth.requireAuth, async (req, res) => {
    const state = eco.normalizeState(req.player);
    if (!state.selectedRace && req.player.race) {
        state.selectedRace = { name: req.player.race };
    }
    if (!state.playerData) state.playerData = { username: req.player.username };

    const { state: caught, changed, completed, economyDelta } = offline.catchUpOffline(state, Date.now());
    if (changed) {
        await persistState(req.player.id, caught, caught.horizonCoins);
    }
    res.json({
        state: caught,
        horizonCoins: caught.horizonCoins,
        resources: caught.resources,
        inventory: caught.inventory,
        offlineCaughtUp: true,
        completed,
        economyDelta,
    });
});

router.put('/state', auth.requireAuth, async (req, res) => {
    const { state } = req.body || {};
    if (typeof state !== 'object' || state === null) {
        return res.status(400).json({ error: 'state must be a JSON object.' });
    }
    const size = Buffer.byteLength(JSON.stringify(state));
    if (size > MAX_STATE_BYTES) {
        return res.status(413).json({ error: 'Save data is too large.' });
    }

    const existing = eco.normalizeState(req.player);
    const commandersMerged = offline.mergeCommanders(existing, state);

    // Merge progress fields from client, but NEVER trust client economy wallets.
    // Commanders are revision-protected so a stale empty autosave cannot wipe them.
    const nextState = {
        ...state,
        resources: existing.resources,
        inventory: existing.inventory,
        horizonCoins: existing.horizonCoins,
        economyCollectedAt: existing.economyCollectedAt || state.economyCollectedAt || null,
        researchCaughtUpAt: mergeResearchWatermark(existing, state) || state.researchCaughtUpAt || existing.researchCaughtUpAt || null,
        commanders: commandersMerged.commanders,
        commanderAssignments: commandersMerged.commanderAssignments,
        commandersRev: commandersMerged.commandersRev,
    };

    if (!nextState.selectedRace && req.player.race) {
        nextState.selectedRace = { name: req.player.race };
    }
    if (!nextState.playerData) nextState.playerData = { username: req.player.username };

    const { state: caught, completed, economyDelta } = offline.catchUpOffline(nextState, Date.now());

    await persistState(req.player.id, caught, existing.horizonCoins);

    res.json({
        success: true,
        savedAt: new Date().toISOString(),
        horizonCoins: caught.horizonCoins,
        resources: caught.resources,
        inventory: caught.inventory,
        economyLocked: true,
        state: caught,
        offlineCaughtUp: true,
        completed,
        economyDelta,
        commandersRev: caught.commandersRev || 0,
    });
});

module.exports = router;
