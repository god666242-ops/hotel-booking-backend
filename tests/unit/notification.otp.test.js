import { describe, it, expect, jest, afterEach } from '@jest/globals';
import {
  sendHotelierRegistrationOtp,
  sendSuperAdminRegistrationOtp,
} from '../../src/services/notification.service.js';

const SNAPSHOT = { ...process.env };
const args = {
  to: 'owner@example.com',
  superAdminEmail: 'admin@platform.test',
  managerName: 'Owner',
  hotelName: 'Sea Breeze',
  hotelSlug: 'sea-breeze',
  email: 'owner@example.com',
  phone: '+919876543210',
  otp: '482913',
};

describe('registration OTP emails', () => {
  afterEach(() => {
    process.env = { ...SNAPSHOT };
    jest.restoreAllMocks();
    delete global.fetch;
  });

  it('fails loudly in production when email is not configured (no silent lost codes)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.RESEND_API_KEY;
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sendHotelierRegistrationOtp(args)).rejects.toThrow(/RESEND_API_KEY/);
    await expect(sendSuperAdminRegistrationOtp(args)).rejects.toThrow(/RESEND_API_KEY/);
  });

  it('prints the code in local development so signup can still be tested', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.RESEND_API_KEY;
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(sendHotelierRegistrationOtp(args)).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join(' ')).toContain('482913');
  });

  it('throws when Resend rejects the message', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 're_test';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ message: 'domain not verified' }),
    }));

    await expect(sendHotelierRegistrationOtp(args)).rejects.toThrow(/domain not verified/);
  });

  it('succeeds when Resend accepts the message', async () => {
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 're_test';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 'em_1' }) }));

    await expect(sendHotelierRegistrationOtp(args)).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
