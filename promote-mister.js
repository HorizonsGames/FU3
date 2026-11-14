// One-shot: promote/create the mister admin without resetting an unknown password.
// Usage: heroku run node promote-mister.js -a fractured-universe-backend
require('dotenv').config();
const crypto = require('crypto');
const db = require('./src/db');
const auth = require('./src/auth');

const USERNAME = 'mister';
const EMAIL = process.env.ADMIN_EMAIL || 'mrinfinite@gmail.com';
const PASSWORD = process.env.ADMIN_PASSWORD || null;

async function main() {
    await db.initSchema();
    const { rows } = await db.query(
        'SELECT id, username, email, account_type FROM players WHERE LOWER(username) = LOWER($1)',
        [USERNAME]
    );

    if (rows.length) {
        await db.query(
            `UPDATE players
             SET account_type = 'admin',
                 email = COALESCE($1, email)
             WHERE LOWER(username) = LOWER($2)`,
            [EMAIL, USERNAME]
        );
        console.log(`Promoted existing "${rows[0].username}" to admin (email=${EMAIL}).`);
        console.log(JSON.stringify({ before: rows[0], after: { account_type: 'admin', email: EMAIL } }, null, 2));
    } else {
        if (!PASSWORD || String(PASSWORD).length < 8) {
            console.error('No mister account found. Set ADMIN_PASSWORD (8+ chars) to create one.');
            process.exit(1);
        }
        const id = crypto.randomUUID();
        const passwordHash = await auth.hashPassword(PASSWORD);
        await db.query(
            `INSERT INTO players (id, username, email, password_hash, account_type)
             VALUES ($1, $2, $3, $4, 'admin')`,
            [id, USERNAME, EMAIL, passwordHash]
        );
        console.log(`Created admin account "${USERNAME}" <${EMAIL}>.`);
    }

    const { rows: all } = await db.query(
        'SELECT username, email, account_type, horizon_coins FROM players ORDER BY username'
    );
    console.log('Players:', JSON.stringify(all, null, 2));
    await db.pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
