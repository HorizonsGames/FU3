const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

const GLOBAL_KEY = 'stellarCommandChat';
const EVENTS_KEY = 'stellarCommandEventLog';
const MAX_MESSAGES = 200;
const MAX_TEXT = 400;

function guildChatKey(guildId) {
    return `fu_guildChat_${guildId}`;
}

async function readBlob(key) {
    const { rows } = await db.query('SELECT value, updated_at FROM world_kv WHERE key = $1', [key]);
    if (!rows.length) return { value: null, updatedAt: null };
    return { value: rows[0].value, updatedAt: rows[0].updated_at };
}

async function writeBlob(key, value, playerId) {
    const { rows } = await db.query(
        `INSERT INTO world_kv (key, value, updated_at, updated_by)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING updated_at`,
        [key, value, playerId]
    );
    return rows[0].updated_at;
}

function sanitizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

async function playerGuildId(playerId) {
    const { rows } = await db.query(
        'SELECT guild_id FROM guild_members WHERE player_id = $1 LIMIT 1',
        [playerId]
    );
    return rows[0]?.guild_id || null;
}

// GET /api/chat
router.get('/chat', auth.requireAuth, async (req, res) => {
    const { value, updatedAt } = await readBlob(GLOBAL_KEY);
    const messages = Array.isArray(value?.messages) ? value.messages.slice(-MAX_MESSAGES) : [];
    res.json({ messages, updatedAt });
});

// POST /api/chat  { text }
router.post('/chat', auth.requireAuth, async (req, res) => {
    const text = sanitizeText(req.body?.text);
    if (!text) return res.status(400).json({ error: 'Message text required.' });

    const { value } = await readBlob(GLOBAL_KEY);
    const messages = Array.isArray(value?.messages) ? value.messages.slice() : [];
    const message = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        username: req.player.username,
        playerId: req.player.id,
        race: req.player.race || null,
        text,
        timestamp: Date.now(),
        type: 'user',
    };
    messages.push(message);
    const trimmed = messages.slice(-MAX_MESSAGES);
    const updatedAt = await writeBlob(GLOBAL_KEY, { messages: trimmed }, req.player.id);
    res.json({ success: true, message, messages: trimmed, updatedAt });
});

// GET /api/chat/events
router.get('/chat/events', auth.requireAuth, async (req, res) => {
    const { value, updatedAt } = await readBlob(EVENTS_KEY);
    const events = Array.isArray(value?.events) ? value.events.slice(-MAX_MESSAGES) : [];
    res.json({ events, updatedAt });
});

// POST /api/chat/events  { message, type }
router.post('/chat/events', auth.requireAuth, async (req, res) => {
    const message = sanitizeText(req.body?.message);
    if (!message) return res.status(400).json({ error: 'Event message required.' });
    const type = String(req.body?.type || 'info').slice(0, 32);
    const { value } = await readBlob(EVENTS_KEY);
    const events = Array.isArray(value?.events) ? value.events.slice() : [];
    const event = {
        message,
        type,
        username: req.player.username,
        timestamp: new Date().toISOString(),
        time: new Date().toLocaleTimeString(),
    };
    events.push(event);
    const trimmed = events.slice(-MAX_MESSAGES);
    const updatedAt = await writeBlob(EVENTS_KEY, { events: trimmed }, req.player.id);
    res.json({ success: true, event, events: trimmed, updatedAt });
});

// GET /api/chat/guild
router.get('/chat/guild', auth.requireAuth, async (req, res) => {
    const guildId = await playerGuildId(req.player.id);
    if (!guildId) return res.json({ messages: [], guildId: null, updatedAt: null });
    const { value, updatedAt } = await readBlob(guildChatKey(guildId));
    const messages = Array.isArray(value?.messages) ? value.messages.slice(-MAX_MESSAGES) : [];
    res.json({ messages, guildId, updatedAt });
});

// POST /api/chat/guild  { text }
router.post('/chat/guild', auth.requireAuth, async (req, res) => {
    const guildId = await playerGuildId(req.player.id);
    if (!guildId) return res.status(400).json({ error: 'Not in a guild.' });
    const text = sanitizeText(req.body?.text);
    if (!text) return res.status(400).json({ error: 'Message text required.' });

    const key = guildChatKey(guildId);
    const { value } = await readBlob(key);
    const messages = Array.isArray(value?.messages) ? value.messages.slice() : [];
    const message = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        username: req.player.username,
        playerId: req.player.id,
        text,
        timestamp: Date.now(),
        type: 'user',
    };
    messages.push(message);
    const trimmed = messages.slice(-MAX_MESSAGES);
    const updatedAt = await writeBlob(key, { messages: trimmed }, req.player.id);
    res.json({ success: true, message, messages: trimmed, guildId, updatedAt });
});

module.exports = router;
