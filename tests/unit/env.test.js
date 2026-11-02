import { describe, it, expect, afterEach } from '@jest/globals';
import { validateEnv } from '../../src/config/env.js';

const SNAPSHOT = { ...process.env };

function setEnv(values) {
  for (const key of ['MONGODB_URI', 'JWT_SECRET', 'ENCRYPTION_SECRET_KEY', 'ENCRYPTION_KEY', 'NODE_ENV']) {
    delete process.env[key];
  }
  Object.assign(process.env, values);
}

describe('validateEnv', () => {
  afterEach(() => {
    process.env = { ...SNAPSHOT };
  });

  it('passes with a complete development configuration', () => {
    setEnv({
      MONGODB_URI: 'mongodb://localhost/test',
      JWT_SECRET: 'x'.repeat(48),
      ENCRYPTION_SECRET_KEY: 'a3f1c9d27b6e48501d9e2c7f84ab3605e1d7c2f9b8a40361dc5e7f2a9b1c4d68',
      NODE_ENV: 'development',
    });
    expect(() => validateEnv()).not.toThrow();
  });

  it('lists every problem in one error', () => {
    setEnv({ JWT_SECRET: 'short', NODE_ENV: 'development' });

    expect(() => validateEnv()).toThrow(/MONGODB_URI[\s\S]*JWT_SECRET[\s\S]*ENCRYPTION_SECRET_KEY/);
  });

  it('requires Redis, email and URL settings in production', () => {
    setEnv({
      MONGODB_URI: 'mongodb://localhost/test',
      JWT_SECRET: 'x'.repeat(48),
      ENCRYPTION_SECRET_KEY: 'a3f1c9d27b6e48501d9e2c7f84ab3605e1d7c2f9b8a40361dc5e7f2a9b1c4d68',
      NODE_ENV: 'production',
    });
    for (const name of [
      'MASTER_RAZORPAY_KEY_ID', 'MASTER_RAZORPAY_KEY_SECRET', 'MASTER_RAZORPAY_WEBHOOK_SECRET',
      'ALLOWED_ORIGINS', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
      'SUPER_ADMIN_EMAIL', 'RESEND_API_KEY', 'EMAIL_FROM', 'CLIENT_BASE_URL',
    ]) {
      delete process.env[name];
    }

    expect(() => validateEnv()).toThrow(/UPSTASH_REDIS_REST_URL[\s\S]*SUPER_ADMIN_EMAIL[\s\S]*RESEND_API_KEY[\s\S]*CLIENT_BASE_URL/);
  });
});
