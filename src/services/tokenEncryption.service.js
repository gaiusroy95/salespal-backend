'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/**
 * Returns the 32-byte encryption key derived from process.env.ENCRYPTION_KEY.
 * Throws if the env var is missing or not a valid 64-character hex string (32 bytes).
 */
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is missing. ' +
        'It must be set to a 64-character hex string (32 bytes).'
    );
  }
  if (hex.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be a 64-character hex string (32 bytes), but got length ${hex.length}.`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * @param {string} plaintext - The string to encrypt.
 * @returns {string} Hex-encoded string in the format: iv:authTag:encryptedData
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

/**
 * Decrypts a ciphertext string produced by {@link encrypt}.
 *
 * @param {string} ciphertext - Hex-encoded string in the format: iv:authTag:encryptedData
 * @returns {string} The original plaintext string.
 */
function decrypt(ciphertext) {
  const key = getKey();

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error(
      'Invalid ciphertext format. Expected "iv:authTag:encryptedData" (colon-separated hex strings).'
    );
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encryptedData = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };

// ---------------------------------------------------------------------------
// Round-trip test (commented out) — uncomment and run with node to verify:
//
// process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
// const { encrypt, decrypt } = require('./tokenEncryption.service');
// const original = 'test-token-value';
// const ciphertext = encrypt(original);
// const recovered  = decrypt(ciphertext);
// console.assert(recovered === original, `Round-trip FAILED: expected "${original}", got "${recovered}"`);
// console.log(`Round-trip PASSED: "${original}" → "${ciphertext}" → "${recovered}"`);
// ---------------------------------------------------------------------------
