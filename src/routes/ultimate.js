const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

// Default 10 days; smoke tests / ops can shorten with ULTIMATE_CRAFT_MS
const DEFAULT_CRAFT_MS = 10 * 24 * 60 * 60 * 1000;
const ANNOUNCE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DISABLE_THRESHOLD = 0.49; // lose >51% ⇒ at or below 49% of baseline

let broadcastGalaxy = () => {};

function setBroadcastGalaxy(fn) {
    broadcastGalaxy = typeof fn === 'function' ? fn : () => {};
}

function craftMs() {
    const envMs = Number(process.env.ULTIMATE_CRAFT_MS);
    if (Number.isFinite(envMs) && envMs > 0) return envMs;
    return DEFAULT_CRAFT_MS;
}

function rowToPublic(row) {
    if (!row) return null;
    const baselinePlanets = Number(row.baseline_planets) || 0;
    const baselineFleet = Number(row.baseline_fleet) || 0;
    const currentPlanets = Number(row.current_planets) || 0;
    const currentFleet = Number(row.current_fleet) || 0;
    return {
        id: row.id,
        playerId: row.player_id,
        username: row.username,
        empireName: row.empire_name,
        status: row.status,
        startedAt: row.started_at,
        completesAt: row.completes_at,
        baselinePlanets,
        baselineFleet,
        currentPlanets,
        currentFleet,
        planetPct: baselinePlanets > 0 ? currentPlanets / baselinePlanets : 1,
        fleetPct: baselineFleet > 0 ? currentFleet / baselineFleet : 1,
        lastAnnounceAt: row.last_announce_at,
    };
}

function announceMessage(row, kind) {
    const empire = row.empire_name || row.username;
    const eta = row.completes_at ? new Date(row.completes_at).toISOString() : '';
    if (kind === 'start') {
        return `${empire} (${row.username}) has begun forging the Ultimate Weapon — they intend to Destroy the Galaxy. ETA ${eta}`;
    }
    if (kind === 'progress') {
        return `${empire} (${row.username}) is still forging the Ultimate Weapon — they intend to Destroy the Galaxy. ETA ${eta}`;
    }
    if (kind === 'disabled') {
        return `${empire} (${row.username}) lost critical strength — the Ultimate Weapon has been DISABLED.`;
    }
    if (kind === 'armed') {
        return `${empire} (${row.username}) has ARMED the Ultimate Weapon. The galaxy hangs in the balance.`;
    }
    if (kind === 'fired') {
        return `${empire} (${row.username}) fired the Ultimate Weapon — the galaxy has been destroyed. Empires reset; accounts and Horizon Coins persist.`;
    }
    return `${empire} (${row.username}) Ultimate Weapon update.`;
}

function emitAnnounce(row, kind) {
    broadcastGalaxy({
        type: 'galaxy_announce',
        kind,
        message: announceMessage(row, kind),
        craft: rowToPublic(row),
    });
}

async function disableCraft(row, reason) {
    await db.query(
        `UPDATE ultimate_weapon_crafts
         SET status = 'disabled', disabled_at = now(), disable_reason = $2
         WHERE id = $1 AND status = 'crafting'`,
        [row.id, reason || 'losses']
    );
    const { rows } = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [row.id]);
    const updated = rows[0];
    if (updated) emitAnnounce(updated, 'disabled');
    return updated;
}

function shouldDisable(baselinePlanets, baselineFleet, currentPlanets, currentFleet) {
    const planetsOk = baselinePlanets <= 0 || currentPlanets / baselinePlanets > DISABLE_THRESHOLD;
    const fleetOk = baselineFleet <= 0 || currentFleet / baselineFleet > DISABLE_THRESHOLD;
    return !(planetsOk && fleetOk);
}

