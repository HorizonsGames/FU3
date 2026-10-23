const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// Create a new boss fight. guildId omitted/null = world boss (open to everyone);
// guildId set = guild boss (only meaningful to that guild's members, though
// nothing here enforces membership — the MP room is public to whoever joins
// the roomId, same trust model as the rest of this relay-only backend).
router.post('/bosses', auth.requireAuth, async (req, res) => {
    const { bossName, guildId, maxHp } = req.body || {};
    if (!bossName || !maxHp || maxHp <= 0) {
        return res.status(400).json({ error: 'bossName and a positive maxHp are required.' });
    }

    try {
        const id = crypto.randomUUID();
        const { rows } = await db.query(
            `INSERT INTO boss_instances (id, boss_name, guild_id, max_hp, current_hp)
             VALUES ($1, $2, $3, $4, $4) RETURNING *`,
            [id, bossName, guildId || null, maxHp]
        );
        res.status(201).json({ boss: toPublicBoss(rows[0]) });
    } catch (err) {
        console.error('[boss/create]', err);
        res.status(500).json({ error: 'Could not create boss instance.' });
    }
});

// Active (undefeated) bosses. ?guildId=... filters to one guild's bosses;
// omitted returns world bosses (guild_id IS NULL) only.
router.get('/bosses/active', auth.requireAuth, async (req, res) => {
    const { guildId } = req.query;
    const { rows } = await db.query(
        guildId
            ? `SELECT * FROM boss_instances WHERE guild_id = $1 AND defeated_at IS NULL ORDER BY started_at DESC`
            : `SELECT * FROM boss_instances WHERE guild_id IS NULL AND defeated_at IS NULL ORDER BY started_at DESC`,
        guildId ? [guildId] : []
    );
    res.json({ bosses: rows.map(toPublicBoss) });
});

router.get('/bosses/:id', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM boss_instances WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Boss instance not found.' });
    res.json({ boss: toPublicBoss(rows[0]) });
});

// Apply damage to a boss's shared HP pool. Same trust model as the rest of
// this relay backend: the client reports how much damage it dealt, the
// server just totals it up and clamps at zero — it does not verify the
// damage amount is legitimate. Making this authoritative (server computes
// damage from fleet composition instead of trusting the client's number) is
// the natural next step once combat resolution itself moves server-side.
router.post('/bosses/:id/damage', auth.requireAuth, async (req, res) => {
    const { amount } = req.body || {};
    if (typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number.' });
    }

    try {
        const { rows } = await db.query('SELECT * FROM boss_instances WHERE id = $1', [req.params.id]);
        const boss = rows[0];
        if (!boss) return res.status(404).json({ error: 'Boss instance not found.' });
        if (boss.defeated_at) return res.status(409).json({ error: 'This boss has already been defeated.' });

        const newHp = Math.max(0, Number(boss.current_hp) - amount);
        const defeated = newHp === 0;
        const { rows: updated } = await db.query(
            `UPDATE boss_instances SET current_hp = $1, defeated_at = ${defeated ? 'now()' : 'defeated_at'}
             WHERE id = $2 RETURNING *`,
            [newHp, req.params.id]
        );
        res.json({ boss: toPublicBoss(updated[0]), defeated });
    } catch (err) {
        console.error('[boss/damage]', err);
        res.status(500).json({ error: 'Could not apply damage.' });
    }
});

function toPublicBoss(row) {
    return {
        id: row.id,
        bossName: row.boss_name,
        guildId: row.guild_id,
        maxHp: Number(row.max_hp),
        currentHp: Number(row.current_hp),
        startedAt: row.started_at,
        defeatedAt: row.defeated_at,
    };
}

module.exports = router;
