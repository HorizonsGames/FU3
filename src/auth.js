const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateId() {
    return crypto.randomUUID();
}

async function createSession(playerId) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.query(
        'INSERT INTO sessions (token, player_id, expires_at) VALUES ($1, $2, $3)',
        [token, playerId, expiresAt]
    );
    return token;
}

async function getPlayerBySession(token) {
    if (!token) return null;
    const { rows } = await db.query(
        `SELECT p.* FROM sessions s
         JOIN players p ON p.id = s.player_id
         WHERE s.token = $1 AND s.expires_at > now()`,
        [token]
    );
    return rows[0] || null;
}

async function hashPassword(plain) {
    return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash);
}

// Express middleware: requires a valid `Authorization: Bearer <token>` header.
// Attaches the authenticated player row to req.player.
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const player = await getPlayerBySession(token);
    if (!player) {
        return res.status(401).json({ error: 'Not authenticated. Please log in again.' });
    }
    req.player = player;
    req.sessionToken = token;
    next();
}

// Same lookup, but for WebSocket connections (no Express req/res to hang it off).
async function authenticateSocketToken(token) {
    return getPlayerBySession(token);
}

module.exports = {
    createSession,
    getPlayerBySession,
    hashPassword,
    verifyPassword,
    requireAuth,
    authenticateSocketToken,
    generateId,
};
