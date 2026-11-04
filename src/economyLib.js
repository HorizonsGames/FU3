/** Shared helpers for authoritative player economy (resources / inventory / HC). */

const RESOURCE_KEYS = ['metal', 'he3', 'food', 'credits', 'population', 'researchPoints'];
const MAX_RESOURCE = 1_000_000_000;
const MAX_OFFLINE_MS = 8 * 60 * 60 * 1000; // 8h catch-up cap

function readHc(value, fallback = 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    const fb = Number(fallback);
    return Number.isFinite(fb) ? Math.max(0, Math.floor(fb)) : 0;
}

function normalizeResources(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    for (const k of RESOURCE_KEYS) {
        out[k] = Math.max(0, Math.min(MAX_RESOURCE, Math.floor(Number(r[k]) || 0)));
    }
    return out;
}

function normalizeInventory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((i) => i && typeof i === 'object' && i.artifactId)
        .map((i) => ({
            id: i.id != null ? String(i.id) : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            artifactId: String(i.artifactId),
            quantity: Math.max(1, Math.floor(Number(i.quantity) || 1)),
            foundAt: i.foundAt || new Date().toISOString(),
            source: i.source || 'unknown',
            planetName: i.planetName || null,
        }))
        .slice(0, 500);
}

function normalizeState(row) {
    const state = (row.state && typeof row.state === 'object') ? { ...row.state } : {};
    state.resources = normalizeResources(state.resources);
    state.inventory = normalizeInventory(state.inventory);
    state.horizonCoins = readHc(row.horizon_coins, state.horizonCoins);
    return state;
}

function economySnapshot(state) {
    return {
        resources: { ...state.resources },
        inventory: state.inventory.slice(),
        horizonCoins: state.horizonCoins,
    };
}

function clampAdd(resources, key, amount) {
    resources[key] = Math.max(0, Math.min(MAX_RESOURCE, (resources[key] || 0) + amount));
}

/**
 * Conservative production collect from planets/clusters already stored on the server.
 * Intentionally slightly simpler than the full client tick (race-tech micro-bonuses
 * still apply client-side for UI, but inventing wealth via PUT is impossible).
 */
