// backend/src/config/redis.js
import { Redis } from "@upstash/redis";

let redisClient = null;

export function getRedisClient() {
  if (!redisClient) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      console.warn(
        "[Redis Warning] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is missing.",
      );
      return null;
    }

    try {
      redisClient = new Redis({
        url,
        token,
      });
      console.log("[Redis] Upstash REST client initialized successfully.");
    } catch (err) {
      console.error(
        "[Redis Error] Failed to initialize Upstash Redis:",
        err.message,
      );
      return null;
    }
  }

  return redisClient;
}

// Proxy wrapper so imports like `redis.get()` or `redis.set()` work seamlessly
const redis = new Proxy(
  {},
  {
    get(_target, prop) {
      // Promise machinery / inspection probe `then` and symbols; never throw for those.
      if (prop === "then" || typeof prop === "symbol") return undefined;
      const client = getRedisClient();
      if (!client) {
        throw new Error("Redis client is not configured or failed to initialize.");
      }
      const val = client[prop];
      return typeof val === "function" ? val.bind(client) : val;
    },
  }
);

export default redis;