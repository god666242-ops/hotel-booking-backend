import dns from "dns";
import http from "http";
import https from "https";
import net from "net";

/**
 * Fetches a user-supplied URL without letting it reach our own network (SSRF).
 *
 * The address check runs inside the socket's DNS lookup, i.e. on the exact IP
 * that is then connected to, so DNS-rebinding tricks cannot swap in a private IP
 * after validation. Redirects are followed manually and re-checked.
 */

export class UnsafeUrlError extends Error {}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const n = ipv4ToInt(address);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
  }
  return true; // not a valid IP at all: refuse
}

export function assertAllowedUrlShape(urlStr, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new UnsafeUrlError("That is not a valid URL.");
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) {
    throw new UnsafeUrlError("Calendar links must start with https://");
  }
  if (u.username || u.password) throw new UnsafeUrlError("URLs with embedded credentials are not allowed.");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new UnsafeUrlError("That address is not allowed.");
  }
  if (net.isIP(host.replace(/^\[|\]$/g, "")) && isPrivateAddress(host.replace(/^\[|\]$/g, ""))) {
    throw new UnsafeUrlError("That address is not allowed.");
  }
  return u;
}

function guardedLookup(hostname, options, callback) {
  const opts = typeof options === "function" ? {} : options || {};
  const cb = typeof options === "function" ? options : callback;
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    const safe = list.filter((a) => !isPrivateAddress(a.address));
    if (safe.length === 0) return cb(new UnsafeUrlError("That address is not allowed."));
    if (opts.all) return cb(null, safe);
    return cb(null, safe[0].address, safe[0].family);
  });
}

function requestOnce(u, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "GET",
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: { "User-Agent": "HBE-Calendar-Sync/1.0", Accept: "text/calendar, text/plain, */*" },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, u).toString() });
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`The calendar server answered HTTP ${res.statusCode}.`));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error("The calendar file is too large."));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The calendar server took too long to respond.")));
    req.on("error", reject);
    req.end();
  });
}

export async function fetchTextSafe(
  urlStr,
  { timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3, allowHttp = false } = {},
) {
  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = assertAllowedUrlShape(current, { allowHttp });
    const result = await requestOnce(u, { timeoutMs, maxBytes });
    if (result.redirect) {
      current = result.redirect;
      continue;
    }
    return result.body;
  }
  throw new Error("The calendar link redirected too many times.");
}
