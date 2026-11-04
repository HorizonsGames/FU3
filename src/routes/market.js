const express = require('express');
const db = require('../db');
const auth = require('../auth');

const router = express.Router();

const MARKET_KEY = 'fractured_market';
const RESOURCE_TYPES = new Set(['metal', 'he3', 'food']);
const MAX_LISTINGS = 500;

function readHc(value, fallback = 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    const fb = Number(fallback);
    return Number.isFinite(fb) ? Math.max(0, Math.floor(fb)) : 0;
}

function normalizeState(row) {
    const state = (row.state && typeof row.state === 'object') ? { ...row.state } : {};
    if (!state.resources || typeof state.resources !== 'object') state.resources = {};
    const r = state.resources;
    for (const k of ['metal', 'he3', 'food', 'credits']) {
        r[k] = Math.max(0, Math.floor(Number(r[k]) || 0));
    }
    if (!Array.isArray(state.inventory)) state.inventory = [];
    state.horizonCoins = readHc(row.horizon_coins, state.horizonCoins);
    return state;
}

async function loadMarket(client) {
    const { rows } = await client.query('SELECT value FROM world_kv WHERE key = $1', [MARKET_KEY]);
    if (!rows.length) return { listings: [], nextListingId: 1 };
    const value = rows[0].value || {};
    return {
        listings: Array.isArray(value.listings) ? value.listings : [],
        nextListingId: Math.max(1, Math.floor(Number(value.nextListingId) || 1)),
    };
}

async function saveMarket(client, market, playerId) {
    await client.query(
        `INSERT INTO world_kv (key, value, updated_at, updated_by)
         VALUES ($1, $2, now(), $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by`,
        [MARKET_KEY, market, playerId]
    );
}

async function loadPlayer(client, id) {
    const { rows } = await client.query(
        'SELECT id, username, state, horizon_coins FROM players WHERE id = $1',
        [id]
    );
    return rows[0] || null;
}

async function loadPlayerByUsername(client, username) {
    const { rows } = await client.query(
        'SELECT id, username, state, horizon_coins FROM players WHERE username = $1',
        [username]
    );
    return rows[0] || null;
}

async function savePlayer(client, playerId, state, horizonCoins) {
    const hc = readHc(horizonCoins, state.horizonCoins);
    const next = { ...state, horizonCoins: hc };
    await client.query(
        'UPDATE players SET state = $1, horizon_coins = $2 WHERE id = $3',
        [next, hc, playerId]
    );
    return next;
}

function publicListing(l) {
    if (!l) return null;
    return {
        id: l.id,
        seller: l.seller,
        sellerId: l.sellerId,
        listingType: l.listingType || 'resource',
        resourceType: l.resourceType,
        quantity: l.quantity,
        pricePerUnit: l.pricePerUnit,
        totalPrice: l.totalPrice,
        artifactId: l.artifactId,
        artifactName: l.artifactName,
        artifactIcon: l.artifactIcon,
        price: l.price,
        currency: l.currency,
        createdAt: l.createdAt,
        status: l.status,
        buyer: l.buyer,
        soldAt: l.soldAt,
        cancelledAt: l.cancelledAt,
    };
}

// GET /api/market — active (+ optional own) listings
router.get('/market', auth.requireAuth, async (req, res) => {
    const market = await loadMarket(db);
    const active = market.listings.filter((l) => l.status === 'active').map(publicListing);
    const mine = market.listings
        .filter((l) => l.sellerId === req.player.id || l.seller === req.player.username)
        .map(publicListing);
    res.json({ listings: active, myListings: mine, nextListingId: market.nextListingId });
});

