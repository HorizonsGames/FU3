const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const eco = require('../economyLib');
const paypal = require('../paypalLib');

const router = express.Router();

function publicBaseUrl(req) {
    const fromEnv = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (fromEnv) return fromEnv;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    return `${proto}://${host}`;
}

function buildCheckoutUrl(req, intent, pack) {
    const business = paypal.expectedReceiverEmail();
    const base = publicBaseUrl(req);
    const notifyUrl = process.env.PAYPAL_NOTIFY_URL || (base ? `${base}/api/paypal/ipn` : '');
    const returnUrl = process.env.PAYPAL_RETURN_URL || (base ? `${base}/?paypal=success&intent=${intent.id}` : '');
    const cancelUrl = process.env.PAYPAL_CANCEL_URL || (base ? `${base}/?paypal=cancel` : '');

    const params = new URLSearchParams({
        cmd: '_xclick',
        business,
        currency_code: intent.currency || 'USD',
        amount: Number(pack.price).toFixed(2),
        item_name: `FU3 ${pack.name} (${pack.coins.toLocaleString()} Horizon Coins)`,
        item_number: `fu3_hc_${pack.id}`,
        no_shipping: '1',
        no_note: '0',
        cn: 'In-game username (auto-filled)',
        custom: `intent:${intent.id}|user:${intent.username}|pack:${pack.id}|hc:${pack.coins}`,
        on0: 'In-game username',
        os0: intent.username,
    });
    if (notifyUrl) params.set('notify_url', notifyUrl);
    if (returnUrl) params.set('return', returnUrl);
    if (cancelUrl) params.set('cancel_return', cancelUrl);

    const mode = String(process.env.PAYPAL_MODE || 'live').toLowerCase();
    const host = mode === 'sandbox' ? 'www.sandbox.paypal.com' : 'www.paypal.com';
    return `https://${host}/cgi-bin/webscr?${params.toString()}`;
}

async function grantHorizonCoins(client, playerId, coins, meta) {
    const { rows } = await client.query(
        'SELECT id, username, state, horizon_coins FROM players WHERE id = $1 FOR UPDATE',
        [playerId]
    );
    const row = rows[0];
    if (!row) return null;
    const state = eco.normalizeState(row);
    const add = Math.max(0, Math.floor(Number(coins) || 0));
    state.horizonCoins = eco.readHc(state.horizonCoins) + add;
    if (!state.purchaseLog) state.purchaseLog = [];
    state.purchaseLog.unshift({
        at: new Date().toISOString(),
        coins: add,
        ...meta,
    });
    state.purchaseLog = state.purchaseLog.slice(0, 50);
    await client.query(
        'UPDATE players SET state = $1, horizon_coins = $2 WHERE id = $3',
        [state, state.horizonCoins, playerId]
    );
    return state;
}

// GET /api/paypal/packs — public catalog
router.get('/paypal/packs', (_req, res) => {
    res.json({
        packs: paypal.listPacks(),
        currency: 'USD',
        businessEmail: paypal.expectedReceiverEmail(),
    });
});

// POST /api/paypal/intent { packId } — authenticated checkout start
router.post('/paypal/intent', auth.requireAuth, async (req, res) => {
    try {
        const pack = paypal.getPack(req.body?.packId);
        if (!pack) return res.status(400).json({ error: 'Unknown coin pack.' });

        const id = crypto.randomUUID();
        const amountCents = Math.round(pack.price * 100);
        await db.query(
            `INSERT INTO paypal_intents
                (id, player_id, username, pack_id, coins, amount_cents, currency, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'USD', 'pending')`,
            [id, req.player.id, req.player.username, pack.id, pack.coins, amountCents]
        );

        const intent = {
            id,
            username: req.player.username,
            packId: pack.id,
            coins: pack.coins,
            amountCents,
            currency: 'USD',
        };
        const checkoutUrl = buildCheckoutUrl(req, intent, pack);
        res.status(201).json({
            success: true,
            intentId: id,
            pack,
            checkoutUrl,
            coins: pack.coins,
            amount: pack.price,
        });
    } catch (err) {
        console.error('[paypal] intent', err);
        res.status(500).json({ error: 'Could not start PayPal checkout.' });
    }
});

