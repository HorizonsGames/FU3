// Not part of the shipped app — validates the real server code end-to-end
// using an in-memory Postgres (pg-mem) instead of a real database, since
// this sandbox has no way to install Postgres. Run with: node smoke-test.js
const Module = require('module');
const { newDb } = require('pg-mem');

const mem = newDb();
mem.registerExtension('pgcrypto', (schema) => {
    schema.registerFunction({
        name: 'gen_random_uuid',
        returns: 'uuid',
        implementation: () => require('crypto').randomUUID(),
    });
});
const pgAdapter = mem.adapters.createPg();
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'pg') return pgAdapter;
    return originalLoad.call(this, request, ...rest);
};

process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';
process.env.SESSION_SECRET = 'smoke-test-secret';
process.env.ALLOWED_ORIGINS = '';
process.env.NODE_ENV = 'test';

const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const db = require('./src/db');
const authRoutes = require('./src/routes/auth');
const stateRoutes = require('./src/routes/state');
const guildRoutes = require('./src/routes/guild');
const bossRoutes = require('./src/routes/boss');
const { createHub } = require('./src/ws/hub');

let pass = 0, fail = 0;
function check(label, cond) {
    if (cond) { pass++; console.log(`  ok  - ${label}`); }
    else { fail++; console.log(`  FAIL - ${label}`); }
}

