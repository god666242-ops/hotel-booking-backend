import { describe, it, expect, jest } from '@jest/globals';
import { authorizeRoles } from '../../src/middlewares/auth.middleware.js';

function run(role) {
  const guard = authorizeRoles('HOTELIER', 'SUPER_ADMIN');
  const req = role === undefined ? {} : { user: { role } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  guard(req, res, next);
  return { res, next };
}

describe('authorizeRoles', () => {
  it('calls next() exactly once for an allowed role (regression: it used to hang)', () => {
    const { res, next } = run('HOTELIER');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('responds 403 and does not continue for STAFF', () => {
    const { res, next } = run('STAFF');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 403 when there is no authenticated user', () => {
    const { res, next } = run(undefined);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
