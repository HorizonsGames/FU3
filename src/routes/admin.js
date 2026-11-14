const express = require('express');
const auth = require('../auth');
const db = require('../db');
const { getOnlinePlayers, getOnlinePlayerIdSet } = require('../ws/hub');

const router = express.Router();

function planetCountFromState(state) {
    try {
        const planets = state && typeof state === 'object' ? state.planets : null;
        return Array.isArray(planets) ? planets.length : 0;
    } catch {
        return 0;
    }
}

function normalizeAccountType(raw) {
    const t = String(raw || 'player').toLowerCase();
    if (t === 'admin') return 'Admin';
    if (t === 'csr') return 'CSR';
    if (t === 'benefactor') return 'Benefactor';
    return 'Player';
}

// GET /api/admin/players — all accounts + live online flag
router.get('/admin/players', auth.requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, username, email, race, account_type, horizon_coins,
                    created_at, last_login_at, state
             FROM players
             ORDER BY LOWER(username) ASC`
        );
        const onlineIds = getOnlinePlayerIdSet();
        const players = rows.map((row) => {
            const state = row.state && typeof row.state === 'object' ? row.state : {};
            return {
                id: row.id,
                username: row.username,
                email: row.email || '',
                race: row.race || 'Unknown',
                accountType: normalizeAccountType(row.account_type),
                horizonCoins: Number(row.horizon_coins) || 0,
                createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
                lastLogin: row.last_login_at ? new Date(row.last_login_at).getTime() : null,
                online: onlineIds.has(String(row.id)),
                planets: planetCountFromState(state),
            };
        });
        res.json({
            players,
            onlineCount: onlineIds.size,
            online: getOnlinePlayers(),
        });
    } catch (err) {
        console.error('[admin/players]', err);
        res.status(500).json({ error: 'Failed to load players.' });
    }
});

// GET /api/admin/stats — server overview for admin panel
router.get('/admin/stats', auth.requireAdmin, async (req, res) => {
    try {
        const { rows } = await db.query(
            `SELECT id, username, account_type, last_login_at, state
             FROM players`
        );
        const onlineIds = getOnlinePlayerIdSet();
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        let totalPlanets = 0;
        const typeCounts = { Player: 0, Admin: 0, CSR: 0, Benefactor: 0 };
        let active24h = 0;

        rows.forEach((row) => {
            const type = normalizeAccountType(row.account_type);
            typeCounts[type] = (typeCounts[type] || 0) + 1;
            const last = row.last_login_at ? new Date(row.last_login_at).getTime() : 0;
            if (last >= oneDayAgo) active24h += 1;
            totalPlanets += planetCountFromState(row.state);
        });

        res.json({
            totalPlayers: rows.length,
            onlineNow: onlineIds.size,
            active24h,
            totalPlanets,
            accountTypes: typeCounts,
            uptimeSeconds: Math.floor(process.uptime()),
        });
    } catch (err) {
        console.error('[admin/stats]', err);
        res.status(500).json({ error: 'Failed to load server stats.' });
    }
});

module.exports = router;
