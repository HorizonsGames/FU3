const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

router.post('/guilds', auth.requireAuth, async (req, res) => {
    const { name, tag } = req.body || {};
    if (!name || !tag) return res.status(400).json({ error: 'name and tag are required.' });

    try {
        const guildId = auth.generateId();
        const { rows } = await db.query(
            'INSERT INTO guilds (id, name, tag, leader_id) VALUES ($1, $2, $3, $4) RETURNING *',
            [guildId, name, tag, req.player.id]
        );
        const guild = rows[0];
        await db.query(
            "INSERT INTO guild_members (guild_id, player_id, role) VALUES ($1, $2, 'leader')",
            [guild.id, req.player.id]
        );
        res.status(201).json({ guild });
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'That guild name or tag is taken.' });
        console.error('[guild/create]', err);
        res.status(500).json({ error: 'Could not create guild.' });
    }
});

router.post('/guilds/:guildId/join', auth.requireAuth, async (req, res) => {
    try {
        await db.query(
            `INSERT INTO guild_members (guild_id, player_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [req.params.guildId, req.player.id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('[guild/join]', err);
        res.status(500).json({ error: 'Could not join guild.' });
    }
});

router.get('/guilds/:guildId/roster', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query(
        `SELECT p.id, p.username, p.race, gm.role, gm.joined_at
         FROM guild_members gm JOIN players p ON p.id = gm.player_id
         WHERE gm.guild_id = $1 ORDER BY gm.joined_at ASC`,
        [req.params.guildId]
    );
    res.json({ members: rows });
});

module.exports = router;