// GET /api/paypal/intent/:id — buyer polls after return
router.get('/paypal/intent/:id', auth.requireAuth, async (req, res) => {
    const { rows } = await db.query(
        `SELECT id, pack_id, coins, amount_cents, currency, status, txn_id, paid_at, created_at
         FROM paypal_intents
         WHERE id = $1 AND player_id = $2`,
        [req.params.id, req.player.id]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Intent not found.' });
    const state = eco.normalizeState(req.player);
    res.json({
        intent: {
            id: row.id,
            packId: row.pack_id,
            coins: row.coins,
            amount: row.amount_cents / 100,
            currency: row.currency,
            status: row.status,
            txnId: row.txn_id,
            paidAt: row.paid_at,
            createdAt: row.created_at,
        },
        horizonCoins: state.horizonCoins,
        resources: state.resources,
        inventory: state.inventory,
    });
});

/**
 * PayPal IPN listener — must accept urlencoded bodies.
 * Grants Horizon Coins once payment_status=Completed and verification passes.
 */
router.post('/paypal/ipn', async (req, res) => {
    // Always ACK quickly after we accept the payload shape; PayPal retries on non-200.
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    try {
        const verified = await paypal.verifyIpn(payload);
        if (!verified.ok) {
            console.warn('[paypal] IPN not verified:', verified.body);
            return res.status(400).send('INVALID');
        }

        const paymentStatus = String(payload.payment_status || '');
        const txnId = String(payload.txn_id || '').trim();
        const receiver = String(payload.receiver_email || payload.receiver_id || '').trim().toLowerCase();
        const currency = String(payload.mc_currency || '').toUpperCase();
        const gross = Number(payload.mc_gross);
        const custom = paypal.parseCustom(payload.custom);
        const packId = custom.packId || paypal.packIdFromItemNumber(payload.item_number);
        const pack = paypal.getPack(packId);

        if (paymentStatus !== 'Completed') {
            // Pending/refunded etc. — acknowledge but do not grant.
            return res.status(200).send('OK');
        }
        if (!txnId) return res.status(400).send('MISSING_TXN');
        if (!pack) return res.status(400).send('UNKNOWN_PACK');
        if (currency && currency !== 'USD') return res.status(400).send('BAD_CURRENCY');
        if (!paypal.amountMatches(pack.price, gross)) {
            console.warn('[paypal] amount mismatch', { expected: pack.price, gross, txnId });
            return res.status(400).send('BAD_AMOUNT');
        }

        const expectedEmail = paypal.expectedReceiverEmail();
        if (receiver && expectedEmail && receiver !== expectedEmail) {
            // Some accounts send business email variants — allow if PAYPAL_ALLOW_ANY_RECEIVER=1
            if (String(process.env.PAYPAL_ALLOW_ANY_RECEIVER || '') !== '1') {
                console.warn('[paypal] receiver mismatch', { receiver, expectedEmail, txnId });
                return res.status(400).send('BAD_RECEIVER');
            }
        }

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');

            // Idempotent on txn_id
            const existingTxn = await client.query(
                'SELECT id, status FROM paypal_intents WHERE txn_id = $1',
                [txnId]
            );
            if (existingTxn.rows[0]?.status === 'paid') {
                await client.query('COMMIT');
                return res.status(200).send('OK');
            }

            let intentRow = null;
            if (custom.intentId) {
                const { rows } = await client.query(
                    'SELECT * FROM paypal_intents WHERE id = $1 FOR UPDATE',
                    [custom.intentId]
                );
                intentRow = rows[0] || null;
            }

            if (!intentRow && custom.username) {
                const { rows } = await client.query(
                    `SELECT i.* FROM paypal_intents i
                     JOIN players p ON p.id = i.player_id
                     WHERE lower(p.username) = lower($1)
                       AND i.pack_id = $2
                       AND i.status = 'pending'
                     ORDER BY i.created_at DESC
                     LIMIT 1
                     FOR UPDATE OF i`,
                    [custom.username, pack.id]
                );
                intentRow = rows[0] || null;
            }

            let playerId = intentRow?.player_id || null;
            if (!playerId && custom.username) {
                const { rows } = await client.query(
                    'SELECT id FROM players WHERE lower(username) = lower($1)',
                    [custom.username]
                );
                playerId = rows[0]?.id || null;
            }
            if (!playerId) {
                await client.query('ROLLBACK');
                console.warn('[paypal] no player for IPN', { txnId, custom });
                return res.status(404).send('PLAYER_NOT_FOUND');
            }

            if (intentRow && intentRow.status === 'paid') {
                await client.query('COMMIT');
                return res.status(200).send('OK');
            }

            if (intentRow) {
                if (intentRow.pack_id !== pack.id) {
                    await client.query('ROLLBACK');
                    return res.status(400).send('PACK_MISMATCH');
                }
                await client.query(
                    `UPDATE paypal_intents
                     SET status = 'paid', txn_id = $2, paid_at = now(), raw_ipn = $3
                     WHERE id = $1`,
                    [intentRow.id, txnId, payload]
                );
            } else {
                // Orphan completed payment — still credit, record a synthetic intent
                const id = crypto.randomUUID();
                const { rows: urows } = await client.query(
                    'SELECT username FROM players WHERE id = $1',
                    [playerId]
                );
                await client.query(
                    `INSERT INTO paypal_intents
                        (id, player_id, username, pack_id, coins, amount_cents, currency, status, txn_id, paid_at, raw_ipn)
                     VALUES ($1,$2,$3,$4,$5,$6,'USD','paid',$7,now(),$8)`,
                    [
                        id,
                        playerId,
                        urows[0]?.username || custom.username || 'unknown',
                        pack.id,
                        pack.coins,
                        Math.round(pack.price * 100),
                        txnId,
                        payload,
                    ]
                );
            }

            await grantHorizonCoins(client, playerId, pack.coins, {
                source: 'paypal',
                packId: pack.id,
                txnId,
                amount: pack.price,
            });

            await client.query('COMMIT');
            console.log('[paypal] granted', { playerId, coins: pack.coins, txnId, pack: pack.id });
            return res.status(200).send('OK');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('[paypal] IPN error', err);
        return res.status(500).send('ERROR');
    }
});

module.exports = router;