function computeCollectDelta(state, elapsedMs) {
    const ms = Math.max(0, Math.min(MAX_OFFLINE_MS, elapsedMs));
    const seconds = Math.floor(ms / 1000);
    if (seconds < 1) {
        return { metal: 0, he3: 0, food: 0, credits: 0, population: 0, researchPoints: 0, seconds: 0 };
    }

    const gMetal = 0.7 * 0.65 * 0.40;
    const gHe3 = 0.7 * 0.65 * 0.40;
    const gFood = 0.65 * 0.40;
    const gCredit = 0.65 * 0.70 * 0.40;

    let metal = 0;
    let he3 = 0;
    let food = 0;
    let popGain = 0;

    const planets = Array.isArray(state.planets) ? state.planets : [];
    const username = state.playerData?.username || state.username || null;
    const raceName = state.selectedRace?.name || state.race || null;

    const ownedPlanets = planets.filter((p) => {
        if (!p || p.inCluster) return false;
        if (p.owner === username || p.owner === raceName) return true;
        if (p.isHome || p.isPlayerHome) return true;
        return false;
    });

    for (const planet of ownedPlanets) {
        let metalBonus = 1;
        let foodBonus = 1;
        if (planet.buildings?.['Mining Outpost']) metalBonus += 0.15;
        if (planet.buildings?.Farm) foodBonus += 0.15;
        const pMetal = Number(planet.resources?.metal) || 0;
        const pHe3 = Number(planet.resources?.he3) || 0;
        const pFood = Number(planet.resources?.food) || 0;
        metal += Math.floor((pMetal / 60) * metalBonus * gMetal) * seconds;
        he3 += Math.floor((pHe3 / 60) * gHe3) * seconds;
        food += Math.floor((pFood / 60) * foodBonus * gFood) * seconds;

        if (planet.population) {
            const growth = Math.ceil((planet.population * 0.01) / 60) * seconds;
            const maxPop = 2500;
            const room = Math.max(0, maxPop - planet.population);
            const actual = Math.min(growth, room);
            planet.population = Math.min(maxPop, planet.population + actual);
            popGain += actual;
        }
    }

    const clusters = Array.isArray(state.clusters) ? state.clusters : [];
    for (const cluster of clusters) {
        if (!cluster || cluster.inCluster) continue;
        if (cluster.owner && username && cluster.owner !== username && cluster.owner !== raceName) continue;
        let cMetalBonus = 1;
        let cFoodBonus = 1;
        if (cluster.buildings?.['Mining Outpost']) {
            cMetalBonus += 0.15 * (cluster.buildings['Mining Outpost'] || 1);
        }
        if (cluster.buildings?.Farm) {
            cFoodBonus += 0.15 * (cluster.buildings.Farm || 1);
        }
        metal += Math.floor(((Number(cluster.resources?.metal) || 0) / 60) * cMetalBonus * gMetal) * seconds;
        he3 += Math.floor(((Number(cluster.resources?.he3) || 0) / 60) * gHe3) * seconds;
        food += Math.floor(((Number(cluster.resources?.food) || 0) / 60) * cFoodBonus * gFood) * seconds;
    }

    const population = (state.resources?.population || 0) + popGain;
    const foodConsumption = Math.floor(population / 7500) * seconds;
    food -= foodConsumption;

    let credits = 0;
    if (food > 0 || (state.resources?.food || 0) + food > 0) {
        const base = Math.floor((population / 100) * 2.1 * gCredit);
        credits = base * seconds;
    }

    // Light RP trickle
    const researchPoints = Math.floor(seconds / 10);

    return {
        metal: Math.max(0, metal),
        he3: Math.max(0, he3),
        food, // may be negative before clamp
        credits: Math.max(0, credits),
        population: Math.max(0, popGain),
        researchPoints: Math.max(0, researchPoints),
        seconds,
    };
}

function applyDelta(resources, delta) {
    clampAdd(resources, 'metal', delta.metal || 0);
    clampAdd(resources, 'he3', delta.he3 || 0);
    clampAdd(resources, 'food', delta.food || 0);
    clampAdd(resources, 'credits', delta.credits || 0);
    clampAdd(resources, 'population', delta.population || 0);
    clampAdd(resources, 'researchPoints', delta.researchPoints || 0);
}

function canAfford(resources, costs, hc, hcCost) {
    for (const [k, v] of Object.entries(costs || {})) {
        const need = Math.floor(Number(v) || 0);
        if (need <= 0) continue;
        if ((resources[k] || 0) < need) return false;
    }
    if (hcCost > 0 && hc < hcCost) return false;
    return true;
}

function applySpend(resources, costs, hc, hcCost) {
    for (const [k, v] of Object.entries(costs || {})) {
        const need = Math.floor(Number(v) || 0);
        if (need <= 0) continue;
        resources[k] = Math.max(0, (resources[k] || 0) - need);
    }
    return Math.max(0, hc - Math.max(0, Math.floor(hcCost || 0)));
}

function addInventoryItem(inventory, item) {
    const artifactId = String(item.artifactId || '');
    if (!artifactId) return;
    const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const stackable = item.stackable !== false && (item.source === 'crafting' || item.stack !== false);
    if (stackable) {
        const existing = inventory.find((i) => i.artifactId === artifactId);
        if (existing) {
            existing.quantity = Math.max(1, (existing.quantity || 1) + qty);
            return;
        }
    }
    inventory.push({
        id: item.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        artifactId,
        quantity: qty,
        foundAt: item.foundAt || new Date().toISOString(),
        source: item.source || 'grant',
        planetName: item.planetName || null,
    });
}

