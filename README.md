# Fractured Universe

A browser-based space strategy game. This repo is **one deployable app**:
`server.js` serves the game itself (`index.html`, `assets/`, ship art, music)
*and* the multiplayer backend (accounts, persistent state, live battle
rooms) from the same Node process. One Heroku app, one deploy, done — the
game automatically talks to its own backend with no configuration step
(see `MP_CONFIG` in `index.html`, which defaults to `window.location.origin`).

## Deploy this to Heroku (do this to go live)

```bash
# From the root of this repo:
heroku create your-app-name
heroku buildpacks:set heroku/nodejs
heroku addons:create heroku-postgresql:essential-0
heroku config:set SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
git push heroku main
```

That's the whole thing. `DATABASE_URL` is set automatically by the Postgres
addon. The schema applies itself on boot (safe to re-run every deploy).
Once it's up, open `https://your-app-name.herokuapp.com` — that's the game,
live, with real accounts and persistence working.

**The `buildpacks:set` line matters** — without it, Heroku auto-detects the
language from whatever files are in the repo, and if it ever sees a stray
`.py` file before it notices `package.json`, it can wrongly pick the Python
buildpack and fail with "couldn't find requirements.txt". `app.json` in
this repo pins `heroku/nodejs` for app-manifest-based creates, but that
pin isn't retroactively applied to an app that already exists — if you've
already run `heroku create` and hit that error, just run
`heroku buildpacks:set heroku/nodejs -a your-app-name` once and re-push.

**Make the admin account** (do this once, after the first deploy):
```bash
heroku config:set ADMIN_USERNAME=Mister ADMIN_PASSWORD='put a real password here' ADMIN_EMAIL=you@example.com
heroku run node seed-admin.js
heroku config:unset ADMIN_USERNAME ADMIN_PASSWORD ADMIN_EMAIL
```
This is the only account that can select the paid-only Viral Race. Don't
put the real password in a commit — these config vars are the right place
for it, which is exactly why the script reads them from the environment
instead of taking them as arguments.

**Only extra step if you ever split the game and backend across two
different domains** (e.g. a CDN for static assets): set `ALLOWED_ORIGINS`
to the game's real origin(s), comma-separated. Not needed for the normal
single-app deploy above — same-origin requests don't need CORS at all.

## What's real here vs. what still needs work

**Real and tested:**
- Accounts (bcrypt-hashed passwords, session tokens) and persistent player
  state (Postgres JSONB column) — replaces the old client-side-only
  `auth.db`/localStorage
- Guilds (create/join/roster)
- Boss instances with a shared HP pool (world or guild-scoped)
- A WebSocket relay for live battle rooms — everyone in the same room sees
  everyone else's ship-state updates in real time. This is the whole
  mechanism behind the boss-ring live view and PvP spectating: the server
  just relays; the client (in `index.html`) decides how to draw it.
- Rate limiting on login/register

Covered by `node smoke-test.js` — 29 real checks (actual HTTP/WebSocket
calls against the real server code, via an in-memory Postgres) — run it
after any change to confirm nothing broke.

**Known, deliberate gaps — not bugs, just not built yet:**
- **Not cheat-proof.** Combat is still computed client-side and broadcast
  as a result the server trusts. A modified client could lie about damage
  dealt (including to a boss's shared HP pool). Making the server the
  source of truth for combat resolution is the natural next phase.
- **Single dyno only.** Room membership lives in one Node process's memory
  (see `src/ws/hub.js`). Fine for a beta's traffic. If you ever scale past
  1 web dyno, players on different dynos stop seeing each other's live
  battles — would need Heroku Redis as a pub/sub bridge between dynos.
- **No password reset flow.** A player who forgets their password has no
  self-service way back in yet.
- **No migration from pre-multiplayer local saves.** Anyone who played
  before this backend existed has progress trapped in that browser's
  localStorage; registering a real account starts fresh.

## Local development

```bash
cp .env.example .env   # fill in a local Postgres URL + a random SESSION_SECRET
npm install
npm start               # http://localhost:3000 — serves the game AND the API/WebSocket
npm test                # runs smoke-test.js against an in-memory Postgres, no real DB needed
```

## API reference

### REST (`/api/...`)

| Method | Path | Auth | Body | Notes |
|---|---|---|---|---|
| POST | `/api/auth/register` | — | `{username, password, email?, race?}` | Returns `{token, player}` |
| POST | `/api/auth/login` | — | `{username, password}` | Returns `{token, player}` |
| POST | `/api/auth/logout` | Bearer | — | Invalidates the session token |
| GET  | `/api/auth/me` | Bearer | — | Returns `{player}` |
| GET  | `/api/state` | Bearer | — | Returns `{state}` — the player's full save blob |
| PUT  | `/api/state` | Bearer | `{state}` | Overwrites the save blob (2MB cap) |
| POST | `/api/guilds` | Bearer | `{name, tag}` | Creates a guild, creator becomes leader |
| POST | `/api/guilds/:id/join` | Bearer | — | Joins a guild |
| GET  | `/api/guilds/:id/roster` | Bearer | — | Lists members |
| POST | `/api/bosses` | Bearer | `{bossName, maxHp, guildId?}` | Creates a boss instance (world if guildId omitted) |
| GET  | `/api/bosses/active` | Bearer | — | `?guildId=...` to scope to a guild; omitted = world bosses |
| GET  | `/api/bosses/:id` | Bearer | — | One boss instance |
| POST | `/api/bosses/:id/damage` | Bearer | `{amount}` | Applies damage, clamps at 0, marks defeated |

Auth is `Authorization: Bearer <token>` on every protected route.

### WebSocket (`/ws?token=<sessionToken>`)

See the full protocol and rationale in `src/ws/battleRoom.js`. Quick summary:

**Client → server:** `join_room {roomId, roomType}`, `leave_room {roomId}`,
`ship_state {roomId, payload}` (send every animation tick), `battle_event
{roomId, payload}`, `chat {roomId, payload:{text}}`

**Server → client:** `room_joined {roomId, members}`, `member_joined`/
`member_left {roomId, playerId, username?}`, `ship_state`/`battle_event`/
`chat {roomId, playerId, username, payload}`, `error {message}`

**Room ID convention:** `pvp:<username>` (the attacker's own username —
see `animateBattle()`/`spectatePvPBattle()` in `index.html`), `boss:
<bossInstanceId>` for a world/guild boss.

## Project layout

```
index.html              the game — client-side, loads assets/js/multiplayerClient.js
assets/                 ship art, logos, audio, and the MP client connector
server.js               entry point — serves the game AND the API/WebSocket
src/
  db.js                 Postgres pool + schema bootstrap
  auth.js                session/password helpers
  schema.sql             table definitions
  rateLimit.js            in-memory rate limiter
  routes/                 REST endpoints (auth, state, guild, boss)
  ws/                      WebSocket hub + battle-room relay protocol
seed-admin.js            run manually to create/promote an admin account
smoke-test.js            real end-to-end test suite (npm test)
```
