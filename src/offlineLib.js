/**
 * Server-side offline progression. Runs on GET/PUT /api/state so queues and
 * production advance while the browser is closed or the player is logged out.
 */
const eco = require('./economyLib');
const research = require('./researchLib');

const SIEGE_DURATION_MS = 5 * 60 * 1000;

function parseTs(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Date.parse(String(value));
    return Number.isFinite(n) ? n : null;
}

function applyCraftResult(state, item, now) {
    const result = item && item.result;
    if (!result || typeof result !== 'object') return;

    if (!state.temporaryBonuses) state.temporaryBonuses = [];
    if (!state.techBonuses || typeof state.techBonuses !== 'object') state.techBonuses = {};
    if (!state.craftedRecipes || typeof state.craftedRecipes !== 'object') state.craftedRecipes = {};
    if (!Array.isArray(state.unlockedShips)) state.unlockedShips = [];
    if (!Array.isArray(state.inventory)) state.inventory = eco.normalizeInventory(state.inventory);

    const pushTemp = (stat, value, duration, craftName, display) => {
        if (!stat || !duration) return;
        state.temporaryBonuses.push({
            stat,
            value: Number(value) || 0,
            expiresAt: now + Number(duration),
            craftName: craftName || item.name || item.recipeId || 'Craft',
            display: display || '',
            appliedAt: now,
        });
    };

    if (result.type === 'techBonus') {
        if (result.duration) {
            pushTemp(result.stat, result.value, result.duration, item.name, result.display);
        } else if (result.stat) {
            state.techBonuses[result.stat] = (state.techBonuses[result.stat] || 0) + (Number(result.value) || 0);
        }
    } else if (result.type === 'multiBonus' && Array.isArray(result.bonuses)) {
        for (const b of result.bonuses) {
            if (!b) continue;
            if (result.duration) pushTemp(b.stat, b.value, result.duration, item.name, b.display);
            else if (b.stat) {
                state.techBonuses[b.stat] = (state.techBonuses[b.stat] || 0) + (Number(b.value) || 0);
            }
        }
    } else if (result.type === 'unlockShip' && result.shipType) {
        if (!state.unlockedShips.includes(result.shipType)) {
            state.unlockedShips.push(result.shipType);
        }
    } else if (result.type === 'grantItem' && result.artifactId) {
        eco.addInventoryItem(state.inventory, {
            artifactId: result.artifactId,
            quantity: Math.max(1, Math.floor(Number(result.quantity) || 1)),
            source: 'crafting',
            foundAt: new Date(now).toISOString(),
        });
    }

    if (item.repeatable === false && item.recipeId) {
        state.craftedRecipes[item.recipeId] = true;
    }
}

function catchUpCrafting(state, now) {
    let changed = false;
    const completed = [];
    if (!Array.isArray(state.craftingQueue) || !state.craftingQueue.length) {
        return { changed, completed };
    }
    const next = [];
    for (const item of state.craftingQueue) {
        if (!item || typeof item !== 'object') continue;
        const start = parseTs(item.startTime) ?? parseTs(item.startedAt);
        const duration = Number(item.duration) || (Number(item.craftTime) || 0) * 1000;
        const endsAt = parseTs(item.endsAt) ?? (start != null && duration > 0 ? start + duration : null);
        if (endsAt != null && endsAt <= now) {
            applyCraftResult(state, item, now);
            completed.push({ type: 'craft', recipeId: item.recipeId });
            changed = true;
        } else {
            if (endsAt != null && item.endsAt == null) item.endsAt = endsAt;
            next.push(item);
        }
    }
    if (changed) state.craftingQueue = next;
    return { changed, completed };
}

function expireTemporaryBonuses(state, now) {
    if (!Array.isArray(state.temporaryBonuses) || !state.temporaryBonuses.length) {
        return { changed: false };
    }
    const before = state.temporaryBonuses.length;
    state.temporaryBonuses = state.temporaryBonuses.filter((b) => b && (parseTs(b.expiresAt) ?? 0) > now);
    return { changed: state.temporaryBonuses.length !== before };
}