// POST /api/ultimate/start
router.post('/ultimate/start', auth.requireAuth, async (req, res) => {
    const empireName = String(req.body?.empireName || req.player.race || req.player.username || 'Unknown Empire').slice(0, 80);
    const baselinePlanets = Math.max(0, Math.floor(Number(req.body?.baselinePlanets) || 0));
    const baselineFleet = Math.max(0, Math.floor(Number(req.body?.baselineFleet) || 0));
    if (baselinePlanets < 1 && baselineFleet < 1) {
        return res.status(400).json({ error: 'Need at least one planet or fleet ship to start the Ultimate Weapon craft.' });
    }

    const active = await db.query(
        `SELECT id FROM ultimate_weapon_crafts
         WHERE player_id = $1 AND status IN ('crafting', 'armed')
         LIMIT 1`,
        [req.player.id]
    );
    if (active.rows.length) {
        return res.status(409).json({ error: 'You already have an active Ultimate Weapon craft.' });
    }

    const id = crypto.randomUUID();
    const duration = craftMs();
    const completesAt = new Date(Date.now() + duration);
    const { rows } = await db.query(
        `INSERT INTO ultimate_weapon_crafts (
            id, player_id, username, empire_name, status,
            started_at, completes_at, last_announce_at,
            baseline_planets, baseline_fleet, current_planets, current_fleet
         ) VALUES ($1,$2,$3,$4,'crafting', now(), $5, now(), $6,$7,$6,$7)
         RETURNING *`,
        [id, req.player.id, req.player.username, empireName, completesAt, baselinePlanets, baselineFleet]
    );
    const row = rows[0];
    emitAnnounce(row, 'start');
    res.json({ success: true, craft: rowToPublic(row), craftMs: duration });
});

// GET /api/ultimate/active
router.get('/ultimate/active', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query(
        `SELECT * FROM ultimate_weapon_crafts
         WHERE status IN ('crafting', 'armed')
         ORDER BY started_at ASC`
    );
    res.json({ crafts: rows.map(rowToPublic) });
});

// POST /api/ultimate/:id/report — crafter heartbeat
router.post('/ultimate/:id/report', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Craft not found' });
    if (row.player_id !== req.player.id) return res.status(403).json({ error: 'Not your craft' });
    if (row.status !== 'crafting') return res.json({ success: true, craft: rowToPublic(row) });

    const currentPlanets = Math.max(0, Math.floor(Number(req.body?.currentPlanets) || 0));
    const currentFleet = Math.max(0, Math.floor(Number(req.body?.currentFleet) || 0));

    await db.query(
        `UPDATE ultimate_weapon_crafts
         SET current_planets = $2, current_fleet = $3
         WHERE id = $1`,
        [row.id, currentPlanets, currentFleet]
    );

    if (shouldDisable(row.baseline_planets, row.baseline_fleet, currentPlanets, currentFleet)) {
        const disabled = await disableCraft(row, 'reported_losses');
        return res.json({ success: true, craft: rowToPublic(disabled), disabled: true });
    }

    const refreshed = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [row.id]);
    res.json({ success: true, craft: rowToPublic(refreshed.rows[0]), disabled: false });
});

// POST /api/ultimate/:id/assault — other players damage tracked strength
router.post('/ultimate/:id/assault', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Craft not found' });
    if (row.status !== 'crafting') return res.status(400).json({ error: 'Threat is not crafting' });
    if (row.player_id === req.player.id) return res.status(400).json({ error: 'Cannot assault your own Ultimate Weapon craft' });

    const fleetDamage = Math.max(0, Math.floor(Number(req.body?.fleetDamage) || 0));
    const planetDamage = Math.max(0, Math.floor(Number(req.body?.planetDamage) || 0));
    if (fleetDamage < 1 && planetDamage < 1) {
        return res.status(400).json({ error: 'Assault must deal fleet or planet damage' });
    }

    const currentFleet = Math.max(0, Number(row.current_fleet) - fleetDamage);
    const currentPlanets = Math.max(0, Number(row.current_planets) - planetDamage);

    await db.query(
        `UPDATE ultimate_weapon_crafts
         SET current_fleet = $2, current_planets = $3
         WHERE id = $1`,
        [row.id, currentFleet, currentPlanets]
    );

    if (shouldDisable(row.baseline_planets, row.baseline_fleet, currentPlanets, currentFleet)) {
        const disabled = await disableCraft({ ...row, current_fleet: currentFleet, current_planets: currentPlanets }, 'assault');
        return res.json({ success: true, craft: rowToPublic(disabled), disabled: true });
    }

    const refreshed = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [row.id]);
    res.json({ success: true, craft: rowToPublic(refreshed.rows[0]), disabled: false });
});

