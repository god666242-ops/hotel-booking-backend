import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { errorHandler } from '../../src/middlewares/errorHandler.middleware.js';

function call(err) {
  const res = {
    statusCode: 200,
    headersSent: false,
    status: jest.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    json: jest.fn().mockReturnThis(),
  };
  jest.spyOn(console, 'error').mockImplementation(() => {});
  errorHandler(err, {}, res, jest.fn());
  return { res, body: res.json.mock.calls[0][0] };
}

describe('errorHandler', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
    jest.restoreAllMocks();
  });

  it('hides internal messages for 5xx in production', () => {
    process.env.NODE_ENV = 'production';
    const { res, body } = call(new Error('E11000 collection: prod.bookings index: secret_idx'));

    expect(res.statusCode).toBe(500);
    expect(body.message).not.toMatch(/E11000|secret_idx/);
    expect(body.stack).toBeUndefined();
  });

  it('keeps useful messages for client errors and honours err.status', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('Only safe raster images are permitted.');
    err.status = 400;
    const { res, body } = call(err);

    expect(res.statusCode).toBe(400);
    expect(body.message).toBe('Only safe raster images are permitted.');
  });

  it('maps duplicate keys to 409 and cast errors to 400', () => {
    expect(call(Object.assign(new Error('dup'), { code: 11000 })).res.statusCode).toBe(409);
    expect(call(Object.assign(new Error('cast'), { name: 'CastError' })).res.statusCode).toBe(400);
  });
});
