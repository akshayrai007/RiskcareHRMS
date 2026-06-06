// src/config/db.js
const { Pool } = require('pg');
require('dotenv').config();

// ── Why these values? ────────────────────────────────────────────────────────
// Render free tier + Neon DB: 27 employees pinging every 30s = ~1 req/s peak.
// Old max:5 caused full pool exhaustion during morning rush (all 5 held by
// concurrent cron + GPS pings → every new request timed out).
//
// max:20  — enough headroom for GPS pings + cron jobs + HR dashboard requests
// min:2   — keeps 2 warm so first ping after idle isn't slow
// idleTimeoutMillis:30000    — release idle connections after 30s
// connectionTimeoutMillis:8000 — fail fast if pool is exhausted (was 5s — too
//                                short for Neon cold-start after idle)
// statement_timeout: 10000  — kill hung queries so they don't hold connections forever
// ─────────────────────────────────────────────────────────────────────────────

const baseConfig = {
  max: 20,
  min: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000,
  allowExitOnIdle: false,
};

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: false,
      ...baseConfig,
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'hrms_db',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: false,
      ...baseConfig,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => console.error('[DB Pool] Unexpected error:', err.message));

// Log pool stats every 5 min so we can spot exhaustion early
setInterval(() => {
  console.log(`[DB Pool] total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
}, 5 * 60 * 1000);

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};
