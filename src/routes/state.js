const express = require('express');
const db = require('../db');
const auth = require('../auth');
const eco = require('../economyLib');

const router = express.Router();

// Full game state is stored as one JSON blob for non-economy progress.
// resources / inventory / horizonCoins are server-authoritative and ignored
// from the client body on PUT (mutate via /api/economy/* and /api/market/*).
const MAX_STATE_BYTES = 2 * 1024 * 1024; // 2MB safety cap per player

router.get('/state', auth.requireAuth, (req, res) => {
    const state = eco.normalizeState(req.player);
    res.json({
        state,
        horizonCoins: state.horizonCoins,
        resources: state.resources,
        inventory: state.inventory,
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

    // Merge progress fields from client, but NEVER trust client economy wallets.
    const nextState = {
        ...state,
        resources: existing.resources,
        inventory: existing.inventory,
        horizonCoins: existing.horizonCoins,
        economyCollectedAt: existing.economyCollectedAt || state.economyCollectedAt || null,
    };

    await db.query(
        'UPDATE players SET state = $1, horizon_coins = $2 WHERE id = $3',
        [nextState, existing.horizonCoins, req.player.id]
    );

    res.json({
        success: true,
        savedAt: new Date().toISOString(),
        horizonCoins: existing.horizonCoins,
        resources: existing.resources,
        inventory: existing.inventory,
        economyLocked: true,
    });
});

module.exports = router;
