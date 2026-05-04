require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../config/db');
const logger = require('../config/logger');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

async function runMigrations() {
  const client = await pool.connect();

  try {
    // Ensure migration_history table exists (runs 021 if needed)
    await client.query(`
      CREATE TABLE IF NOT EXISTS migration_history (
        id SERIAL PRIMARY KEY,
        migration_file VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW(),
        checksum TEXT
      )
    `);

    // Read all .sql files in numeric order
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    logger.info(`Found ${files.length} migration files`);

    for (const file of files) {
      // Skip tracking migrations themselves if already done
      if (file === '021_init_migrations.sql' || file === '022_mark_applied.sql') {
        logger.info(`Skipping tracking migration: ${file}`);
        continue;
      }

      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('md5').update(sql).digest('hex');

      // Check if already applied
      const checkRes = await client.query(
        'SELECT checksum FROM migration_history WHERE migration_file = $1',
        [file]
      );

      if (checkRes.rows.length > 0) {
        if (checkRes.rows[0].checksum === checksum) {
          logger.info(`Already applied: ${file}`);
          continue;
        } else {
          throw new Error(`Migration ${file} checksum mismatch - schema drift detected`);
        }
      }

      logger.info(`Running migration: ${file}`);
      await client.query(sql);

      // Mark as applied
      await client.query(
        `INSERT INTO migration_history (migration_file, checksum) VALUES ($1, $2)`,
        [file, checksum]
      );
      logger.info(`Completed & recorded: ${file}`);
    }

    logger.info('All pending migrations completed successfully');
  } catch (err) {
    logger.error(`Migration failed: ${err.message}`, { stack: err.stack });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
