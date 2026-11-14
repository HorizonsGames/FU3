/**
 * Horizon Coin pack catalog + PayPal IPN helpers.
 * Amounts must stay in sync with window.FU_PAYPAL_CONFIG / Game.getHorizonCoinStoreConfig().
 */

const PACKS = Object.freeze({
    small: { id: 'small', name: 'Small Pack', coins: 100, price: 3.99 },
    medium: { id: 'medium', name: 'Medium Pack', coins: 300, price: 5.99 },
    large: { id: 'large', name: 'Large Pack', coins: 500, price: 8.99 },
    mega: { id: 'mega', name: 'Mega Pack', coins: 1000, price: 14.99 },
    super: { id: 'super', name: 'Super Mega Pack', coins: 1500, price: 19.99 },
});

function getPack(packId) {
    const id = String(packId || '').trim().toLowerCase();
    return PACKS[id] || null;
}

function listPacks() {
    return Object.values(PACKS);
}

function amountMatches(expected, received) {
    const a = Math.round(Number(expected) * 100);
    const b = Math.round(Number(received) * 100);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function parseCustom(custom) {
    const out = { intentId: null, username: null, packId: null, coins: null };
    const raw = String(custom || '').trim();
    if (!raw) return out;
    // intent:<uuid> or user:name|pack:small|hc:100
    for (const part of raw.split('|')) {
        const idx = part.indexOf(':');
        if (idx < 0) continue;
        const key = part.slice(0, idx).trim().toLowerCase();
        const val = part.slice(idx + 1).trim();
        if (key === 'intent') out.intentId = val;
        else if (key === 'user') out.username = val;
        else if (key === 'pack') out.packId = val;
        else if (key === 'hc') out.coins = Math.floor(Number(val) || 0);
    }
    // bare uuid in custom
    if (!out.intentId && /^[0-9a-f-]{36}$/i.test(raw)) out.intentId = raw;
    return out;
}

function packIdFromItemNumber(itemNumber) {
    const m = String(itemNumber || '').match(/^fu3_hc_([a-z0-9_]+)$/i);
    return m ? m[1].toLowerCase() : null;
}

function ipnVerifyUrl() {
    const mode = String(process.env.PAYPAL_MODE || 'live').toLowerCase();
    if (mode === 'sandbox') return 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr';
    return 'https://ipnpb.paypal.com/cgi-bin/webscr';
}

function expectedReceiverEmail() {
    return String(
        process.env.PAYPAL_BUSINESS_EMAIL
        || (typeof process.env.FU_PAYPAL_BUSINESS_EMAIL !== 'undefined' ? process.env.FU_PAYPAL_BUSINESS_EMAIL : '')
        || 'admin@horizonsgames.com'
    ).trim().toLowerCase();
}

/**
 * Verify an IPN payload with PayPal (or skip when PAYPAL_IPN_VERIFY=skip for smoke tests).
 */
async function verifyIpn(payload) {
    if (String(process.env.PAYPAL_IPN_VERIFY || '').toLowerCase() === 'skip') {
        return { ok: true, skipped: true };
    }
    const params = new URLSearchParams();
    params.set('cmd', '_notify-validate');
    for (const [k, v] of Object.entries(payload || {})) {
        if (v == null) continue;
        params.append(k, String(v));
    }
    const res = await fetch(ipnVerifyUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'FU3-PayPal-IPN/1.0',
        },
        body: params.toString(),
    });
    const text = (await res.text()).trim();
    if (text === 'VERIFIED') return { ok: true, skipped: false };
    return { ok: false, body: text };
}

module.exports = {
    PACKS,
    getPack,
    listPacks,
    amountMatches,
    parseCustom,
    packIdFromItemNumber,
    ipnVerifyUrl,
    expectedReceiverEmail,
    verifyIpn,
};
