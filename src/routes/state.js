const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// Full game state is stored as one JSON blob, mirroring what the client already
// keeps in localStorage — this is intentionally a drop-in replacement, not a
// redesign, so migrating the client is "send/receive this blob" rather than a
// new data model.
const MAX_STATE_BYTES = 2 * 1024 * 1024; // 2MB safety cap per player

router.get('/state', auth.requireAuth, (req, res) => {
    res.json({ state: req.player.state || {} });
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

    await db.query('UPDATE players SET state = $1 WHERE id = $2', [state, req.player.id]);
    res.json({ success: true, savedAt: new Date().toISOString() });
});

module.exports = router;