// POST /api/market/list-resource  { resourceType, quantity, pricePerUnit }
router.post('/market/list-resource', auth.requireAuth, async (req, res) => {
    const resourceType = String(req.body?.resourceType || '');
    const quantity = Math.floor(Number(req.body?.quantity) || 0);
    const pricePerUnit = Math.floor(Number(req.body?.pricePerUnit) || 0);
    if (!RESOURCE_TYPES.has(resourceType)) {
        return res.status(400).json({ error: 'resourceType must be metal, he3, or food.' });
    }
    if (quantity < 1 || quantity > 1e9 || pricePerUnit < 1 || pricePerUnit > 1e9) {
        return res.status(400).json({ error: 'Invalid quantity or price.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const seller = await loadPlayer(client, req.player.id);
        if (!seller) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const state = normalizeState(seller);
        if ((state.resources[resourceType] || 0) < quantity) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Insufficient resources.' });
        }
        state.resources[resourceType] -= quantity;

        const market = await loadMarket(client);
        if (market.listings.filter((l) => l.status === 'active').length >= MAX_LISTINGS) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Market is full.' });
        }
        const listing = {
            id: market.nextListingId++,
            seller: seller.username,
            sellerId: seller.id,
            listingType: 'resource',
            resourceType,
            quantity,
            pricePerUnit,
            totalPrice: quantity * pricePerUnit,
            createdAt: new Date().toISOString(),
            status: 'active',
        };
        market.listings.push(listing);
        // prune old closed listings
        if (market.listings.length > MAX_LISTINGS * 2) {
            market.listings = market.listings.filter((l) => l.status === 'active').concat(
                market.listings.filter((l) => l.status !== 'active').slice(-200)
            );
        }

        const saved = await savePlayer(client, seller.id, state, state.horizonCoins);
        await saveMarket(client, market, seller.id);
        await client.query('COMMIT');
        res.json({
            success: true,
            listing: publicListing(listing),
            state: { resources: saved.resources, horizonCoins: saved.horizonCoins, inventory: saved.inventory },
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[market] list-resource', err);
        res.status(500).json({ error: 'Market listing failed.' });
    } finally {
        client.release();
    }
});

// POST /api/market/list-artifact  { artifactId, artifactName, artifactIcon, price, inventoryItemId, currency }
router.post('/market/list-artifact', auth.requireAuth, async (req, res) => {
    const artifactId = String(req.body?.artifactId || '');
    const artifactName = String(req.body?.artifactName || artifactId).slice(0, 80);
    const artifactIcon = String(req.body?.artifactIcon || '📦').slice(0, 8);
    const inventoryItemId = req.body?.inventoryItemId != null ? String(req.body.inventoryItemId) : null;
    const price = Math.floor(Number(req.body?.price) || 0);
    const currency = req.body?.currency === 'horizonCoins' ? 'horizonCoins' : 'credits';
    if (!artifactId || price < 1 || price > 1e12) {
        return res.status(400).json({ error: 'Invalid artifact listing.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const seller = await loadPlayer(client, req.player.id);
        if (!seller) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const state = normalizeState(seller);
        let removed = null;
        const inv = state.inventory;
        let idx = -1;
        if (inventoryItemId) {
            idx = inv.findIndex((i) => String(i.id) === inventoryItemId || String(i.inventoryItemId) === inventoryItemId);
        }
        if (idx < 0) {
            idx = inv.findIndex((i) => i && i.artifactId === artifactId);
        }
        if (idx < 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Artifact not in inventory.' });
        }
        removed = inv[idx];
        const qty = Math.max(1, Math.floor(Number(removed.quantity) || 1));
        if (qty > 1) {
            inv[idx] = { ...removed, quantity: qty - 1 };
        } else {
            inv.splice(idx, 1);
        }

        const market = await loadMarket(client);
        const listing = {
            id: market.nextListingId++,
            seller: seller.username,
            sellerId: seller.id,
            listingType: 'artifact',
            artifactId,
            artifactName,
            artifactIcon,
            inventoryItemId: inventoryItemId || (removed && removed.id) || null,
            price,
            currency,
            createdAt: new Date().toISOString(),
            status: 'active',
        };
        market.listings.push(listing);

        const saved = await savePlayer(client, seller.id, state, state.horizonCoins);
        await saveMarket(client, market, seller.id);
        await client.query('COMMIT');
        res.json({
            success: true,
            listing: publicListing(listing),
            state: { resources: saved.resources, horizonCoins: saved.horizonCoins, inventory: saved.inventory },
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[market] list-artifact', err);
        res.status(500).json({ error: 'Artifact listing failed.' });
    } finally {
        client.release();
    }
});

// POST /api/market/buy  { listingId }
router.post('/market/buy', auth.requireAuth, async (req, res) => {
    const listingId = Math.floor(Number(req.body?.listingId) || 0);
    if (!listingId) return res.status(400).json({ error: 'listingId required.' });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const buyer = await loadPlayer(client, req.player.id);
        if (!buyer) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const market = await loadMarket(client);
        const listing = market.listings.find((l) => Number(l.id) === listingId);
        if (!listing || listing.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Listing not available.' });
        }
        if (listing.sellerId === buyer.id || listing.seller === buyer.username) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Cannot buy your own listing.' });
        }

        const seller = listing.sellerId
            ? await loadPlayer(client, listing.sellerId)
            : await loadPlayerByUsername(client, listing.seller);
        if (!seller) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Seller account missing.' });
        }

        const buyerState = normalizeState(buyer);
        const sellerState = normalizeState(seller);
        const isArtifact = listing.listingType === 'artifact';

        if (isArtifact) {
            const price = Math.floor(Number(listing.price) || 0);
            const currency = listing.currency === 'horizonCoins' ? 'horizonCoins' : 'credits';
            if (currency === 'horizonCoins') {
                if (buyerState.horizonCoins < price) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Insufficient Horizon Coins.' });
                }
                buyerState.horizonCoins -= price;
                sellerState.horizonCoins += price;
            } else {
                if ((buyerState.resources.credits || 0) < price) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Insufficient credits.' });
                }
                buyerState.resources.credits -= price;
                sellerState.resources.credits = (sellerState.resources.credits || 0) + price;
            }
            buyerState.inventory.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                artifactId: listing.artifactId,
                foundAt: new Date().toISOString(),
                source: 'market',
                planetName: 'Player Market',
                quantity: 1,
            });
        } else {
            const total = Math.floor(Number(listing.totalPrice) || 0);
            const qty = Math.floor(Number(listing.quantity) || 0);
            const rt = listing.resourceType;
            if (!RESOURCE_TYPES.has(rt) || qty < 1 || total < 1) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Corrupt listing.' });
            }
            if ((buyerState.resources.credits || 0) < total) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'Insufficient credits.' });
            }
            buyerState.resources.credits -= total;
            buyerState.resources[rt] = (buyerState.resources[rt] || 0) + qty;
            sellerState.resources.credits = (sellerState.resources.credits || 0) + total;
        }

        listing.status = 'sold';
        listing.buyer = buyer.username;
        listing.buyerId = buyer.id;
        listing.soldAt = new Date().toISOString();

        const savedBuyer = await savePlayer(client, buyer.id, buyerState, buyerState.horizonCoins);
        await savePlayer(client, seller.id, sellerState, sellerState.horizonCoins);
        await saveMarket(client, market, buyer.id);
        await client.query('COMMIT');

        res.json({
            success: true,
            listing: publicListing(listing),
            state: {
                resources: savedBuyer.resources,
                horizonCoins: savedBuyer.horizonCoins,
                inventory: savedBuyer.inventory,
            },
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[market] buy', err);
        res.status(500).json({ error: 'Purchase failed.' });
    } finally {
        client.release();
    }
});

