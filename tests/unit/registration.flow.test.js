import { describe, it, expect, jest, beforeEach } from '@jest/globals';

process.env.JWT_SECRET = 'j'.repeat(48);
process.env.ENCRYPTION_SECRET_KEY =
  'a3f1c9d27b6e48501d9e2c7f84ab3605e1d7c2f9b8a40361dc5e7f2a9b1c4d68';
process.env.SUPER_ADMIN_EMAIL = 'admin@platform.test';

// ---- In-memory stand-in for Upstash (SET NX/EX, GET with JSON auto-parse, INCR, DEL)
const store = new Map();
const fakeRedis = {
  async get(key) {
    if (!store.has(key)) return null;
    const value = store.get(key);
    if (typeof value === 'string') {
      try {
        return JSON.parse(value); // Upstash deserializes JSON automatically
      } catch {
        return value;
      }
    }
    return value;
  },
  async set(key, value, opts = {}) {
    if (opts.nx && store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  },
  async incr(key) {
    const next = Number(store.get(key) || 0) + 1;
    store.set(key, next);
    return next;
  },
  async del(key) {
    store.delete(key);
    return 1;
  },
};

const sendAdmin = jest.fn(async () => {});
const sendHotelier = jest.fn(async () => {});
const userCreate = jest.fn(async ([doc]) => [{ _id: 'u1', ...doc }]);
const hotelCreate = jest.fn(async ([doc]) => [{ _id: 'h1', ...doc }]);

const query = (value) => ({ lean: async () => value, session: async () => value });

jest.unstable_mockModule('../../src/config/redis.js', () => ({ default: fakeRedis }));
jest.unstable_mockModule('../../src/services/notification.service.js', () => ({
  sendSuperAdminRegistrationOtp: sendAdmin,
  sendHotelierRegistrationOtp: sendHotelier,
}));
jest.unstable_mockModule('../../src/models/User.js', () => ({
  default: { findOne: jest.fn(() => query(null)), create: userCreate },
}));
jest.unstable_mockModule('../../src/models/Hotel.js', () => ({
  default: { findOne: jest.fn(() => query(null)), create: hotelCreate },
}));
jest.unstable_mockModule('mongoose', () => ({
  default: {
    startSession: async () => ({
      withTransaction: async (cb) => cb(),
      endSession: async () => {},
    }),
  },
}));

const {
  initiateRegistration,
  verifySuperAdminOtp,
  verifyHotelierOtpAndComplete,
  resendRegistrationOtp,
} = await import('../../src/controllers/hotelier/auth.controller.js');

// ---- helpers
function call(handler, body) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    Promise.resolve(handler({ body }, res, reject)).catch(reject);
  });
}

const signup = {
  name: 'Vikram Sharma',
  email: 'Vikram@Example.com',
  password: 'S3cret-passw0rd',
  hotelName: 'Sea Breeze Resort',
  hotelSlug: 'sea-breeze',
  phone: '+919876543210',
};

async function startRegistration(overrides = {}) {
  const { body } = await call(initiateRegistration, { ...signup, ...overrides });
  return body.registrationId;
}

const lastAdminOtp = () => sendAdmin.mock.calls.at(-1)[0].otp;
const lastHotelierOtp = () => sendHotelier.mock.calls.at(-1)[0].otp;

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

