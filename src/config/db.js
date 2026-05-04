const { Pool } = require('pg');

// ─── Build pool config ────────────────────────────────────────────────────────
// Supports:
//   1. DATABASE_URL — recommended (Neon, Render Postgres, Railway, etc.)
//   2. Individual DB_* TCP fields, or DB_HOST as Unix socket path (legacy Cloud SQL)
function buildPoolConfig() {
  const {
    DATABASE_URL,
    DB_HOST,
    DB_PORT = '5432',
    DB_USER,
    DB_PASSWORD,
    DB_NAME,
    NODE_ENV,
  } = process.env;

  const base = {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  // Unix socket (Cloud SQL on Cloud Run)
  if (DB_HOST && DB_HOST.startsWith('/')) {
    return {
      ...base,
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      ssl: false,
    };
  }

  // Standard TCP connection
  if (DATABASE_URL) {
    return {
      ...base,
      connectionString: DATABASE_URL,
      ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    };
  }

  // Fallback: individual TCP components
  return {
    ...base,
    host: DB_HOST || 'localhost',
    port: parseInt(DB_PORT, 10),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  };
}

const pool = new Pool(buildPoolConfig());

pool.on('connect', () => {
  console.log('[db] PostgreSQL pool connected');
});

pool.on('error', (err) => {
  console.error('[db] PostgreSQL pool error:', err.message);
});

// ─── Query helper ─────────────────────────────────────────────────────────────
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ─── Transaction helper ───────────────────────────────────────────────────────
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Get raw client (for migrate.js) ─────────────────────────────────────────
async function getClient() {
  return pool.connect();
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
async function close() {
  await pool.end();
}

module.exports = { pool, query, transaction, getClient, close };
