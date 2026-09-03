import axios from 'axios';

/**
 * MeraMonitor-side identity for one linked account.
 *
 * NOTE: passwords are never stored. This backend exposes no refresh endpoint
 * (only Login/TokenValidity), so an expired token means the user links again.
 * On Vercel the identity is held in Redis, bound to the OAuth token it was
 * issued with, and expires with that token's TTL.
 */
export interface MeraMonitorIdentity {
  accessToken: string;
  userId: string;
  organizationId: string;
  organizationName?: string;
  email: string;
  fullName?: string;
  roleName: string;
  isManager: boolean;
  orgTimeZoneName?: string;
  /** Epoch ms, only known via the PortalIntegrationApi path. */
  expiresAt?: number;
}

/** Roles the SPA treats as admin for claim routing (timeclaim.service.ts:58-60). */
const ADMIN_ROLES = new Set(['Admin', 'CXO']);

export function isAdminRole(roleName: string | undefined): boolean {
  return ADMIN_ROLES.has((roleName ?? '').trim());
}

interface LoginWithDomainResponse {
  success?: boolean;
  message?: string;
  accessToken?: string;
  userId?: string;
  organizationId?: string;
  organizationName?: string;
  email?: string;
  fullName?: string;
  roleName?: string;
  isManager?: boolean;
  orgTimeZoneName?: string;
}

interface PortalTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Fallback path, confirmed working: the user links their own MeraMonitor
 * account, so the backend keeps enforcing their real role.
 */
export async function loginWithDomain(
  baseUrl: string,
  email: string,
  password: string,
  domain: string,
  timeoutMs = 25_000
): Promise<MeraMonitorIdentity> {
  let data: LoginWithDomainResponse;

  try {
    const response = await axios.post<LoginWithDomainResponse>(
      `${baseUrl.replace(/\/+$/, '')}/Login/LoginWithDomain`,
      { email, password, domain },
      { timeout: timeoutMs, headers: { Accept: 'application/json' } }
    );
    data = response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      throw new Error('MeraMonitor rejected those credentials.');
    }
    throw new Error(
      `Could not reach MeraMonitor to sign in: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!data.accessToken || !data.userId || !data.organizationId) {
    throw new Error(data.message?.trim() || 'Sign-in failed: no access token was returned.');
  }

  return {
    accessToken: data.accessToken,
    userId: data.userId,
    organizationId: data.organizationId,
    organizationName: data.organizationName,
    email: data.email ?? email,
    fullName: data.fullName,
    roleName: data.roleName ?? 'User',
    isManager: data.isManager === true,
    orgTimeZoneName: data.orgTimeZoneName
  };
}

/**
 * Asks MeraMonitor whether a token it issued is still accepted.
 *
 * This is the only expiry signal available - there is no refresh endpoint - so
 * it is what gates an OAuth refresh. A network failure returns false, which
 * costs the user a re-login rather than handing out a token that will not work.
 */
export async function isTokenStillValid(baseUrl: string, accessToken: string): Promise<boolean> {
  try {
    const response = await axios.get<boolean>(`${baseUrl.replace(/\/+$/, '')}/Login/TokenValidity`, {
      params: { token: accessToken },
      timeout: 15_000,
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
    });
    return response.data === true;
  } catch {
    return false;
  }
}

/**
 * Preferred machine-to-machine path - mints a token scoped to one user's email.
 *
 * BLOCKED until the backend team supplies an X-Api-Key: the endpoint itself
 * returns 401 unauthenticated. Wired up so it can be switched on by setting
 * MM_PORTAL_API_KEY without touching call sites.
 */
export async function fetchPortalToken(
  baseUrl: string,
  apiKey: string,
  clientId: string,
  clientSecret: string,
  email: string
): Promise<{ accessToken: string; expiresAt?: number }> {
  try {
    const response = await axios.post<PortalTokenResponse>(
      `${baseUrl.replace(/\/+$/, '')}/PortalIntegrationApi/GetToken`,
      { clientId, clientSecret, email },
      { timeout: 25_000, headers: { Accept: 'application/json', 'X-Api-Key': apiKey } }
    );
    const token = response.data.access_token;
    if (!token) throw new Error('GetToken returned no access_token.');
    return {
      accessToken: token,
      expiresAt: response.data.expires_in
        ? Date.now() + response.data.expires_in * 1000
        : undefined
    };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      throw new Error(
        'PortalIntegrationApi/GetToken returned 401 - the X-Api-Key in MM_PORTAL_API_KEY was rejected.'
      );
    }
    throw error;
  }
}
