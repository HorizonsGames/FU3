/**
 * Fractured Universe — multiplayer client connector.
 *
 * A thin wrapper around the backend's REST + WebSocket API. Include this
 * script in index.html and use `window.MPClient` — it's deliberately kept
 * separate from the existing game code so you can wire it in one feature at
 * a time (accounts first, then state sync, then live battles) rather than
 * needing a single big-bang rewrite.
 *
 * Usage:
 *   <script src="multiplayerClient.js"></script>
 *   <script>
 *     const mp = new MPClient('https://your-app.herokuapp.com');
 *
 *     await mp.register('alice', 'password123', 'alice@example.com', 'Terran Empire');
 *     // or: await mp.login('alice', 'password123');
 *
 *     await mp.saveState(game.getSaveableState());   // replaces localStorage.setItem
 *     const { state } = await mp.loadState();         // replaces localStorage.getItem
 *
 *     mp.connect();
 *     mp.joinRoom('boss:' + bossInstanceId, 'boss');
 *     mp.onShipState((fromPlayerId, fromUsername, payload) => { ... render their ships ... });
 *     mp.sendShipState({ ships: myShipPositions });    // call this every animation tick
 *   </script>
 */
class MPClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
        this.token = localStorage.getItem('fu_mp_token') || null;
        this.player = null;
        this.ws = null;
        this.currentRoom = null;
        this._listeners = { ship_state: [], battle_event: [], chat: [], member_joined: [], member_left: [], room_joined: [] };
    }

    // ── REST: accounts ──────────────────────────────────────────────────
    async register(username, password, email, race) {
        const res = await this._post('/api/auth/register', { username, password, email, race });
        this._setSession(res);
        return res.player;
    }

    async login(username, password) {
        const res = await this._post('/api/auth/login', { username, password });
        this._setSession(res);
        return res.player;
    }

    async logout() {
        if (this.token) await this._post('/api/auth/logout', {}).catch(() => {});
        this.token = null;
        this.player = null;
        localStorage.removeItem('fu_mp_token');
        if (this.ws) this.ws.close();
    }

    async me() {
        const res = await this._get('/api/auth/me');
        this.player = res.player;
        return res.player;
    }

    _setSession(res) {
        this.token = res.token;
        this.player = res.player;
        localStorage.setItem('fu_mp_token', res.token);
    }

    // ── REST: persistent state (replaces localStorage save/load) ───────
    async saveState(state) {
        return this._put('/api/state', { state });
    }

    async loadState() {
        return this._get('/api/state'); // -> { state }
    }

    // ── REST: guilds ─────────────────────────────────────────────────
    async createGuild(name, tag) {
        return (await this._post('/api/guilds', { name, tag })).guild;
    }

    async joinGuild(guildId) {
        return this._post(`/api/guilds/${guildId}/join`, {});
    }

    async guildRoster(guildId) {
        return (await this._get(`/api/guilds/${guildId}/roster`)).members;
    }

    // ── REST: boss instances ────────────────────────────────────────
    // guildId omitted = world boss; set = that guild's boss.
    async createBoss(bossName, maxHp, guildId) {
        return (await this._post('/api/bosses', { bossName, maxHp, guildId })).boss;
    }

    async activeBosses(guildId) {
        const qs = guildId ? `?guildId=${encodeURIComponent(guildId)}` : '';
        return (await this._get(`/api/bosses/active${qs}`)).bosses;
    }

    async getBoss(bossId) {
        return (await this._get(`/api/bosses/${bossId}`)).boss;
    }

    async damageBoss(bossId, amount) {
        return this._post(`/api/bosses/${bossId}/damage`, { amount });
    }

    // ── WebSocket: live battle rooms ─────────────────────────────────
    connect() {
        if (!this.token) throw new Error('Log in before connecting to the live battle socket.');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();

        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`${this.wsUrl}?token=${encodeURIComponent(this.token)}`);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (e) => reject(e);
            this.ws.onclose = () => { this.currentRoom = null; };
            this.ws.onmessage = (evt) => this._dispatch(JSON.parse(evt.data));
        });
    }

    disconnect() {
        if (this.ws) this.ws.close();
        this.ws = null;
        this.currentRoom = null;
    }

    // roomType: 'pvp' or 'boss'. Convention: 'pvp:<matchId>' or 'boss:<bossInstanceId>'.
    joinRoom(roomId, roomType) {
        this.currentRoom = roomId;
        this._send({ type: 'join_room', roomId, roomType });
    }

    leaveRoom() {
        if (!this.currentRoom) return;
        this._send({ type: 'leave_room', roomId: this.currentRoom });
        this.currentRoom = null;
    }

    // Call this every animation tick with your fleet's current positions/hp —
    // it gets relayed to everyone else in the room so they can render it live.
    sendShipState(payload) {
        if (!this.currentRoom) return;
        this._send({ type: 'ship_state', roomId: this.currentRoom, payload });
    }

    // For discrete moments (a ship destroyed, victory/defeat) rather than
    // continuous position updates — keeps ship_state traffic lightweight.
    sendBattleEvent(payload) {
        if (!this.currentRoom) return;
        this._send({ type: 'battle_event', roomId: this.currentRoom, payload });
    }

    sendChat(text) {
        if (!this.currentRoom) return;
        this._send({ type: 'chat', roomId: this.currentRoom, payload: { text } });
    }

    onShipState(cb) { this._listeners.ship_state.push(cb); }
    onBattleEvent(cb) { this._listeners.battle_event.push(cb); }
    onChat(cb) { this._listeners.chat.push(cb); }
    onMemberJoined(cb) { this._listeners.member_joined.push(cb); }
    onMemberLeft(cb) { this._listeners.member_left.push(cb); }
    onRoomJoined(cb) { this._listeners.room_joined.push(cb); } // (roomId, members)

    _dispatch(msg) {
        if (msg.type === 'error') { console.warn('[MPClient] server error:', msg.message); return; }
        if (msg.type === 'room_joined') {
            this._listeners.room_joined.forEach((cb) => cb(msg.roomId, msg.members));
            return;
        }
        if (msg.type === 'member_joined') {
            this._listeners.member_joined.forEach((cb) => cb(msg.playerId, msg.username));
            return;
        }
        if (msg.type === 'member_left') {
            this._listeners.member_left.forEach((cb) => cb(msg.playerId));
            return;
        }
        if (this._listeners[msg.type]) {
            this._listeners[msg.type].forEach((cb) => cb(msg.playerId, msg.username, msg.payload));
        }
    }

    _send(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
    }

    // ── internal fetch helpers ──────────────────────────────────────
    async _get(path) { return this._fetch(path, 'GET'); }
    async _post(path, body) { return this._fetch(path, 'POST', body); }
    async _put(path, body) { return this._fetch(path, 'PUT', body); }

    async _fetch(path, method, body) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        const res = await fetch(this.baseUrl + path, {
            method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
        return json;
    }
}

if (typeof window !== 'undefined') window.MPClient = MPClient;
if (typeof module !== 'undefined') module.exports = MPClient;
