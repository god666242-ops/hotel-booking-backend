import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import crypto from 'crypto';
import { encryptSecret, decryptSecret } from '../../src/services/crypto.service.js';

const TEST_KEY = 'a3f1c9d27b6e48501d9e2c7f84ab3605e1d7c2f9b8a40361dc5e7f2a9b1c4d68';
const EXAMPLE_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Crypto Service - AES-256 Key Encryption', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    delete process.env.ENCRYPTION_SECRET_KEY;
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should encrypt and decrypt BYO Razorpay Secret without corruption', () => {
    const rawSecret = 'rzp_live_sec_ABCXYZ9876543210!@#$';

    const encrypted = encryptSecret(rawSecret);
    expect(encrypted).not.toBe(rawSecret);
    expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:data (GCM)

    expect(decryptSecret(encrypted)).toBe(rawSecret);
  });

  it('should handle null or empty values gracefully', () => {
    expect(encryptSecret(null)).toBeNull();
    expect(decryptSecret(null)).toBeNull();
  });

  it('still decrypts legacy AES-256-CBC values written before the GCM upgrade', () => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEST_KEY, 'hex'), iv);
    const legacy = `${iv.toString('hex')}:${cipher.update('legacy-secret', 'utf8', 'hex') + cipher.final('hex')}`;

    expect(decryptSecret(legacy)).toBe('legacy-secret');
  });

  it('detects tampering (GCM authentication)', () => {
    const [iv, tag, data] = encryptSecret('top-secret').split(':');
    const flipped = (data[0] === '0' ? '1' : '0') + data.slice(1);

    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('refuses the public example key in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_KEY = EXAMPLE_KEY;

    expect(() => encryptSecret('x')).toThrow(/example value/);
  });

  it('rejects a key of the wrong length with a clear message', () => {
    process.env.ENCRYPTION_KEY = 'too-short';

    expect(() => encryptSecret('x')).toThrow(/64-character hex/);
  });
});
