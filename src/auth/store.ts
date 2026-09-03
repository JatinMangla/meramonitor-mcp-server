import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Redis } from '@upstash/redis';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { MeraMonitorIdentity } from './meramonitor.js';
import { hasRedis, type Config } from '../config.js';

/**
 * Storage for the self-hosted OAuth authorization server.
 *
 * PORT NOTE (handoff 3.1): serverless functions share no memory between
 * requests, so the five in-process Maps this class used to hold became Redis
 * keys. The periodic sweep is gone with them - Redis TTLs expire entries
 * without a timer, and a serverless process has no reliable place to run one.
 *
 * Key            Holds                                     TTL
 * -------------  ----------------------------------------  ----------------------
 * client:<id>    registered OAuth client                   none (see below)
 * pending:<txn>  in-flight authorization request           10 minutes
 * code:<code>    authorization code                        10 minutes, GETDEL on use
 * token:<tok>    issued token + bound MeraMonitor identity MCP_TOKEN_TTL_SECONDS
 * refresh:<tok>  pointer to its access token               token TTL + 30 days
 *
 * `client:` keys deliberately have NO expiry. claude.ai remembers its
 * client_id indefinitely; if the key were to expire, every connector would
 * break and have to be removed and re-added.
 *
 * The memory/file backend below is kept for the self-hosted path (src/server.ts)
 * so the same code still runs as a normal process without Redis - see 3.3.
 */

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  createdAt: number;
}

export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  identity: MeraMonitorIdentity;
  resource?: string;
  createdAt: number;
}

export interface IssuedToken {
  clientId: string;
  identity: MeraMonitorIdentity;
  scopes: string[];
  expiresAt: number;
  refreshToken: string;
}

const TEN_MINUTES_SECONDS = 10 * 60;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

// --- storage backends -------------------------------------------------------

/**
 * The narrow slice of Redis this store needs. Everything is a JSON string, so
 * both backends behave identically and nothing depends on client-side
 * deserialisation heuristics.
 */
interface KvBackend {
  get(key: string): Promise<string | null>;
  /** `ttlSeconds` omitted means no expiry. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Atomic read-and-delete. Single-use codes depend on this being one operation. */
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

class RedisBackend implements KvBackend {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({
      url,
      token,
      // Store and return raw strings. We do our own JSON handling so a value
      // that happens to look like a number or a bare word round-trips exactly.
      automaticDeserialization: false
    });
  }