function resolveSiege(state, siege, now) {
    siege.active = false;
    siege.resolvedAt = now;
    const planets = Array.isArray(state.planets) ? state.planets : [];
    const target = planets.find((p) => p && (p.id === siege.planetId || p.name === siege.planetName));
    const raceName = state.selectedRace?.name || state.race || null;
    const username = state.playerData?.username || state.username || null;

    if (target) {
        target.siegedBy = null;
        target.siegedUntil = null;
        if (raceName && target.owner !== raceName) {
            // 15% losses from holding
            const force = siege.force && typeof siege.force === 'object' ? siege.force : {};
            if (!state.ships) state.ships = {};
            for (const [name, qty] of Object.entries(force)) {
                const lost = Math.ceil((Number(qty) || 0) * 0.15);
                if (state.ships[name]) {
                    state.ships[name].count = Math.max(0, Math.floor(Number(state.ships[name].count) || 0) - lost);
                }
            }
            target.owner = raceName;
            target.ownerUsername = username || raceName;
            target.botGarrison = {};
            target.botGarrisonPower = 0;
            siege.captured = true;
        }
    }

    // Free mission fleet / ships
    if (siege.missionFleetIdx != null && Array.isArray(state.fleets) && state.fleets[siege.missionFleetIdx]) {
        state.fleets[siege.missionFleetIdx].onMission = false;
    }
    if (Array.isArray(siege.missionShipNames) && state.ships) {
        for (const n of siege.missionShipNames) {
            if (state.ships[n]) state.ships[n].onMission = false;
        }
    }
}

function catchUpSieges(state, now) {
    let changed = false;
    const completed = [];
    if (!Array.isArray(state.sieges) || !state.sieges.length) return { changed, completed };

    for (const siege of state.sieges) {
        if (!siege || !siege.active) continue;
        const endsAt = parseTs(siege.endsAt);
        if (endsAt == null || endsAt > now) continue;
        resolveSiege(state, siege, now);
        completed.push({ type: 'siege', planetId: siege.planetId });
        changed = true;
    }
    return { changed, completed };
}

function catchUpPendingMissions(state, now) {
    let changed = false;
    const completed = [];
    if (!Array.isArray(state.pendingMissions) || !state.pendingMissions.length) {
        return { changed, completed };
    }
    const remaining = [];
    for (const mission of state.pendingMissions) {
        if (!mission || typeof mission !== 'object') continue;
        const arrivesAt = parseTs(mission.arrivesAt) ?? parseTs(mission.endTime);
        if (arrivesAt == null || arrivesAt > now) {
            remaining.push(mission);
            continue;
        }

        if (mission.type === 'siege_travel') {
            // Travel finished while offline — start the siege hold timer from arrival.
            if (!Array.isArray(state.sieges)) state.sieges = [];
            const siege = {
                id: mission.siegeId || `siege_${now}`,
                planetId: mission.planetId,
                planetName: mission.planetName,
                attackPower: mission.attackPower,
                force: mission.force || {},
                missionFleetIdx: mission.missionFleetIdx,
                missionShipNames: mission.missionShipNames || [],
                startedAt: arrivesAt,
                endsAt: arrivesAt + (Number(mission.siegeDurationMs) || SIEGE_DURATION_MS),
                active: true,
            };
            state.sieges.push(siege);
            const planets = Array.isArray(state.planets) ? state.planets : [];
            const target = planets.find((p) => p && p.id === mission.planetId);
            if (target) {
                target.siegedBy = state.selectedRace?.name || state.race || true;
                target.siegedUntil = siege.endsAt;
            }
            completed.push({ type: 'siege_travel', planetId: mission.planetId });
            changed = true;
            // If siege already expired during longer offline, resolve immediately
            if (siege.endsAt <= now) {
                resolveSiege(state, siege, now);
                completed.push({ type: 'siege', planetId: siege.planetId });
            }
        } else if (mission.type === 'attack') {
            // Defer full combat to client on load; free ships so they are not stuck forever.
            if (mission.missionFleetIndex != null && Array.isArray(state.fleets) && state.fleets[mission.missionFleetIndex]) {
                state.fleets[mission.missionFleetIndex].onMission = false;
            }
            if (Array.isArray(mission.missionShipNames) && state.ships) {
                for (const n of mission.missionShipNames) {
                    if (state.ships[n]) state.ships[n].onMission = false;
                }
            }
            // Keep payload so client can still resolve combat UI once after login.
            if (!Array.isArray(state.deferredAttacks)) state.deferredAttacks = [];
            state.deferredAttacks.push({ ...mission, arrivedAt: arrivesAt });
            completed.push({ type: 'attack_arrived', planetId: mission.planetId });
            changed = true;
        } else {
            remaining.push(mission);
        }
    }
    state.pendingMissions = remaining;
    return { changed, completed };
}

