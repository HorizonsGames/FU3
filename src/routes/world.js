const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// Read-only shared blobs. Mutations for market/chat/guilds go through
// action-validated routes (market.js / chat.js / guild.js) so clients cannot
// overwrite the entire document and invent listings, messages, or treasury.
const READ_KEYS = new Set([
    'fractured_market',
    'fractured_guilds',
    'stellarCommandChat',
    'stellarCommandEventLog',
]);

function isGuildFleetKey(key) {
    return /^fu_guildFleets_[A-Za-z0-9_-]+$/.test(key);
}

function isReadableKey(key) {
    if (READ_KEYS.has(key)) return true;
    if (isGuildFleetKey(key)) return true;
    // Guild chat is readable for convenience; posts go through /api/chat/guild
    return /^fu_guildChat_[A-Za-z0-9_-]+$/.test(key);
}

function isWritableKey(key) {
    // Only guild fleet markers remain as shared PUT (ephemeral map UX).
    // Everything economic / social is action-validated elsewhere.
    return isGuildFleetKey(key);
}

router.get('/world/:key', auth.requireAuth, async (req, res) => {
    const key = String(req.params.key || '');
    if (!isReadableKey(key)) {
        return res.status(400).json({ error: 'Unknown world key.' });
    }
    const { rows } = await db.query('SELECT value, updated_at FROM world_kv WHERE key = $1', [key]);
    if (!rows.length) {
        return res.json({ key, value: null, updatedAt: null });
    }
    res.json({ key, value: rows[0].value, updatedAt: rows[0].updated_at });
});

router.put('/world/:key', auth.requireAuth, async (req, res) => {
    const key = String(req.params.key || '');
    if (!isWritableKey(key)) {
        return res.status(403).json({
            error: 'Direct world overwrite denied. Use action APIs (/api/market, /api/chat, /api/guilds).',
        });
    }
    const value = req.body?.value;
    if (typeof value !== 'object' || value === null) {
        return res.status(400).json({ error: 'value must be a JSON object.' });
    }
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > 2 * 1024 * 1024) {
        return res.status(413).json({ error: 'World payload too large.' });
    }
    const { rows } = await db.query(
        `INSERT INTO world_kv (key, value, updated_at, updated_by)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING updated_at`,
        [key, value, req.player.id]
    );
    res.json({ success: true, key, updatedAt: rows[0].updated_at });
});

module.exports = router;