// POST /api/ultimate/:id/complete
router.post('/ultimate/:id/complete', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Craft not found' });
    if (row.player_id !== req.player.id) return res.status(403).json({ error: 'Not your craft' });
    if (row.status !== 'crafting') return res.status(400).json({ error: `Craft is ${row.status}` });
    if (new Date(row.completes_at).getTime() > Date.now()) {
        return res.status(400).json({ error: 'Craft is not finished yet' });
    }

    await db.query(
        `UPDATE ultimate_weapon_crafts SET status = 'armed', armed_at = now() WHERE id = $1`,
        [row.id]
    );
    const refreshed = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [row.id]);
    emitAnnounce(refreshed.rows[0], 'armed');
    res.json({ success: true, craft: rowToPublic(refreshed.rows[0]) });
});

// POST /api/ultimate/:id/fire — wipe all empires, keep accounts + horizon_coins
router.post('/ultimate/:id/fire', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Craft not found' });
    if (row.player_id !== req.player.id) return res.status(403).json({ error: 'Not your craft' });
    if (row.status !== 'armed') return res.status(400).json({ error: 'Ultimate Weapon is not armed' });

    // Preserve HC from column when set; otherwise pull from state blob before wipe
    const players = await db.query('SELECT id, state, horizon_coins FROM players');
    for (const p of players.rows) {
        let hc = Number(p.horizon_coins);
        if (!Number.isFinite(hc)) hc = 500;
        const st = p.state || {};
        if (st.horizonCoins != null && Number.isFinite(Number(st.horizonCoins))) {
            // Prefer the higher of column vs blob so we never under-preserve
            hc = Math.max(hc, Number(st.horizonCoins));
        }
        await db.query(
            `UPDATE players SET state = '{}'::jsonb, horizon_coins = $2 WHERE id = $1`,
            [p.id, Math.max(0, Math.floor(hc))]
        );
    }

    await db.query(
        `UPDATE ultimate_weapon_crafts SET status = 'fired', fired_at = now() WHERE id = $1`,
        [row.id]
    );
    // Cancel any other in-progress crafts
    await db.query(
        `UPDATE ultimate_weapon_crafts SET status = 'disabled', disabled_at = now(), disable_reason = 'galaxy_wiped'
         WHERE status IN ('crafting', 'armed') AND id <> $1`,
        [row.id]
    );

    const refreshed = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [row.id]);
    emitAnnounce(refreshed.rows[0], 'fired');
    broadcastGalaxy({
        type: 'galaxy_wipe',
        message: announceMessage(refreshed.rows[0], 'fired'),
        craft: rowToPublic(refreshed.rows[0]),
        firedBy: req.player.username,
    });

    const me = await db.query('SELECT horizon_coins FROM players WHERE id = $1', [req.player.id]);
    res.json({
        success: true,
        craft: rowToPublic(refreshed.rows[0]),
        horizonCoins: Number(me.rows[0]?.horizon_coins) || 0,
    });
});

async function runAnnounceTick() {
    try {
        const { rows } = await db.query(
            `SELECT * FROM ultimate_weapon_crafts WHERE status = 'crafting'`
        );
        const now = Date.now();
        for (const row of rows) {
            const last = new Date(row.last_announce_at || row.started_at).getTime();
            if (now - last >= ANNOUNCE_INTERVAL_MS) {
                await db.query(
                    `UPDATE ultimate_weapon_crafts SET last_announce_at = now() WHERE id = $1`,
                    [row.id]
                );
                const refreshed = await db.query('SELECT * FROM ultimate_weapon_crafts WHERE id = $1', [row.id]);
                emitAnnounce(refreshed.rows[0], 'progress');
            }
        }
    } catch (e) {
        console.error('[ultimate] announce tick failed', e.message);
    }
}

function startUltimateAnnouncer() {
    // Every 5 minutes check whether a 2h broadcast is due
    const handle = setInterval(runAnnounceTick, 5 * 60 * 1000);
    if (handle.unref) handle.unref();
    return handle;
}

module.exports = {
    router,
    setBroadcastGalaxy,
    startUltimateAnnouncer,
    craftMs,
    DISABLE_THRESHOLD,
};
