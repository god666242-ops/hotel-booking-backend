import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import crypto from 'crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import app from '../../src/app.js';

describe('Razorpay Webhook Handler', () => {
  let mongoServer;
  const masterSecret = 'test_webhook_secret_key_123';

  beforeAll(async () => {
    process.env.MASTER_RAZORPAY_WEBHOOK_SECRET = masterSecret;
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('should reject webhooks with an invalid HMAC signature', async () => {
    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_9999999',
            order_id: 'order_9999999',
          },
        },
      },
    };

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('x-razorpay-signature', 'invalid_signature_hash')
      .send(payload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('should accept valid HMAC-SHA256 signature calculated from raw payload', async () => {
    const payload = JSON.stringify({
      event: 'unknown.event',
      payload: {},
    });

    const validSignature = crypto
      .createHmac('sha256', masterSecret)
      .update(Buffer.from(payload))
      .digest('hex');

    const res = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', validSignature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});