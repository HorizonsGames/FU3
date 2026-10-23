// ── Battle room message protocol ─────────────────────────────────────────
// This server does NOT resolve combat — it's a relay. Each client still
// computes its own ship movement/damage locally (same as the current
// single-player animateBattle()) and broadcasts state to the room; every
// other client in the room renders what it receives. That's enough to make
// battles genuinely "live" (everyone sees the same fight as it happens),
// but it is NOT cheat-proof — a modified client could broadcast fake
// results. Moving combat resolution itself onto the server (so the server
// is the source of truth and clients only render) is the natural next step
// once this relay layer is working end-to-end; flagging it here rather than
// quietly shipping something that looks authoritative but isn't.
//
// Room ID conventions (client picks these when it sends 'join_room'):
//   pvp:<matchId>        — a 1v1 (or N-spectator) live PvP battle
//   boss:<bossInstanceId> — a world/guild boss fight; every contributing
//                           player joins the same room, so this is also
//                           the mechanism for the "boss at center, everyone
//                           around it" live view — the server just needs to
//                           relay each player's ship-state, and the client
//                           lays out anyone in `members` in a ring around
//                           the boss sprite at the center of the canvas.
//
// Message types (client -> server):
//   { type: 'join_room',  roomId, roomType }
//   { type: 'leave_room', roomId }
//   { type: 'ship_state', roomId, payload }   // ship positions/hp for this player's fleet, this tick
//   { type: 'battle_event', roomId, payload } // discrete events: ship destroyed, projectile fired, victory/defeat
//   { type: 'chat', roomId, payload }         // { text }
//
// Message types (server -> client):
//   { type: 'room_joined', roomId, members: [{playerId, username}] }
//   { type: 'member_joined', roomId, playerId, username }
//   { type: 'member_left',   roomId, playerId }
//   { type: 'ship_state',    roomId, playerId, payload }
//   { type: 'battle_event',  roomId, playerId, payload }
//   { type: 'chat',          roomId, playerId, username, payload }
//   { type: 'error', message }

function handleMessage(ws, msg, ctx) {
    const { rooms, joinRoom, leaveRoom, broadcastToRoom, send } = ctx;

    switch (msg.type) {
        case 'join_room': {
            if (!msg.roomId) return send(ws, { type: 'error', message: 'join_room requires a roomId.' });
            joinRoom(ws, msg.roomId);
            const room = rooms.get(msg.roomId) || new Set();
            const members = [...room].map((c) => ({ playerId: c.playerId, username: c.username }));
            send(ws, { type: 'room_joined', roomId: msg.roomId, members });
            broadcastToRoom(msg.roomId, {
                type: 'member_joined', roomId: msg.roomId, playerId: ws.playerId, username: ws.username,
            }, { excludeWs: ws });
            break;
        }

        case 'leave_room': {
            if (!msg.roomId) return;
            leaveRoom(ws, msg.roomId);
            broadcastToRoom(msg.roomId, { type: 'member_left', roomId: msg.roomId, playerId: ws.playerId });
            break;
        }

        case 'ship_state':
        case 'battle_event':
        case 'chat': {
            if (!msg.roomId || ws.currentRoom !== msg.roomId) {
                return send(ws, { type: 'error', message: 'You must join_room before sending updates to it.' });
            }
            broadcastToRoom(msg.roomId, {
                type: msg.type,
                roomId: msg.roomId,
                playerId: ws.playerId,
                username: ws.username,
                payload: msg.payload,
            }, { excludeWs: ws });
            break;
        }

        default:
            send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

function handleClose(ws, { rooms, leaveRoom }) {
    if (ws.currentRoom) {
        const roomId = ws.currentRoom;
        leaveRoom(ws, roomId);
        const room = rooms.get(roomId);
        if (room) {
            const payload = JSON.stringify({ type: 'member_left', roomId, playerId: ws.playerId });
            for (const client of room) {
                if (client.readyState === client.OPEN) client.send(payload);
            }
        }
    }
}

module.exports = { handleMessage, handleClose };
