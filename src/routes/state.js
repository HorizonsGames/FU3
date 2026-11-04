const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// Full game state is stored as one JSON blob, mirroring what the client already
// keeps in localStorage — this is intentionally a drop-in replacement, not a
// redesign, so migrating the client is "send/receive this blob" rather than a
// new data model.
const MAX_STATE_BYTES = 2 * 1024 * 1024; // 2MB safety cap per player

function extractHorizonCoins(state, fallback) {
    const fromState = state && state.horizonCoins != null ? Number(state.horizonCoins) : NaN;
    if (Number.isFinite(fromState)) return Math.max(0, Math.floor(fromState));
    const fb = Number(fallback);
    return Number.isFinite(fb) ? Math.max(0, Math.floor(fb)) : 500;
}

router.get('/state', auth.requireAuth, (req, res) => {
    const state = (req.player.state && typeof req.player.state === 'object')
        ? { ...req.player.state }
        : {};
    // Column is source of truth after wipes; always surface it on the blob for the client
    const hc = extractHorizonCoins(state, req.player.horizon_coins);
    state.horizonCoins = hc;
    res.json({ state, horizonCoins: hc });
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

    const hc = extractHorizonCoins(state, req.player.horizon_coins);
    const nextState = { ...state, horizonCoins: hc };

    await db.query(
        'UPDATE players SET state = $1, horizon_coins = $2 WHERE id = $3',
        [nextState, hc, req.player.id]
    );
    res.json({ success: true, savedAt: new Date().toISOString(), horizonCoins: hc });
});

module.exports = router;
