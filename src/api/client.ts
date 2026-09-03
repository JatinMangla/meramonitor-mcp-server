import axios, { AxiosInstance, AxiosError } from 'axios';

/** The caller's MeraMonitor token is missing, expired, or rejected. */
export class MeraMonitorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeraMonitorAuthError';
  }
}

/** Any other non-2xx from the backend. */
export class MeraMonitorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string
  ) {
    super(message);
    this.name = 'MeraMonitorApiError';
  }
}

/**
 * Default request timeout, in milliseconds.
 *
 * PORT NOTE (handoff 3.5): this MUST stay comfortably below `maxDuration` in
 * vercel.json (60s). A slow MeraMonitor call then surfaces as a readable tool
 * error rather than a bare 504 FUNCTION_INVOCATION_TIMEOUT with no explanation
 * of what was being waited on.
 */
export const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * The single place that knows how to talk to the MeraMonitor API.
 *
 * Two conventions this centralises, because they are inconsistent per verb and
 * getting them wrong returns an empty 200 rather than an error:
 *   - GET  query params are PascalCase  (OrganizationId, FromDate, UserId)
 *   - POST bodies are camelCase         (organizationId, fromDate, userId)
 * Callers pass the exact casing the endpoint wants; this class does not rewrite
 * keys, it just makes the rule impossible to miss in one reviewed location.
 */
export class MeraMonitorClient {
  private readonly http: AxiosInstance;
  private readonly timeoutMs: number;

  constructor(
    baseUrl: string,
    private readonly getAccessToken: () => Promise<string>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.timeoutMs = timeoutMs;
    this.http = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ''),
      timeout: timeoutMs,
      headers: { Accept: 'application/json' }
    });
  }

  /** GET with PascalCase query params. */
  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.send<T>('get', path, { params: this.pruneUndefined(params) });
  }

  /** POST with a camelCase JSON body. */
  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('post', path, { data: body ?? {} });
  }

  private pruneUndefined(
    params?: Record<string, string | number | boolean | undefined>
  ): Record<string, string | number | boolean> | undefined {
    if (!params) return undefined;
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  private async send<T>(
    method: 'get' | 'post',
    path: string,
    options: { params?: Record<string, string | number | boolean>; data?: unknown }
  ): Promise<T> {
    const token = await this.getAccessToken();

    try {
      const response = await this.http.request<T>({
        method,
        url: path,
        params: options.params,
        data: options.data,
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw this.translate(error, path);
    }
  }

  private translate(error: unknown, path: string): Error {
    if (!axios.isAxiosError(error)) {
      return error instanceof Error ? error : new Error(String(error));
    }

    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;

    if (status === 401 || status === 403) {
      // There is no refresh endpoint on this backend - the caller has to sign
      // in again rather than the server silently re-authenticating.
      return new MeraMonitorAuthError(
        'MeraMonitor rejected the access token. Reconnect the connector to sign in again.'
      );
    }

    if (axiosError.code === 'ECONNABORTED') {
      return new MeraMonitorApiError(
        `Request to ${path} timed out after ${Math.round(this.timeoutMs / 1000)}s. ` +
          'MeraMonitor did not respond in time; narrow the date range or try again.',
        408,
        path
      );
    }

    if (status === undefined) {
      return new MeraMonitorApiError(
        `Could not reach the MeraMonitor API (${axiosError.code ?? 'network error'}).`,
        0,
        path
      );
    }

    const body = axiosError.response?.data;
    const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body ?? {}).slice(0, 300);
    return new MeraMonitorApiError(`${path} returned ${status}: ${detail}`, status, path);
  }
}
