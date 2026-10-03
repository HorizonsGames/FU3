require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');

const db = require('./src/db');
const authRoutes = require('./src/routes/auth');
const stateRoutes = require('./src/routes/state');
const guildRoutes = require('./src/routes/guild');
const bossRoutes = require('./src/routes/boss');
const { createHub } = require('./src/ws/hub');

const app = express();
const PORT = process.env.PORT || 3000;

// Heroku's router sits in front of this app — without this, req.ip resolves to
// the router's internal address for every request, which would make the login/
// register rate limiters (keyed by IP) treat all traffic as one client.
app.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : true, // allow all if unset (dev convenience — set this in production)
    credentials: true,
}));
app.use(express.json({ limit: '3mb' }));

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/auth', authRoutes);
app.use('/api', stateRoutes);
app.use('/api', guildRoutes);
app.use('/api', bossRoutes);

// Serve the game client (index.html, assets/, ship art, music, etc.) from this
// same app/process/port — one Heroku deploy serves both the game and the API,
// so the client never needs a separate backend URL configured: it just talks
// to its own origin (see MP_CONFIG in index.html). Mounted after the /api
// routes so an API path is never shadowed by a same-named static file.
app.use(express.static(path.join(__dirname), { maxAge: '1d' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'Internal server error.' });
});

const server = http.createServer(app);
createHub(server); // attaches the WebSocket server at /ws on this same HTTP server/port

async function start() {
    await db.initSchema();
    server.listen(PORT, () => {
        console.log(`[server] Fractured Universe backend listening on :${PORT}`);
        console.log(`[server] REST API at /api, WebSocket at /ws`);
    });
}

start().catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
});
