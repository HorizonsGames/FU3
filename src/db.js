const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
    throw new Error(
        'DATABASE_URL is not set. Locally: copy .env.example to .env and fill it in. ' +
        'On Heroku: run `heroku addons:create heroku-postgresql:essential-0` — it sets this for you.'
    );
}

// Heroku Postgres requires SSL, but its cert chain isn't in Node's default trust
// store, so we disable strict verification for that connection specifically.
const useSSL = /\.amazonaws\.com|herokuapp|heroku-postgres/.test(process.env.DATABASE_URL)
    || process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('[db] schema ready');
}

module.exports = {
    pool,
    query: (text, params) => pool.query(text, params),
    initSchema,
};
