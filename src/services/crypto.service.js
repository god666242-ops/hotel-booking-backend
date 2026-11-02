import crypto from 'crypto';

const CBC_ALGORITHM = 'aes-256-cbc';
const GCM_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12;

// Values copied from documentation / .env.example must never protect real secrets.
const KNOWN_EXAMPLE_KEYS = [
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
];

function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_SECRET_KEY || process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_SECRET_KEY environment variable is not defined.');
  }
  const clean = raw.trim();
  if (process.env.NODE_ENV === "production" && KNOWN_EXAMPLE_KEYS.includes(clean)) {
    throw new Error(
      "ENCRYPTION_SECRET_KEY is still set to the public example value. Generate a new one with: openssl rand -hex 32",
    );
  }
  if (clean.length === 64) {
    return Buffer.from(clean, 'hex');
  }
  if (clean.length === 32) {
    return Buffer.from(clean, 'utf8');
  }
  throw new Error('ENCRYPTION_SECRET_KEY must be a 64-character hex string or 32-character UTF-8 string.');
}

/**
 * Encrypts plain text using authenticated AES-256-GCM.
 * Output format: "ivHex:authTagHex:encryptedHex"
 */
export function encryptSecret(plainText) {
  if (!plainText) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(GCM_ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts secret payloads, automatically supporting legacy AES-256-CBC
 * (2 parts) and modern authenticated AES-256-GCM (3 parts).
 */
export function decryptSecret(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.includes(':')) {
    return null;
  }

  const key = getEncryptionKey();
  const parts = cipherText.split(':');

  // Modern AES-256-GCM format (3 parts: iv:tag:data)
  if (parts.length === 3) {
    const [ivHex, tagHex, encryptedHex] = parts;
    const decipher = crypto.createDecipheriv(GCM_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // Legacy AES-256-CBC format (2 parts: iv:data)
  if (parts.length === 2) {
    const [ivHex, encryptedHex] = parts;
    const decipher = crypto.createDecipheriv(CBC_ALGORITHM, key, Buffer.from(ivHex, 'hex'));

    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  throw new Error('Unrecognized ciphertext format.');
}