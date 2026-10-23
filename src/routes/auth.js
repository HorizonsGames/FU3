const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { rateLimit } = require('../rateLimit');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

// Register: cap attempts per IP — mainly to stop automated mass account creation.
const registerLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10 }); // 10/hour/IP

// Login: two limiters stacked —
//  - per IP, generous (shared IPs/NAT shouldn't get punished for one bad actor)
//  - per attempted username, strict (this is the one that actually stops
//    password-guessing against a specific account, regardless of how many
//    IPs the attacker spreads the attempts across)
const loginIpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30 }); // 30/15min/IP
const loginUsernameLimiter = rateLimit({
    windowMs: 15 * 60_000, max: 8, // 8/15min/username
    keyFn: (req) => `login:${(req.body?.username || '').toLowerCase()}`,
});

router.post('/register', registerLimiter, async (req, res) => {
    try {
        const { username, email, password, race } = req.body || {};

        if (!username || !USERNAME_RE.test(username)) {
            return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, _ or -.' });
        }
        if (!password || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const { rows: existing } = await db.query(
            'SELECT id FROM players WHERE username = $1 OR (email IS NOT NULL AND email = $2)',
            [username, email || null]
        );
        if (existing.length) {
            return res.status(409).json({ error: 'That username or email is already taken.' });
        }

        const passwordHash = await auth.hashPassword(password);
        const newId = auth.generateId();
        const { rows } = await db.query(
            `INSERT INTO players (id, username, email, password_hash, race, last_login_at)
             VALUES ($1, $2, $3, $4, $5, now())
             RETURNING id, username, email, race, state, created_at`,
            [newId, username, email || null, passwordHash, race || null]
        );
        const player = rows[0];
        const token = await auth.createSession(player.id);

        res.status(201).json({ token, player: publicPlayer(player) });
    } catch (err) {
        console.error('[auth/register]', err);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

router.post('/login', loginIpLimiter, loginUsernameLimiter, async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const { rows } = await db.query('SELECT * FROM players WHERE username = $1', [username]);
        const player = rows[0];
        if (!player || !(await auth.verifyPassword(password, player.password_hash))) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        await db.query('UPDATE players SET last_login_at = now() WHERE id = $1', [player.id]);
        const token = await auth.createSession(player.id);

        res.json({ token, player: publicPlayer(player) });
    } catch (err) {
        console.error('[auth/login]', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

router.post('/logout', auth.requireAuth, async (req, res) => {
    await db.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
    res.json({ success: true });
});

router.get('/me', auth.requireAuth, (req, res) => {
    res.json({ player: publicPlayer(req.player) });
});

function publicPlayer(row) {
    return {
        id: row.id,
        username: row.username,
        email: row.email,
        race: row.race,
        accountType: row.account_type || 'player',
        state: row.state,
        createdAt: row.created_at,
    };
}

module.exports = router;
