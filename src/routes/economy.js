const express = require('express');
const db = require('../db');
const auth = require('../auth');
const eco = require('../economyLib');

const router = express.Router();

async function loadPlayer(client, id) {
    const { rows } = await client.query(
        'SELECT id, username, race, account_type, state, horizon_coins FROM players WHERE id = $1',
        [id]
    );
    return rows[0] || null;
}

async function savePlayer(client, playerId, state, horizonCoins) {
    const hc = eco.readHc(horizonCoins, state.horizonCoins);
    const next = { ...state, horizonCoins: hc, resources: eco.normalizeResources(state.resources), inventory: eco.normalizeInventory(state.inventory) };
    await client.query(
        'UPDATE players SET state = $1, horizon_coins = $2 WHERE id = $3',
        [next, hc, playerId]
    );
    return next;
}

function isAdmin(player) {
    return String(player.account_type || '').toLowerCase() === 'admin';
}

// POST /api/economy/collect — apply time-based production from server-stored planets
router.post('/economy/collect', auth.requireAuth, async (req, res) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const player = await loadPlayer(client, req.player.id);
        if (!player) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const state = eco.normalizeState(player);
        if (!state.selectedRace && player.race) {
            state.selectedRace = { name: player.race };
        }
        if (!state.playerData) state.playerData = { username: player.username };

        const now = Date.now();
        const last = Number(state.economyCollectedAt) || now;
        const elapsed = Math.max(0, now - last);
        const delta = eco.computeCollectDelta(state, elapsed);
        eco.applyDelta(state.resources, delta);
        state.economyCollectedAt = now;

        const saved = await savePlayer(client, player.id, state, state.horizonCoins);
        await client.query('COMMIT');
        res.json({
            success: true,
            collectedSeconds: delta.seconds,
            delta,
            ...eco.economySnapshot(saved),
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[economy] collect', err);
        res.status(500).json({ error: 'Collect failed.' });
    } finally {
        client.release();
    }
});

// POST /api/economy/spend — deduct resources / HC / inventory only
// body: { resources?: {}, horizonCoins?: number, inventoryRemove?: [{id|artifactId, quantity?}] }
router.post('/economy/spend', auth.requireAuth, async (req, res) => {
    const costs = req.body?.resources || {};
    const hcCost = Math.max(0, Math.floor(Number(req.body?.horizonCoins) || 0));
    const inventoryRemove = Array.isArray(req.body?.inventoryRemove) ? req.body.inventoryRemove : [];

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const player = await loadPlayer(client, req.player.id);
        if (!player) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const state = eco.normalizeState(player);
        if (!eco.canAfford(state.resources, costs, state.horizonCoins, hcCost)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient funds.' });
        }
        // Verify inventory removals exist
        for (const rem of inventoryRemove) {
            if (rem.id) {
                if (!state.inventory.some((i) => String(i.id) === String(rem.id))) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Inventory item missing.' });
                }
            } else if (rem.artifactId) {
                const need = Math.max(1, Math.floor(Number(rem.quantity) || 1));
                const have = state.inventory
                    .filter((i) => i.artifactId === rem.artifactId)
                    .reduce((s, i) => s + Math.max(1, i.quantity || 1), 0);
                if (have < need) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Insufficient inventory.' });
                }
            }
        }

        state.horizonCoins = eco.applySpend(state.resources, costs, state.horizonCoins, hcCost);
        eco.removeInventoryItems(state.inventory, inventoryRemove);

        const saved = await savePlayer(client, player.id, state, state.horizonCoins);
        await client.query('COMMIT');
        res.json({ success: true, ...eco.economySnapshot(saved) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[economy] spend', err);
        res.status(500).json({ error: 'Spend failed.' });
    } finally {
        client.release();
    }
});

// POST /api/economy/grant — capped gains by reason
// body: { reason, resources?, horizonCoins?, inventoryAdd?: [] }
router.post('/economy/grant', auth.requireAuth, async (req, res) => {
    const reason = String(req.body?.reason || '');
    const clamped = eco.clampGrant(
        reason,
        { resources: req.body?.resources, horizonCoins: req.body?.horizonCoins },
        req.body?.inventoryAdd,
        isAdmin(req.player)
    );
    if (clamped.error) return res.status(400).json({ error: clamped.error });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const player = await loadPlayer(client, req.player.id);
        if (!player) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const state = eco.normalizeState(player);
        eco.applyDelta(state.resources, clamped.resources);
        state.horizonCoins += clamped.horizonCoins;
        for (const item of clamped.inventoryAdd) {
            eco.addInventoryItem(state.inventory, item);
        }
        // Soft rate-limit stamp (client spam still capped per-call)
        state._lastGrantAt = Date.now();
        state._lastGrantReason = reason;

        const saved = await savePlayer(client, player.id, state, state.horizonCoins);
        await client.query('COMMIT');
        res.json({ success: true, ...eco.economySnapshot(saved) });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[economy] grant', err);
        res.status(500).json({ error: 'Grant failed.' });
    } finally {
        client.release();
    }
});

// GET /api/economy — current authoritative wallet
router.get('/economy', auth.requireAuth, async (req, res) => {
    const state = eco.normalizeState(req.player);
    res.json({ success: true, ...eco.economySnapshot(state) });
});

module.exports = router;