describe('registration: initiate', () => {
  it('never stores the plaintext password in Redis', async () => {
    const id = await startRegistration();
    const saved = JSON.stringify(await fakeRedis.get(`reg:session:${id}`));

    expect(saved).not.toContain(signup.password);
    expect(saved).toContain('passwordEncrypted');
    expect(sendAdmin).toHaveBeenCalledTimes(1);
  });

  it('throttles repeated initiates for the same email (admin inbox protection)', async () => {
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await call(initiateRegistration, signup);
    }
    expect(last.status).toBe(429);
    expect(sendAdmin).toHaveBeenCalledTimes(5);
  });

  it('reports a clear error and leaves nothing behind when the email cannot be sent', async () => {
    sendAdmin.mockRejectedValueOnce(new Error('resend down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const { status, body } = await call(initiateRegistration, signup);

    expect(status).toBe(502);
    expect(body.success).toBe(false);
    expect([...store.keys()].some((k) => k.startsWith('reg:session:'))).toBe(false);
  });

  it('rejects operator objects and short passwords', async () => {
    expect((await call(initiateRegistration, { ...signup, email: { $ne: null } })).status).toBe(400);
    expect((await call(initiateRegistration, { ...signup, password: 'short' })).status).toBe(400);
  });
});

describe('registration: OTP guessing protection', () => {
  it('destroys the registration after too many wrong approval codes', async () => {
    const id = await startRegistration();
    const wrong = lastAdminOtp() === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      const attempt = await call(verifySuperAdminOtp, { registrationId: id, otp: wrong });
      expect(attempt.status).toBe(403);
    }
    const sixth = await call(verifySuperAdminOtp, { registrationId: id, otp: wrong });
    expect(sixth.status).toBe(429);
    expect(sixth.body.sessionClosed).toBe(true);

    // Even the CORRECT code no longer works: the session is gone
    const afterwards = await call(verifySuperAdminOtp, { registrationId: id, otp: lastAdminOtp() });
    expect(afterwards.status).toBe(410);
  });

  it('does not let the hotelier step run before the admin approved', async () => {
    const id = await startRegistration();
    const { status } = await call(verifyHotelierOtpAndComplete, { registrationId: id, otp: '123456' });
    expect(status).toBe(403);
    expect(userCreate).not.toHaveBeenCalled();
  });
});

describe('registration: resend', () => {
  it('enforces the cooldown on the server', async () => {
    const id = await startRegistration();
    const { status } = await call(resendRegistrationOtp, { registrationId: id });
    expect(status).toBe(429); // cooldown started when the first code was sent
    expect(sendAdmin).toHaveBeenCalledTimes(1);
  });

  it('cancels the registration after too many resends', async () => {
    const id = await startRegistration();
    let result;
    for (let i = 0; i < 4; i += 1) {
      store.delete(`reg:cooldown:${id}`); // simulate waiting out the cooldown
      result = await call(resendRegistrationOtp, { registrationId: id });
    }
    expect(result.status).toBe(429);
    expect(result.body.sessionClosed).toBe(true);
  });
});

describe('registration: full happy path', () => {
  it('creates the hotel and user with the ORIGINAL password and a normalized email', async () => {
    const id = await startRegistration();

    const approve = await call(verifySuperAdminOtp, { registrationId: id, otp: lastAdminOtp() });
    expect(approve.status).toBe(200);
    expect(sendHotelier).toHaveBeenCalledTimes(1);

    const wrong = await call(verifyHotelierOtpAndComplete, { registrationId: id, otp: '000000' === lastHotelierOtp() ? '111111' : '000000' });
    expect(wrong.status).toBe(403);

    const done = await call(verifyHotelierOtpAndComplete, { registrationId: id, otp: lastHotelierOtp() });
    expect(done.status).toBe(201);
    expect(done.body.token).toEqual(expect.any(String));

    const createdUser = userCreate.mock.calls[0][0][0];
    expect(createdUser.password).toBe(signup.password); // decrypted, not the ciphertext
    expect(createdUser.email).toBe('vikram@example.com');
    expect(createdUser.role).toBe('HOTELIER');

    // Session and counters are wiped; the same code cannot be replayed
    expect([...store.keys()].filter((k) => k.includes(id))).toHaveLength(0);
    const replay = await call(verifyHotelierOtpAndComplete, { registrationId: id, otp: lastHotelierOtp() });
    expect(replay.status).toBe(410);
    expect(userCreate).toHaveBeenCalledTimes(1);
  });
});
