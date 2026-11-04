-- Fractured Universe — multiplayer backend schema (Postgres)
-- Run automatically on boot by db.js (idempotent — safe to run every deploy).
-- IDs are generated application-side (crypto.randomUUID() in Node) rather than
-- via a Postgres extension — one less thing to configure on a fresh Heroku
-- Postgres instance.

CREATE TABLE IF NOT EXISTS players (
    id            UUID PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    email         TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    race          TEXT,
    -- 'player' (default), 'admin', 'csr', or 'benefactor' — mirrors the client's
    -- accountType field. Governs things like the Viral Race's admin/paid-only
    -- lock (see isRaceUnlocked() in index.html) and, eventually, an admin panel.
    -- Never settable via the public register endpoint — only via seed-admin.js
    -- or a direct DB update, so a player can't just register their way into it.
    account_type  TEXT NOT NULL DEFAULT 'player',
    -- Full player game state as JSON — fleets, planets, resources, research, etc.
    -- Mirrors the shape already used by the client's localStorage save today,
    -- which is what makes this a drop-in replacement rather than a data migration.
    state         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Horizon Coins persist across Ultimate Weapon galaxy wipes (state is cleared).
    horizon_coins BIGINT NOT NULL DEFAULT 500,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);
-- Idempotent add for databases created before account_type existed.
ALTER TABLE players ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'player';
ALTER TABLE players ADD COLUMN IF NOT EXISTS horizon_coins BIGINT NOT NULL DEFAULT 500;

-- Ultimate Weapon (end-game galaxy wipe) crafts / threats
CREATE TABLE IF NOT EXISTS ultimate_weapon_crafts (
    id                UUID PRIMARY KEY,
    player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    username          TEXT NOT NULL,
    empire_name       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'crafting', -- crafting|armed|disabled|fired
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completes_at      TIMESTAMPTZ NOT NULL,
    armed_at          TIMESTAMPTZ,
    disabled_at       TIMESTAMPTZ,
    fired_at          TIMESTAMPTZ,
    last_announce_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    baseline_planets  INTEGER NOT NULL DEFAULT 0,
    baseline_fleet    INTEGER NOT NULL DEFAULT 0,
    current_planets   INTEGER NOT NULL DEFAULT 0,
    current_fleet     INTEGER NOT NULL DEFAULT 0,
    disable_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_ultimate_crafts_status ON ultimate_weapon_crafts(status);
CREATE INDEX IF NOT EXISTS idx_ultimate_crafts_player ON ultimate_weapon_crafts(player_id);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    player_id  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

CREATE TABLE IF NOT EXISTS guilds (
    id         UUID PRIMARY KEY,
    name       TEXT UNIQUE NOT NULL,
    tag        TEXT UNIQUE NOT NULL,
    leader_id  UUID NOT NULL REFERENCES players(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_members (
    guild_id  UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, player_id)
);

-- World/guild boss instances that players can join live-battle rooms for.
CREATE TABLE IF NOT EXISTS boss_instances (
    id           UUID PRIMARY KEY,
    boss_name    TEXT NOT NULL,
    guild_id     UUID REFERENCES guilds(id),  -- null = world boss (open to everyone)
    max_hp       BIGINT NOT NULL,
    current_hp   BIGINT NOT NULL,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    defeated_at  TIMESTAMPTZ
);