function catchUpEconomy(state, now) {
    const last = Number(state.economyCollectedAt) || now;
    const elapsed = Math.max(0, now - last);
    if (elapsed < 1000) {
        return { changed: false, delta: null };
    }
    if (!state.selectedRace && state.race) {
        state.selectedRace = { name: state.race };
    }
    const delta = eco.computeCollectDelta(state, elapsed);
    eco.applyDelta(state.resources, delta);
    state.economyCollectedAt = now;
    return { changed: delta.seconds > 0, delta };
}

/**
 * Merge commanders so a stale/empty client PUT cannot wipe the collection.
 * Client must bump commandersRev when the collection legitimately changes.
 */
function mergeCommanders(existing, incoming) {
    const prev = Array.isArray(existing.commanders) ? existing.commanders : [];
    const next = Array.isArray(incoming.commanders) ? incoming.commanders : null;
    const prevRev = Math.max(0, Math.floor(Number(existing.commandersRev) || 0));
    const nextRev = Math.max(0, Math.floor(Number(incoming.commandersRev) || 0));

    if (next == null) {
        return {
            commanders: prev,
            commanderAssignments: existing.commanderAssignments || { planets: {}, fleets: {} },
            commandersRev: prevRev,
        };
    }

    // Newer revision always wins (covers stacking that shrinks the array).
    if (nextRev > prevRev) {
        return {
            commanders: next,
            commanderAssignments: incoming.commanderAssignments || existing.commanderAssignments || { planets: {}, fleets: {} },
            commandersRev: nextRev,
        };
    }

    // Same or older revision: never replace a non-empty server collection with empty/smaller stale data.
    if (nextRev < prevRev) {
        return {
            commanders: prev,
            commanderAssignments: existing.commanderAssignments || { planets: {}, fleets: {} },
            commandersRev: prevRev,
        };
    }

    // Equal rev: prefer the larger collection (guards against empty autosave races).
    if (next.length >= prev.length) {
        return {
            commanders: next,
            commanderAssignments: incoming.commanderAssignments || existing.commanderAssignments || { planets: {}, fleets: {} },
            commandersRev: nextRev,
        };
    }
    return {
        commanders: prev,
        commanderAssignments: existing.commanderAssignments || { planets: {}, fleets: {} },
        commandersRev: prevRev,
    };
}

/**
 * Full offline catch-up. Mutates state. Returns { state, changed, completed, economyDelta }.
 */
function catchUpOffline(state, nowMs = Date.now()) {
    if (!state || typeof state !== 'object') {
        return { state, changed: false, completed: [], economyDelta: null };
    }
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const completed = [];
    let changed = false;

    const ecoResult = catchUpEconomy(state, now);
    if (ecoResult.changed) changed = true;

    const researchResult = research.catchUpResearch(state, now);
    if (researchResult.changed) changed = true;
    completed.push(...(researchResult.completed || []));

    const craftResult = catchUpCrafting(state, now);
    if (craftResult.changed) changed = true;
    completed.push(...craftResult.completed);

    const bonusResult = expireTemporaryBonuses(state, now);
    if (bonusResult.changed) changed = true;

    const missionResult = catchUpPendingMissions(state, now);
    if (missionResult.changed) changed = true;
    completed.push(...missionResult.completed);

    const siegeResult = catchUpSieges(state, now);
    if (siegeResult.changed) changed = true;
    completed.push(...siegeResult.completed);

    state.progressCaughtUpAt = new Date(now).toISOString();

    return {
        state,
        changed,
        completed,
        economyDelta: ecoResult.delta,
    };
}

module.exports = {
    catchUpOffline,
    mergeCommanders,
    SIEGE_DURATION_MS,
};
