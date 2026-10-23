// Minimal in-memory rate limiter — no extra dependency needed for this.
// Lives in the same process as room state (src/ws/hub.js), so the same
// single-dyno caveat applies: fine for one Heroku dyno, would need a shared
// store (e.g. Heroku Redis) to stay accurate across multiple dynos.
//
// Usage: app.post('/api/auth/login', rateLimit({ windowMs: 60_000, max: 8 }), handler)

const buckets = new Map(); // key -> { count, resetAt }

function rateLimit({ windowMs = 60_000, max = 10, keyFn } = {}) {
    return (req, res, next) => {
        const key = (keyFn ? keyFn(req) : req.ip) || 'unknown';
        const now = Date.now();
        let bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
        }

        bucket.count += 1;

        if (bucket.count > max) {
            const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                error: `Too many attempts. Please try again in ${retryAfterSec}s.`,
            });
        }

        next();
    };
}

// Periodic cleanup so `buckets` doesn't grow unbounded over a long-running process.
setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}, 5 * 60_000).unref();

module.exports = { rateLimit };
