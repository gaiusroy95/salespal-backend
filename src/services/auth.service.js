const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const { OAuth2Client } = require('google-auth-library');

const googleClient = new OAuth2Client(env.google.clientId || undefined);

// ─── Password helpers ─────────────────────────────────────────────────────────

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, env.bcryptSaltRounds);
}

async function comparePassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

// ─── Token helpers ────────────────────────────────────────────────────────────

function generateAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessTTL }
  );
}

async function generateRefreshToken(userId) {
  const token = crypto.randomBytes(64).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + env.jwt.refreshTTL * 1000);

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );

  return { token, expiresAt };
}

async function validateRefreshToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows } = await db.query(
    `SELECT id, user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.revoked) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

async function revokeRefreshToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(
    `UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`,
    [tokenHash]
  );
}

async function revokeAllRefreshTokens(userId) {
  await db.query(
    `UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`,
    [userId]
  );
}

async function cleanupExpiredTokens() {
  const { rowCount } = await db.query(
    `DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = true`
  );
  logger.info(`Cleaned up ${rowCount} expired/revoked refresh tokens`);
}

// ─── Registration ─────────────────────────────────────────────────────────────

async function registerUser({ email, password, fullName }) {
  const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existing.rows.length > 0) {
    const err = new Error('Email already registered');
    err.statusCode = 409;
    err.code = 'CONFLICT';
    throw err;
  }

  const passwordHash = await hashPassword(password);

  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1, $2, $3, 'user')
     RETURNING id, email, full_name, role, created_at`,
    [email, passwordHash, fullName || null]
  );
  const user = rows[0];

  // Create default organization
  const baseSlug = (fullName || email.split('@')[0])
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
  const slug = `${baseSlug}-${Date.now()}`;

  const orgResult = await db.query(
    `INSERT INTO organizations (name, slug, owner_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${fullName || email}'s Workspace`, slug, user.id]
  );
  const org = orgResult.rows[0];

  await db.query(
    `INSERT INTO org_members (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
    [user.id, org.id]
  );

  // Seed 100 free credits
  await db.query(
    `INSERT INTO marketing_credits (org_id, balance)
     VALUES ($1, 100)
     ON CONFLICT (org_id) DO NOTHING`,
    [org.id]
  );

  const accessToken = generateAccessToken(user);
  const { token: refreshToken } = await generateRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}

// ─── Email verification ───────────────────────────────────────────────────────

async function verifyEmailToken(token) {
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    await db.query(`UPDATE users SET email_verified = true WHERE id = $1`, [decoded.sub]);
  } catch {
    const err = new Error('Invalid or expired verification token');
    err.statusCode = 400;
    err.code = 'INVALID_TOKEN';
    throw err;
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function loginUser({ email, password }) {
  const { rows } = await db.query(
    `SELECT id, email, password_hash, full_name, role, avatar_url FROM users WHERE email = $1`,
    [email]
  );
  const user = rows[0];

  if (!user) {
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    const err = new Error('Invalid email or password');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const accessToken = generateAccessToken(user);
  const { token: refreshToken } = await generateRefreshToken(user.id);

  delete user.password_hash;
  return { user, accessToken, refreshToken };
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshAccessToken(token) {
  const tokenRow = await validateRefreshToken(token);
  if (!tokenRow) {
    const err = new Error('Invalid or expired refresh token');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  const { rows } = await db.query(
    `SELECT id, email, role FROM users WHERE id = $1`,
    [tokenRow.user_id]
  );
  const user = rows[0];
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  // Rotate: revoke old, issue new
  await revokeRefreshToken(token);
  const { token: newRefreshToken } = await generateRefreshToken(user.id);
  const accessToken = generateAccessToken(user);

  return { accessToken, refreshToken: newRefreshToken };
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

async function googleLogin(idToken) {
  try {
    if (!env.google.clientId) {
      const err = new Error('Google OAuth not configured');
      err.statusCode = 501;
      err.code = 'NOT_CONFIGURED';
      throw err;
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.google.clientId,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

    // Look up existing user
    let { rows } = await db.query(
      `SELECT id, email, full_name, role, avatar_url, email_verified
       FROM users WHERE email = $1`,
      [email]
    );
    let user = rows[0];

    if (!user) {
      // New user via Google
      const result = await db.query(
        `INSERT INTO users (email, full_name, avatar_url, google_id, role, email_verified)
         VALUES ($1, $2, $3, $4, 'user', true)
         RETURNING id, email, full_name, role, avatar_url`,
        [email, name || email, picture || null, googleId]
      );
      user = result.rows[0];
      logger.info(`New user registered via Google: ${email}`);

      // Create default org
      const baseSlug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
      const slug = `${baseSlug}-${Date.now()}`;
      const orgResult = await db.query(
        `INSERT INTO organizations (name, slug, owner_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [`${name || email}'s Workspace`, slug, user.id]
      );
      const org = orgResult.rows[0];

      await db.query(
        `INSERT INTO org_members (user_id, org_id, role) VALUES ($1, $2, 'owner')`,
        [user.id, org.id]
      );

      await db.query(
        `INSERT INTO marketing_credits (org_id, balance)
         VALUES ($1, 100) ON CONFLICT (org_id) DO NOTHING`,
        [org.id]
      );
    } else {
      // Existing user — sync profile
      if (!user.email_verified) {
        await db.query(`UPDATE users SET email_verified = true WHERE id = $1`, [user.id]);
        user.email_verified = true;
      }
      if (picture && user.avatar_url !== picture) {
        await db.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [picture, user.id]);
        user.avatar_url = picture;
      }
    }

    const accessToken = generateAccessToken(user);
    const { token: refreshToken } = await generateRefreshToken(user.id);

    delete user.password_hash;
    return { user, accessToken, refreshToken };
  } catch (error) {
    if (error.code === 'NOT_CONFIGURED') throw error;
    logger.error(`Google login failed: ${error.message}`);
    const err = new Error('Failed to authenticate with Google');
    err.statusCode = 401;
    err.code = 'UNAUTHORIZED';
    throw err;
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  cleanupExpiredTokens,
  registerUser,
  verifyEmailToken,
  loginUser,
  refreshAccessToken,
  googleLogin,
};
