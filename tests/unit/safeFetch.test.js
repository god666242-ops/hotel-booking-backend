import { describe, it, expect } from '@jest/globals';
import { isPrivateAddress, assertAllowedUrlShape, fetchTextSafe } from '../../src/utils/safeFetch.js';

describe('SSRF protection for calendar links', () => {
  it('recognises private, loopback and cloud-metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });

  it('only allows plain https links to public hosts', () => {
    expect(() => assertAllowedUrlShape('https://example.com/cal.ics')).not.toThrow();
    for (const bad of ['http://example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://u:p@example.com/', 'ftp://x.com/a', 'nonsense']) {
      expect(() => assertAllowedUrlShape(bad)).toThrow();
    }
  });

  it('refuses to connect to internal addresses', async () => {
    await expect(fetchTextSafe('https://169.254.169.254/latest/meta-data')).rejects.toThrow();
  });
});