// POST /api/market/cancel  { listingId }
router.post('/market/cancel', auth.requireAuth, async (req, res) => {
    const listingId = Math.floor(Number(req.body?.listingId) || 0);
    if (!listingId) return res.status(400).json({ error: 'listingId required.' });

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const seller = await loadPlayer(client, req.player.id);
        if (!seller) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Player not found.' });
        }
        const market = await loadMarket(client);
        const listing = market.listings.find((l) => Number(l.id) === listingId);
        if (!listing) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Listing not found.' });
        }
        if (listing.sellerId !== seller.id && listing.seller !== seller.username) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Not your listing.' });
        }
        if (listing.status !== 'active') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Listing already closed.' });
        }

        const state = normalizeState(seller);
        if (listing.listingType === 'artifact') {
            state.inventory.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                artifactId: listing.artifactId,
                foundAt: new Date().toISOString(),
                source: 'marketReturn',
                planetName: 'Market Return',
                quantity: 1,
            });
        } else if (RESOURCE_TYPES.has(listing.resourceType)) {
            const rt = listing.resourceType;
            state.resources[rt] = (state.resources[rt] || 0) + Math.floor(Number(listing.quantity) || 0);
        }

        listing.status = 'cancelled';
        listing.cancelledAt = new Date().toISOString();

        const saved = await savePlayer(client, seller.id, state, state.horizonCoins);
        await saveMarket(client, market, seller.id);
        await client.query('COMMIT');

        res.json({
            success: true,
            listing: publicListing(listing),
            state: { resources: saved.resources, horizonCoins: saved.horizonCoins, inventory: saved.inventory },
        });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[market] cancel', err);
        res.status(500).json({ error: 'Cancel failed.' });
    } finally {
        client.release();
    }
});

module.exports = router;
