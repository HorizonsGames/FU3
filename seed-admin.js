// Creates (or promotes) an admin account. Deliberately NOT an HTTP endpoint —
// admin accounts should never be creatable by anyone who can just call the API.
// Run manually, once, after deploying:
//
//   heroku config:set ADMIN_USERNAME=Mister ADMIN_PASSWORD='...' ADMIN_EMAIL=mister@example.com
//   heroku run node seed-admin.js
//   heroku config:unset ADMIN_USERNAME ADMIN_PASSWORD ADMIN_EMAIL   (afterwards, so it's not left sitting in config)
//
// Locally: same idea, via a .env file or inline env vars, then `node seed-admin.js`.
//
// Credentials are read from the environment on purpose — never hardcode a real
// password into this file, since anything committed to git stays in the repo's
// history forever even if you edit it out later.
require('dotenv').config();
const crypto = require('crypto');
const db = require('./src/db');
const auth = require('./src/auth');

async function main() {
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    const email = process.env.ADMIN_EMAIL || null;

    if (!username || !password) {
        console.error('Set ADMIN_USERNAME and ADMIN_PASSWORD (and optionally ADMIN_EMAIL) before running this script.');
        process.exit(1);
    }
    if (password.length < 8) {
        console.error('ADMIN_PASSWORD must be at least 8 characters.');
        process.exit(1);
    }

    await db.initSchema();
    const passwordHash = await auth.hashPassword(password);

    const { rows: existing } = await db.query('SELECT id FROM players WHERE username = $1', [username]);

    if (existing.length) {
        await db.query(
            `UPDATE players SET password_hash = $1, account_type = 'admin', email = COALESCE($2, email) WHERE username = $3`,
            [passwordHash, email, username]
        );
        console.log(`✅ Updated existing account "${username}": password reset, account_type set to admin.`);
    } else {
        const id = crypto.randomUUID();
        await db.query(
            `INSERT INTO players (id, username, email, password_hash, account_type)
             VALUES ($1, $2, $3, $4, 'admin')`,
            [id, username, email, passwordHash]
        );
        console.log(`✅ Created admin account "${username}".`);
    }

    await db.pool.end();
}

main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