function removeInventoryItems(inventory, removals) {
    for (const rem of removals || []) {
        let qty = Math.max(1, Math.floor(Number(rem.quantity) || 1));
        if (rem.id) {
            const idx = inventory.findIndex((i) => String(i.id) === String(rem.id));
            if (idx < 0) continue;
            const have = Math.max(1, inventory[idx].quantity || 1);
            if (have > qty) inventory[idx].quantity = have - qty;
            else inventory.splice(idx, 1);
            continue;
        }
        if (!rem.artifactId) continue;
        for (let i = inventory.length - 1; i >= 0 && qty > 0; i--) {
            if (inventory[i].artifactId !== rem.artifactId) continue;
            const have = Math.max(1, inventory[i].quantity || 1);
            if (have > qty) {
                inventory[i].quantity = have - qty;
                qty = 0;
            } else {
                qty -= have;
                inventory.splice(i, 1);
            }
        }
    }
}

// Per-call caps by reason — stops forged "grant me 1e9" while allowing gameplay.
const GRANT_LIMITS = {
    combat: {
        resources: { metal: 250000, he3: 100000, food: 100000, credits: 250000, researchPoints: 500 },
        horizonCoins: 0,
        maxItems: 0,
    },
    boss: {
        resources: { metal: 500000, he3: 200000, food: 200000, credits: 500000, researchPoints: 2000 },
        horizonCoins: 0,
        maxItems: 8,
    },
    search: {
        resources: { metal: 0, he3: 0, food: 50000, credits: 0, researchPoints: 200 },
        horizonCoins: 0,
        maxItems: 3,
    },
    craft: {
        resources: { metal: 0, he3: 0, food: 0, credits: 0, researchPoints: 0 },
        horizonCoins: 0,
        maxItems: 5,
    },
    sell: {
        resources: { metal: 0, he3: 0, food: 0, credits: 5_000_000, researchPoints: 0 },
        horizonCoins: 0,
        maxItems: 0,
    },
    mission: {
        resources: { metal: 100000, he3: 50000, food: 50000, credits: 100000, researchPoints: 500 },
        horizonCoins: 500,
        maxItems: 3,
    },
    alien: {
        resources: { metal: 100000, he3: 50000, food: 50000, credits: 100000, researchPoints: 200 },
        horizonCoins: 0,
        maxItems: 5,
    },
    refund: {
        resources: { metal: MAX_RESOURCE, he3: MAX_RESOURCE, food: MAX_RESOURCE, credits: MAX_RESOURCE, researchPoints: MAX_RESOURCE },
        horizonCoins: MAX_RESOURCE,
        maxItems: 20,
    },
    admin: {
        resources: { metal: MAX_RESOURCE, he3: MAX_RESOURCE, food: MAX_RESOURCE, credits: MAX_RESOURCE, researchPoints: MAX_RESOURCE },
        horizonCoins: MAX_RESOURCE,
        maxItems: 50,
    },
};

function clampGrant(reason, gains, items, isAdmin) {
    if ((reason === 'admin' || reason === 'refund') && !isAdmin) {
        return { error: 'Admin only.' };
    }
    const key = GRANT_LIMITS[reason] ? reason : null;
    if (!key) return { error: 'Invalid grant reason.' };
    const lim = GRANT_LIMITS[key];
    const resources = {};
    for (const k of RESOURCE_KEYS) {
        const want = Math.max(0, Math.floor(Number(gains?.resources?.[k]) || 0));
        const cap = lim.resources[k] != null ? lim.resources[k] : 0;
        resources[k] = Math.min(want, cap);
    }
    const horizonCoins = Math.min(
        Math.max(0, Math.floor(Number(gains?.horizonCoins) || 0)),
        lim.horizonCoins || 0
    );
    const inventoryAdd = Array.isArray(items) ? items.slice(0, lim.maxItems || 0) : [];
    return { resources, horizonCoins, inventoryAdd };
}

module.exports = {
    RESOURCE_KEYS,
    MAX_RESOURCE,
    MAX_OFFLINE_MS,
    readHc,
    normalizeResources,
    normalizeInventory,
    normalizeState,
    economySnapshot,
    computeCollectDelta,
    applyDelta,
    canAfford,
    applySpend,
    addInventoryItem,
    removeInventoryItems,
    clampGrant,
    GRANT_LIMITS,
};
