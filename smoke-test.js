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
const ultimate = require('./src/routes/ultimate');
const worldRoutes = require('./src/routes/world');
const marketRoutes = require('./src/routes/market');
const chatRoutes = require('./src/routes/chat');
const economyRoutes = require('./src/routes/economy');
const { createHub, broadcastGalaxy } = require('./src/ws/hub');

process.env.ULTIMATE_CRAFT_MS = '50'; // short forge for smoke tests

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
    app.use('/api', ultimate.router);
    app.use('/api', worldRoutes);
    app.use('/api', marketRoutes);
    app.use('/api', chatRoutes);
    app.use('/api', economyRoutes);
    const server = http.createServer(app);
    createHub(server);
    ultimate.setBroadcastGalaxy(broadcastGalaxy);

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

    // ── state save/load — progress blob OK; economy wallets locked on PUT ──
    const saveState = { fleets: { home: { 'Wolf Cruiser': 5 } }, resources: { metal: 12345 }, horizonCoins: 777 };
    const putState = await fetch(`${base}/api/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ state: saveState }),
    }).then(r => r.json());
    check('state save succeeds', putState.success === true);
    check('PUT locks economy (ignores invented metal)', putState.economyLocked === true && putState.resources?.metal !== 12345);

    const getState = await fetch(`${base}/api/state`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('non-economy progress round-trips', getState.state?.fleets?.home?.['Wolf Cruiser'] === 5);
    check('forged resources did not stick', (getState.state?.resources?.metal || 0) !== 12345);
    check('forged HC via PUT did not stick', getState.horizonCoins !== 777);

    // Economy mutations go through /api/economy (admin grant for test seeding)
    const grantEco = await fetch(`${base}/api/economy/grant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({
            reason: 'admin',
            horizonCoins: 1337,
            resources: { metal: 50, credits: 0, he3: 0, food: 0 },
            inventoryAdd: [
                { id: '1', artifactId: 'fragment', quantity: 3 },
                { id: '2', artifactId: 'firehawkSchematic', quantity: 1 },
            ],
        }),
    }).then(r => r.json());
    check('admin economy grant succeeds', grantEco.success === true);
    check('inventory persists via economy grant', Array.isArray(grantEco.inventory) && grantEco.inventory.length === 2);
    check('schematic item persists', grantEco.inventory.some(i => i.artifactId === 'firehawkSchematic'));
    // HC grants are additive onto the column default (500)
    const aliceHcAfterGrant = grantEco.horizonCoins;
    check('horizon coins persist via economy grant', aliceHcAfterGrant === 500 + 1337);

    const inventPut = await fetch(`${base}/api/state`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ state: { fleets: getState.state.fleets, resources: { metal: 999999999 }, horizonCoins: 999999, inventory: [] } }),
    }).then(r => r.json());
    check('invented metal ignored on PUT', inventPut.resources?.metal === 50);
    check('invented HC ignored on PUT', inventPut.horizonCoins === aliceHcAfterGrant);
    check('inventory wipe via PUT ignored', inventPut.inventory?.length === 2);

    const spendEco = await fetch(`${base}/api/economy/spend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ resources: { metal: 10 } }),
    }).then(r => r.json());
    check('economy spend deducts metal', spendEco.success === true && spendEco.resources?.metal === 40);

    // ── world PUT lockdown + action-validated market/chat ──
    const badWorld = await fetch(`${base}/api/world/not_a_real_key`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ value: { listings: [] } }),
    });
    check('world rejects unknown key', badWorld.status === 400 || badWorld.status === 403);

    const spoofMarket = await fetch(`${base}/api/world/fractured_market`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ value: { listings: [{ id: 1, item: 'cheat' }], nextListingId: 2 } }),
    });
    check('raw market overwrite denied', spoofMarket.status === 403);

    const spoofChat = await fetch(`${base}/api/world/stellarCommandChat`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ value: { messages: [{ text: 'spoof' }] } }),
    });
    check('raw chat overwrite denied', spoofChat.status === 403);

    const putFleets = await fetch(`${base}/api/world/fu_guildFleets_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ value: { list: [{ id: 'm1', owner: 'alice', endTime: Date.now() + 60000 }] } }),
    });
    check('world guild fleets key still writable', putFleets.status === 200);

    // Seed market wallets via admin grant / direct DB (PUT cannot invent economy)
    await fetch(`${base}/api/economy/grant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({
            reason: 'admin',
            resources: { metal: 460, credits: 10000 }, // 40 left from earlier spend + 460 = 500
            inventoryAdd: [{ id: 'art1', artifactId: 'fragment', quantity: 2 }],
        }),
    });
    // Bob is not admin — seed via DB for the test harness only
    {
        const bobRow = await db.query('SELECT state FROM players WHERE username = $1', ['bob']);
        const st = (bobRow.rows[0]?.state && typeof bobRow.rows[0].state === 'object')
            ? { ...bobRow.rows[0].state }
            : {};
        st.resources = { metal: 0, he3: 0, food: 0, credits: 5000, population: 0, researchPoints: 0 };
        st.inventory = [];
        await db.query('UPDATE players SET state = $1, horizon_coins = 200 WHERE username = $2', [st, 'bob']);
    }

    const listRes = await fetch(`${base}/api/market/list-resource`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ resourceType: 'metal', quantity: 100, pricePerUnit: 5 }),
    }).then(r => r.json());
    check('market list-resource succeeds', listRes.success === true && listRes.listing?.id);
    check('listing escrows seller metal', listRes.state?.resources?.metal === 400);

    const marketView = await fetch(`${base}/api/market`, {
        headers: { Authorization: `Bearer ${login2Token(reg2)}` },
    }).then(r => r.json());
    check('buyer sees active listing', marketView.listings?.some(l => l.id === listRes.listing.id));

    const buyRes = await fetch(`${base}/api/market/buy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login2Token(reg2)}` },
        body: JSON.stringify({ listingId: listRes.listing.id }),
    }).then(r => r.json());
    check('market buy succeeds', buyRes.success === true);
    check('buyer gains metal', buyRes.state?.resources?.metal === 100);
    check('buyer pays credits', buyRes.state?.resources?.credits === 4500);

    const aliceAfterBuy = await fetch(base + '/api/state', {
        headers: { Authorization: 'Bearer ' + login1.token },
    }).then(r => r.json());
    check('seller receives credits', aliceAfterBuy.state?.resources?.credits === 10500);

    const chatPost = await fetch(`${base}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ text: 'hello galaxy' }),
    }).then(r => r.json());
    check('chat append succeeds', chatPost.success === true && chatPost.message?.text === 'hello galaxy');
    const chatGet = await fetch(`${base}/api/chat`, {
        headers: { Authorization: `Bearer ${login2Token(reg2)}` },
    }).then(r => r.json());
    check('chat visible to other players', chatGet.messages?.some(m => m.text === 'hello galaxy'));

    const artList = await fetch(`${base}/api/market/list-artifact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({
            artifactId: 'fragment', artifactName: 'Fragment', artifactIcon: '🧩',
            price: 50, inventoryItemId: 'art1', currency: 'credits',
        }),
    }).then(r => r.json());
    check('artifact listing escrows inventory', artList.success === true && !(artList.state?.inventory || []).some(i => i.id === 'art1'));

    const artBuy = await fetch(`${base}/api/market/buy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login2Token(reg2)}` },
        body: JSON.stringify({ listingId: artList.listing.id }),
    }).then(r => r.json());
    check('artifact buy transfers item', artBuy.success === true && artBuy.state?.inventory?.some(i => i.artifactId === 'fragment'));

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

    // ── Ultimate Weapon: start, announce, assault-disable, fire-wipe ──
    let sawStartAnnounce = false;
    const wsThreat = new WebSocket(`ws://localhost:${port}/ws?token=${login2Token(reg2)}`);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ultimate WS announce timeout')), 5000);
        wsThreat.on('error', reject);
        wsThreat.on('open', () => { clearTimeout(timer); resolve(); });
    });
    wsThreat.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'galaxy_announce' && msg.kind === 'start') sawStartAnnounce = true;
    });

    const startUw = await fetch(`${base}/api/ultimate/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ empireName: 'Terran Empire', baselinePlanets: 10, baselineFleet: 100 }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    check('ultimate craft starts (200)', startUw.status === 200);
    check('ultimate craft id returned', !!startUw.body.craft?.id);
    await new Promise((r) => setTimeout(r, 100));
    check('bob received galaxy_announce start', sawStartAnnounce);

    const activeUw = await fetch(`${base}/api/ultimate/active`, {
        headers: { Authorization: `Bearer ${login2Token(reg2)}` },
    }).then(r => r.json());
    check('active ultimate threats lists alice craft', activeUw.crafts?.some(c => c.username === 'alice'));

    const craftId = startUw.body.craft.id;
    const assault = await fetch(`${base}/api/ultimate/${craftId}/assault`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login2Token(reg2)}` },
        body: JSON.stringify({ fleetDamage: 60, planetDamage: 6 }), // >51% of 100/10
    }).then(r => r.json());
    check('assault can disable ultimate craft', assault.disabled === true && assault.craft?.status === 'disabled');

    // Fresh craft for fire/wipe path
    const startUw2 = await fetch(`${base}/api/ultimate/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
        body: JSON.stringify({ empireName: 'Terran Empire', baselinePlanets: 4, baselineFleet: 40 }),
    }).then(r => r.json());
    check('alice can start a new craft after prior disable', !!startUw2.craft?.id);
    const craftId2 = startUw2.craft.id;
    await new Promise((r) => setTimeout(r, 80)); // wait for ULTIMATE_CRAFT_MS=50
    const complete = await fetch(`${base}/api/ultimate/${craftId2}/complete`, {
        method: 'POST', headers: { Authorization: `Bearer ${login1.token}` },
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    check('complete arms ultimate weapon after timer', complete.status === 200 && complete.body.craft?.status === 'armed');

    // ── Offline research catch-up (browser closed / logged out) ──
    {
        const past = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
        // Seed via DB so the stored watermark is genuinely old (simulates last autosave before logout).
        const aliceRow = await db.query('SELECT state, horizon_coins FROM players WHERE username = $1', ['alice']);
        const prev = (aliceRow.rows[0]?.state && typeof aliceRow.rows[0].state === 'object')
            ? { ...aliceRow.rows[0].state }
            : {};
        const researchSeed = {
            ...prev,
            researchCaughtUpAt: past,
            ships: { 'Test Frigate': { name: 'Test Frigate', count: 0, researched: false } },
            researchQueue: [{
                name: 'Test Frigate',
                icon: '🚀',
                timeRemaining: 120,
                totalTime: 600,
            }],
            technologies: {
                offline_tech: { researched: false, researching: true, progress: 0 },
            },
            techResearchQueue: [{
                id: 'offline_tech',
                progress: 0,
                time: 60,
                effects: [{ type: 'resource', resource: 'metal', value: 0.05 }],
                name: 'Offline Tech',
            }],
            techBonuses: {},
            buildQueue: [{
                shipName: 'Test Frigate',
                quantity: 2,
                timeRemaining: 30,
                totalTime: 30,
            }],
            unlockedRaceTechs: {},
        };
        await db.query('UPDATE players SET state = $1 WHERE username = $2', [researchSeed, 'alice']);

        const afterResearch = await fetch(`${base}/api/state`, {
            headers: { Authorization: `Bearer ${login1.token}` },
        }).then((r) => r.json());
        const rs = afterResearch.state || {};
        check('offline ship research completes on GET', rs.ships?.['Test Frigate']?.researched === true);
        check('offline ship research clears queue', !rs.researchQueue?.some((r) => r.name === 'Test Frigate'));
        check('offline tech research completes on GET', rs.technologies?.offline_tech?.researched === true);
        check('offline tech research clears queue', !(rs.techResearchQueue || []).some((r) => r.id === 'offline_tech'));
        check('offline tech bonuses applied', (rs.techBonuses?.metal || 0) >= 0.05);
        check('offline build queue completes on GET', (rs.ships?.['Test Frigate']?.count || 0) >= 3); // +1 research +2 build
        check('researchCaughtUpAt advanced', !!rs.researchCaughtUpAt && Date.parse(rs.researchCaughtUpAt) > Date.parse(past));

        // Rewinding the watermark via PUT must not invent extra progress
        const stamp = rs.researchCaughtUpAt;
        await fetch(`${base}/api/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
            body: JSON.stringify({
                state: {
                    ...rs,
                    researchCaughtUpAt: '2000-01-01T00:00:00.000Z',
                    researchQueue: [{ name: 'Cheat Ship', timeRemaining: 5, totalTime: 5 }],
                    ships: { ...(rs.ships || {}), 'Cheat Ship': { name: 'Cheat Ship', count: 0, researched: false } },
                },
            }),
        });
        const noRewind = await fetch(`${base}/api/state`, {
            headers: { Authorization: `Bearer ${login1.token}` },
        }).then((r) => r.json());
        check(
            'client cannot rewind researchCaughtUpAt',
            Date.parse(noRewind.state?.researchCaughtUpAt || 0) >= Date.parse(stamp) - 2000
        );
        // Cheat ship must not complete from a forged ancient watermark (only real elapsed since stamp)
        check(
            'forged ancient watermark does not finish new research',
            noRewind.state?.ships?.['Cheat Ship']?.researched !== true
        );
    }

    // ── Commanders persist + empty PUT cannot wipe ──
    {
        const cmdState = {
            commanders: [
                { id: 'cmd_alpha', name: 'Alpha', rarity: 'COMMON', stars: 1, acquiredDate: 1000 },
                { id: 'cmd_beta', name: 'Beta', rarity: 'EPIC', stars: 2, acquiredDate: 2000 },
            ],
            commanderAssignments: { planets: { p1: 'cmd_alpha_1' }, fleets: {} },
            commandersRev: 3,
            researchCaughtUpAt: new Date().toISOString(),
        };
        await fetch(`${base}/api/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
            body: JSON.stringify({ state: cmdState }),
        });
        const cmdSaved = await fetch(`${base}/api/state`, {
            headers: { Authorization: `Bearer ${login1.token}` },
        }).then((r) => r.json());
        check('commanders persist across GET', (cmdSaved.state?.commanders || []).length === 2);
        check('commander assignments persist', !!cmdSaved.state?.commanderAssignments?.planets?.p1);
        check('commandersRev persisted', cmdSaved.state?.commandersRev === 3);

        // Stale empty autosave with older/equal rev must not wipe collection
        await fetch(`${base}/api/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
            body: JSON.stringify({
                state: {
                    ...cmdSaved.state,
                    commanders: [],
                    commanderAssignments: { planets: {}, fleets: {} },
                    commandersRev: 1,
                },
            }),
        });
        const cmdProtected = await fetch(`${base}/api/state`, {
            headers: { Authorization: `Bearer ${login1.token}` },
        }).then((r) => r.json());
        check('stale empty PUT cannot wipe commanders', (cmdProtected.state?.commanders || []).length === 2);
        check('commandersRev stays authoritative', cmdProtected.state?.commandersRev === 3);

        // Legitimate shrink (stack) with higher rev is allowed
        await fetch(`${base}/api/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login1.token}` },
            body: JSON.stringify({
                state: {
                    ...cmdProtected.state,
                    commanders: [{ id: 'cmd_beta', name: 'Beta', rarity: 'EPIC', stars: 3, acquiredDate: 2000 }],
                    commandersRev: 4,
                },
            }),
        });
        const cmdStacked = await fetch(`${base}/api/state`, {
            headers: { Authorization: `Bearer ${login1.token}` },
        }).then((r) => r.json());
        check('higher commandersRev can shrink collection', (cmdStacked.state?.commanders || []).length === 1);
        check('stacked commander stars kept', cmdStacked.state?.commanders?.[0]?.stars === 3);
    }

    // ── Offline economy + crafting catch-up on GET ──
    {
        const pastEco = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
        const aliceRow = await db.query('SELECT state FROM players WHERE username = $1', ['alice']);
        const prev = (aliceRow.rows[0]?.state && typeof aliceRow.rows[0].state === 'object')
            ? { ...aliceRow.rows[0].state }
            : {};
        const craftStart = Date.now() - 10 * 60 * 1000;
        prev.economyCollectedAt = pastEco;
        prev.resources = { ...(prev.resources || {}), metal: 100, credits: 100, he3: 100, food: 1000, population: 500, researchPoints: 0 };
        prev.planets = [{
            id: 1, name: 'Home', isHome: true, owner: 'alice',
            resources: { metal: 6000, he3: 3000, food: 3000 },
            population: 500,
            buildings: { 'Mining Outpost': 1, Farm: 1 },
        }];
        prev.playerData = { username: 'alice' };
        prev.selectedRace = { name: 'Terran Empire' };
        prev.craftingQueue = [{
            recipeId: 'reinforcedHull',
            name: 'Reinforced Hull Plating',
            startTime: craftStart,
            duration: 60 * 1000,
            endsAt: craftStart + 60 * 1000,
            repeatable: true,
            result: { type: 'techBonus', stat: 'hull', value: 15, display: '+15% Hull', duration: 48 * 60 * 60 * 1000 },
        }];
        prev.temporaryBonuses = [{ stat: 'damage', value: 5, expiresAt: Date.now() - 1000, craftName: 'Old' }];
        await db.query('UPDATE players SET state = $1 WHERE username = $2', [prev, 'alice']);

        const afterOffline = await fetch(`${base}/api/state`, {
            headers: { Authorization: `Bearer ${login1.token}` },
        }).then((r) => r.json());
        check('offline economy collect adds metal', (afterOffline.resources?.metal || 0) > 100);
        check('offline crafting completes', !(afterOffline.state?.craftingQueue || []).some((c) => c.recipeId === 'reinforcedHull'));
        check('offline craft applies temp bonus', (afterOffline.state?.temporaryBonuses || []).some((b) => b.stat === 'hull'));
        check('expired temp bonuses pruned', !(afterOffline.state?.temporaryBonuses || []).some((b) => b.craftName === 'Old'));
    }

    // Bob keeps HC via column (PUT can no longer invent HC)
    {
        const bobRow = await db.query('SELECT state FROM players WHERE username = $1', ['bob']);
        const st = (bobRow.rows[0]?.state && typeof bobRow.rows[0].state === 'object')
            ? { ...bobRow.rows[0].state }
            : {};
        st.resources = { ...(st.resources || {}), metal: 9 };
        await db.query('UPDATE players SET state = $1, horizon_coins = 4242 WHERE username = $2', [st, 'bob']);
    }

    let sawWipe = false;
    wsThreat.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'galaxy_wipe') sawWipe = true;
    });

    const fire = await fetch(`${base}/api/ultimate/${craftId2}/fire`, {
        method: 'POST', headers: { Authorization: `Bearer ${login1.token}` },
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    check('fire ultimate succeeds', fire.status === 200);
    await new Promise((r) => setTimeout(r, 100));
    check('bob received galaxy_wipe', sawWipe);

    const bobAfter = await fetch(`${base}/api/state`, {
        headers: { Authorization: `Bearer ${login2Token(reg2)}` },
    }).then(r => r.json());
    check('wipe clears empire state blob', !bobAfter.state?.resources?.metal);
    check('wipe preserves horizon coins', bobAfter.horizonCoins === 4242 || bobAfter.state?.horizonCoins === 4242);

    const aliceAfter = await fetch(`${base}/api/state`, {
        headers: { Authorization: `Bearer ${login1.token}` },
    }).then(r => r.json());
    check('alice HC still preserved after wipe', aliceAfter.horizonCoins === aliceHcAfterGrant || aliceAfter.state?.horizonCoins === aliceHcAfterGrant);

    wsThreat.close();
    server.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

function login2Token(reg2) { return reg2.token; }

main().catch((err) => {
    console.error('SMOKE TEST CRASHED:', err);
    process.exit(1);
});