async function main() {
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api', stateRoutes);
    app.use('/api', guildRoutes);
    app.use('/api', bossRoutes);
    const server = http.createServer(app);
    createHub(server);

    await db.initSchema();
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://localhost:${port}`;

    // ── REST: register two players ──
    const reg1 = await fetch(`${base}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'hunter2pass', race: 'Terran Empire' }),
    }).then(r => r.json());
    check('register alice returns token', !!reg1.token);
    check('register alice returns player', reg1.player?.username === 'alice');

    const reg2 = await fetch(`${base}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'hunter2pass', race: "Kor'ai Dynasty" }),
    }).then(r => r.json());
    check('register bob returns token', !!reg2.token);

    // duplicate username should fail
    const dupe = await fetch(`${base}/api/auth/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'hunter2pass' }),
    });
    check('duplicate username rejected (409)', dupe.status === 409);

    // wrong password login should fail
    const badLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'wrongpassword' }),
    });
    check('wrong password rejected (401)', badLogin.status === 401);

    // correct login
    const login1 = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'hunter2pass' }),
    }).then(r => r.json());
    check('login alice returns token', !!login1.token);

    // /api/me with token
    const me = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('me returns correct username', me.player?.username === 'alice');

    // /api/me without token should 401
    const meNoAuth = await fetch(`${base}/api/auth/me`);
    check('me without token rejected (401)', meNoAuth.status === 401);

    // ── account_type / admin-seeding (mirrors what seed-admin.js does) ──
    check('new registrations default to account_type player', reg1.player?.accountType === 'player');
    await db.query("UPDATE players SET account_type = 'admin' WHERE username = 'alice'");
    const meAfterPromote = await fetch(`${base}/api/auth/me`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('promoted account reports accountType admin via API', meAfterPromote.player?.accountType === 'admin');

    // ── state save/load ──
    const saveState = { fleets: { home: { 'Wolf Cruiser': 5 } }, resources: { metal: 12345 } };
    const putState = await fetch(`${base}/api/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ state: saveState }),
    });
    check('state save succeeds (200)', putState.status === 200);

    const getState = await fetch(`${base}/api/state`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('state round-trips correctly', getState.state?.resources?.metal === 12345);

    // ── guilds ──
    const guild = await fetch(`${base}/api/guilds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ name: 'Star Wolves', tag: 'SWLF' }),
    }).then(r => r.json());
    check('guild created', guild.guild?.name === 'Star Wolves');

    const join = await fetch(`${base}/api/guilds/${guild.guild.id}/join`, {
        method: 'POST', headers: { Authorization: `Bearer ${login2Token(reg2)}` },
    });
    check('bob joins guild (200)', join.status === 200);

    const roster = await fetch(`${base}/api/guilds/${guild.guild.id}/roster`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('roster has 2 members', roster.members?.length === 2);

    // ── boss instances ──
    const worldBoss = await fetch(`${base}/api/bosses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ bossName: 'The Fracture Herald', maxHp: 1000000 }),
    }).then(r => r.json());
    check('world boss created', worldBoss.boss?.bossName === 'The Fracture Herald');
    check('world boss starts at full HP', worldBoss.boss?.currentHp === 1000000);

    const guildBoss = await fetch(`${base}/api/bosses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ bossName: 'Star Wolves Warden', maxHp: 50000, guildId: guild.guild.id }),
    }).then(r => r.json());
    check('guild boss created', guildBoss.boss?.guildId === guild.guild.id);

    const activeWorld = await fetch(`${base}/api/bosses/active`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('active world bosses excludes guild boss', activeWorld.bosses?.every(b => !b.guildId) && activeWorld.bosses.some(b => b.id === worldBoss.boss.id));

    const activeGuild = await fetch(`${base}/api/bosses/active?guildId=${guild.guild.id}`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('active guild bosses scoped correctly', activeGuild.bosses?.length === 1 && activeGuild.bosses[0].id === guildBoss.boss.id);

    const dmg1 = await fetch(`${base}/api/bosses/${worldBoss.boss.id}/damage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ amount: 400000 }),
    }).then(r => r.json());
    check('damage reduces HP correctly', dmg1.boss?.currentHp === 600000);
    check('not defeated yet', dmg1.defeated === false);

    const dmg2 = await fetch(`${base}/api/bosses/${worldBoss.boss.id}/damage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ amount: 999999999 }),
    }).then(r => r.json());
    check('overkill damage clamps at 0 HP', dmg2.boss?.currentHp === 0);
    check('boss marked defeated', dmg2.defeated === true);

    const dmgAfterDefeat = await fetch(`${base}/api/bosses/${worldBoss.boss.id}/damage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ amount: 100 }),
    });
    check('damaging a defeated boss is rejected (409)', dmgAfterDefeat.status === 409);

    // ── rate limiting (login is limited to 8 attempts/15min per username) ──
    let rateLimited = false;
    for (let i = 0; i < 10; i++) {
        const attempt = await fetch(`${base}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'rate-limit-target', password: 'wrongpassword' }),
        });
        if (attempt.status === 429) { rateLimited = true; break; }
    }
    check('repeated failed logins against one username eventually get rate-limited (429)', rateLimited);

    // ── WebSocket: live battle room relay (the PvP/boss "live view" mechanism) ──
    await new Promise((resolve, reject) => {
        const wsAlice = new WebSocket(`ws://localhost:${port}/ws?token=${login1.token}`);
        const wsBob = new WebSocket(`ws://localhost:${port}/ws?token=${login2Token(reg2)}`);
        let aliceJoined = false, bobSawJoin = false, bobSawShipState = false;

        const maybeFinish = () => {
            if (aliceJoined && bobSawJoin && bobSawShipState) {
                check('alice room_joined ack received', aliceJoined);
                check('bob saw alice member_joined broadcast', bobSawJoin);
                check('bob received alice ship_state relay', bobSawShipState);
                wsAlice.close(); wsBob.close();
                resolve();
            }
        };

        wsBob.on('open', () => {
            wsBob.send(JSON.stringify({ type: 'join_room', roomId: 'boss:test-instance-1', roomType: 'boss' }));
        });
        wsBob.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'member_joined' && msg.username === 'alice') { bobSawJoin = true; maybeFinish(); }
            if (msg.type === 'ship_state' && msg.username === 'alice') { bobSawShipState = true; maybeFinish(); }
        });

        wsAlice.on('open', () => {
            setTimeout(() => { // let bob join first so it can observe alice's join broadcast
                wsAlice.send(JSON.stringify({ type: 'join_room', roomId: 'boss:test-instance-1', roomType: 'boss' }));
            }, 150);
        });
        wsAlice.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'room_joined') {
                aliceJoined = true;
                wsAlice.send(JSON.stringify({
                    type: 'ship_state', roomId: 'boss:test-instance-1',
                    payload: { ships: [{ x: 10, y: 20, hp: 100 }] },
                }));
                maybeFinish();
            }
        });

        setTimeout(() => reject(new Error('WS test timed out after 5s')), 5000);
    });

    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

function login2Token(reg2) { return reg2.token; }

main().catch((err) => {
    console.error('SMOKE TEST CRASHED:', err);
    process.exit(1);
});
