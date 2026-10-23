const { WebSocketServer } = require('ws');
const url = require('url');
const auth = require('../auth');
const { handleMessage, handleClose } = require('./battleRoom');

// ── In-memory room registry ──────────────────────────────────────────────
// Lives on this single Node process. Fine for one Heroku dyno. If you ever
// scale to more than one web dyno, connections on different dynos won't see
// each other's broadcasts — you'd need a shared pub/sub (Heroku Redis +
// the `ws` server subscribing/publishing room events) to fix that. Flagging
// this now so it doesn't surprise you later: this is the #1 thing to revisit
// before scaling dynos horizontally.
const rooms = new Map(); // roomId -> Set<connection>

function createHub(server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req, socket, head) => {
        const { pathname, query } = url.parse(req.url, true);
        if (pathname !== '/ws') {
            socket.destroy();
            return;
        }

        const player = await auth.authenticateSocketToken(query.token);
        if (!player) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.playerId = player.id;
            ws.username = player.username;
            ws.currentRoom = null;
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (raw) => {
            let msg;
            try {
                msg = JSON.parse(raw.toString());
            } catch {
                return send(ws, { type: 'error', message: 'Malformed message (not valid JSON).' });
            }
            handleMessage(ws, msg, { rooms, joinRoom, leaveRoom, broadcastToRoom, send });
        });

        ws.on('close', () => {
            handleClose(ws, { rooms, leaveRoom });
        });
    });

    // Drop dead connections (e.g. laptop closed lid without a clean close frame)
    // so they don't linger in a room forever.
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
    wss.on('close', () => clearInterval(heartbeat));

    return wss;
}

function joinRoom(ws, roomId) {
    if (ws.currentRoom) leaveRoom(ws, ws.currentRoom);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(ws);
    ws.currentRoom = roomId;
}

function leaveRoom(ws, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.delete(ws);
    if (room.size === 0) rooms.delete(roomId);
    if (ws.currentRoom === roomId) ws.currentRoom = null;
}

function broadcastToRoom(roomId, message, { excludeWs } = {}) {
    const room = rooms.get(roomId);
    if (!room) return;
    const payload = JSON.stringify(message);
    for (const client of room) {
        if (client === excludeWs) continue;
        if (client.readyState === client.OPEN) client.send(payload);
    }
}

function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

module.exports = { createHub, rooms };