  async get(key: string): Promise<string | null> {
    return (await this.redis.get<string>(key)) ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.redis.set(key, value);
    } else {
      await this.redis.set(key, value, { ex: ttlSeconds });
    }
  }

  async getdel(key: string): Promise<string | null> {
    return (await this.redis.getdel<string>(key)) ?? null;
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

interface MemoryEntry {
  value: string;
  expiresAt?: number;
}

/**
 * Process-local fallback for the self-hosted path. Module-level so the map
 * survives across requests within one process; `client:` keys additionally
 * persist to MCP_CLIENTS_FILE so connectors survive a restart, exactly as the
 * pre-port build did.
 */
const memoryStore = new Map<string, MemoryEntry>();

class MemoryBackend implements KvBackend {
  constructor(private readonly clientsFile?: string) {
    this.loadClients();
  }

  private live(key: string): MemoryEntry | undefined {
    const entry = memoryStore.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      memoryStore.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    memoryStore.set(key, {
      value,
      ...(ttlSeconds === undefined ? {} : { expiresAt: Date.now() + ttlSeconds * 1000 })
    });
    if (key.startsWith('client:')) this.saveClients();
  }

  async getdel(key: string): Promise<string | null> {
    const entry = this.live(key);
    memoryStore.delete(key);
    return entry?.value ?? null;
  }

  async del(key: string): Promise<void> {
    memoryStore.delete(key);
    if (key.startsWith('client:')) this.saveClients();
  }

  private loadClients(): void {
    if (!this.clientsFile || !existsSync(this.clientsFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.clientsFile, 'utf8')) as OAuthClientInformationFull[];
      for (const client of raw) {
        memoryStore.set(`client:${client.client_id}`, { value: JSON.stringify(client) });
      }
    } catch (error) {
      console.warn(
        `Could not read the client registry at ${this.clientsFile}; starting empty. ` +
          `(${error instanceof Error ? error.message : String(error)})`
      );
    }
  }

  private saveClients(): void {
    if (!this.clientsFile) return;
    try {
      const clients: unknown[] = [];
      for (const [key, entry] of memoryStore) {
        if (key.startsWith('client:')) clients.push(JSON.parse(entry.value));
      }
      mkdirSync(dirname(this.clientsFile), { recursive: true });
      writeFileSync(this.clientsFile, JSON.stringify(clients, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
    } catch (error) {
      console.error(
        `FAILED to persist the client registry to ${this.clientsFile}. ` +
          'Connectors will break on restart until this is fixed. ' +
          `(${error instanceof Error ? error.message : String(error)})`
      );
    }
  }
}

// --- the store ---------------------------------------------------------------

/**
 * Same class shape and method names as before the port, so every caller in
 * provider.ts is unchanged apart from awaiting. Every method is now async.
 */
export class OAuthStore {
  private readonly kv: KvBackend;
  private readonly tokenTtlSeconds: number;

  constructor(config: Config) {
    this.tokenTtlSeconds = config.tokenTtlSeconds;
    this.kv = hasRedis(config)
      ? new RedisBackend(config.redisUrl!, config.redisToken!)
      : new MemoryBackend(config.clientsFile);
  }

  /** True when state is durable across instances. Reported by /healthz. */
  get isDurable(): boolean {
    return this.kv instanceof RedisBackend;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const raw = await this.kv.get(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  // --- clients (no TTL: losing one breaks that connector permanently) -------

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.read<OAuthClientInformationFull>(`client:${clientId}`);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await this.kv.set(`client:${client.client_id}`, JSON.stringify(client));
    return client;
  }

  // --- pending logins (10 minutes, single use) ------------------------------

  async createPending(request: Omit<PendingAuthorization, 'createdAt'>): Promise<string> {
    const txn = randomUUID();
    const record: PendingAuthorization = { ...request, createdAt: Date.now() };
    await this.kv.set(`pending:${txn}`, JSON.stringify(record), TEN_MINUTES_SECONDS);
    return txn;
  }

  /** Single-use: consuming a transaction removes it. */
  async takePending(txn: string): Promise<PendingAuthorization | undefined> {
    const raw = await this.kv.getdel(`pending:${txn}`);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as PendingAuthorization;
    } catch {
      return undefined;
    }
  }

  // --- authorization codes (10 minutes, single use) -------------------------

  async createCode(code: Omit<AuthorizationCode, 'createdAt'>): Promise<string> {
    const value = newSecret();
    const record: AuthorizationCode = { ...code, createdAt: Date.now() };
    await this.kv.set(`code:${value}`, JSON.stringify(record), TEN_MINUTES_SECONDS);
    return value;
  }

  /** Non-destructive read, used for the PKCE challenge lookup before exchange. */
  async peekCode(code: string): Promise<AuthorizationCode | undefined> {
    return this.read<AuthorizationCode>(`code:${code}`);
  }

  /**
   * Redeems a code. GETDEL is atomic, so two concurrent redemptions cannot both
   * succeed - a plain GET followed by DEL is a race that would let a stolen
   * code be replayed in the window between them.
   */
  async takeCode(code: string): Promise<AuthorizationCode | undefined> {
    const raw = await this.kv.getdel(`code:${code}`);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as AuthorizationCode;
    } catch {
      return undefined;
    }
  }

  // --- access and refresh tokens -------------------------------------------

  async issueToken(
    clientId: string,
    identity: MeraMonitorIdentity,
    scopes: string[],
    ttlSeconds: number
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    const record: IssuedToken = {
      clientId,
      identity,
      scopes,
      expiresAt: Date.now() + ttlSeconds * 1000,
      refreshToken
    };

    await this.kv.set(`token:${accessToken}`, JSON.stringify(record), ttlSeconds);
    // Outlives the access token so a client that was idle past expiry can still
    // attempt a refresh - which then succeeds only if MeraMonitor still accepts
    // the underlying token (see provider.exchangeRefreshToken).
    await this.kv.set(
      `refresh:${refreshToken}`,
      JSON.stringify({ accessToken }),
      ttlSeconds + THIRTY_DAYS_SECONDS
    );

    return { accessToken, refreshToken, expiresIn: ttlSeconds };
  }

  async getToken(accessToken: string): Promise<IssuedToken | undefined> {
    const found = await this.read<IssuedToken>(`token:${accessToken}`);
    if (!found) return undefined;
    // Redis TTL already expires the key; this also covers the memory backend
    // and any clock skew between write and read.
    if (found.expiresAt <= Date.now()) {
      await this.revokeAccessToken(accessToken);
      return undefined;
    }
    return found;
  }

  /** Returns the record the refresh token belongs to, without consuming it. */
  async getByRefreshToken(refreshToken: string): Promise<IssuedToken | undefined> {
    const pointer = await this.read<{ accessToken: string }>(`refresh:${refreshToken}`);
    if (!pointer?.accessToken) return undefined;
    // Deliberately not getToken(): an expired access token is still refreshable
    // while MeraMonitor accepts the bound identity.
    return this.read<IssuedToken>(`token:${pointer.accessToken}`);
  }

  async revokeAccessToken(accessToken: string): Promise<void> {
    const found = await this.read<IssuedToken>(`token:${accessToken}`);
    if (found?.refreshToken) await this.kv.del(`refresh:${found.refreshToken}`);
    await this.kv.del(`token:${accessToken}`);
  }

  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const pointer = await this.read<{ accessToken: string }>(`refresh:${refreshToken}`);
    if (pointer?.accessToken) await this.kv.del(`token:${pointer.accessToken}`);
    await this.kv.del(`refresh:${refreshToken}`);
  }

  /** Cheap liveness probe for /healthz - confirms the credentials actually work. */
  async ping(): Promise<boolean> {
    try {
      await this.kv.get('healthz:ping');
      return true;
    } catch {
      return false;
    }
  }

  /** Exposed so callers do not have to thread the config through separately. */
  get defaultTokenTtlSeconds(): number {
    return this.tokenTtlSeconds;
  }
}
