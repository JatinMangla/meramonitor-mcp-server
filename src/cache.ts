import { Redis } from '@upstash/redis';
import { hasRedis, type Config } from './config.js';

/**
 * A short-lived read cache for MeraMonitor responses that are expensive to
 * fetch and stable over the life of a conversation.
 *
 * Deliberately separate from OAuthStore rather than sharing its KvBackend.
 * That store is the auth path; a caching change must not be able to reach it.
 * The duplication here is about forty lines and buys that isolation.
 *
 * Three properties every caller depends on:
 *
 *   1. A cache failure is a MISS, never an error. Redis being slow or down
 *      degrades latency, never correctness - every miss falls through to the
 *      real API call the cache was standing in front of.
 *   2. Nothing security-relevant is cached. Tokens, codes and identities stay
 *      in OAuthStore. What lands here is data the caller just proved they are
 *      allowed to read, held for seconds.
 *   3. Keys are scoped to the CALLER, not just the organization - see
 *      rosterKey() in tools/identity.ts. GetAllUserListByOrganization is
 *      authorized by the bearer token, so caching one caller's result under a
 *      bare organization key could serve a fuller roster to someone whose own
 *      request would have returned less. Per-caller keys cost hit rate and
 *      remove that class of bug entirely.
 */
export interface Cache {
  /** True when entries survive across serverless instances. */
  readonly durable: boolean;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/** Default lifetime for cached reads. Long enough to cover one conversation
 *  turn, short enough that a roster change shows up almost immediately. */
export const DEFAULT_CACHE_TTL_SECONDS = 90;

class RedisCache implements Cache {
  readonly durable = true;
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({ url, token, automaticDeserialization: false });
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get<string>(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined; // property 1: a failure is a miss
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), { ex: ttlSeconds });
    } catch {
      // Not being able to record a value is not a reason to fail the request.
    }
  }
}

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Process-local fallback for the self-hosted path and local dev. Module-level
 * so it survives across requests inside one process; on Vercel that means one
 * warm instance, which is why Redis is preferred there.
 */
const processCache = new Map<string, Entry>();

class MemoryCache implements Cache {
  readonly durable = false;

  async get<T>(key: string): Promise<T | undefined> {
    const entry = processCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      processCache.delete(key);
      return undefined;
    }
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    // No sweep timer - serverless has no process to run one. Expired entries
    // are dropped lazily on read, and the key space here is tiny and bounded
    // by the number of active callers.
    processCache.set(key, {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSeconds * 1000
    });
  }
}

export function createCache(config: Config): Cache {
  return hasRedis(config)
    ? new RedisCache(config.redisUrl!, config.redisToken!)
    : new MemoryCache();
}

/**
 * Wraps a cache so repeated reads of the same key within ONE request are
 * served from memory instead of making the same Redis round trip again.
 *
 * This is what makes resolving ten names in one call cost one lookup rather
 * than ten. It is created per request in app.ts, so nothing leaks between
 * callers - the serverless invariant in HANDOFF §5 holds.
 */
export function requestScoped(base: Cache): Cache {
  const memo = new Map<string, unknown>();
  return {
    durable: base.durable,
    async get<T>(key: string): Promise<T | undefined> {
      if (memo.has(key)) return memo.get(key) as T;
      const value = await base.get<T>(key);
      if (value !== undefined) memo.set(key, value);
      return value;
    },
    async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
      memo.set(key, value);
      await base.set(key, value, ttlSeconds);
    }
  };
}
