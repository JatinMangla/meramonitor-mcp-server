import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

import type { Config } from '../config.js';
import { loginWithDomain, isTokenStillValid, type MeraMonitorIdentity } from './meramonitor.js';
import { OAuthStore } from './store.js';
import { renderErrorPage, renderLoginPage } from './loginPage.js';

/**
 * A self-hosted OAuth 2.1 authorization server whose credential check is
 * delegated to MeraMonitor's own login.
 *
 * The point of doing it this way rather than bolting on a third-party IdP:
 * the OAuth identity IS the MeraMonitor identity. There is no second "link
 * your account" step, and no password ever travels through an MCP tool call.
 * The MeraMonitor token obtained at sign-in is bound to the issued OAuth token
 * and used for every downstream API call, so the backend keeps enforcing that
 * person's real role.
 *
 * PORT NOTE (handoff 3.1): the logic below is unchanged. Every store call was
 * already awaited; only `clientsStore` needed adjusting, and the SDK's
 * OAuthRegisteredClientsStore already declares both methods as `T | Promise<T>`.
 */
export class MeraMonitorOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly config: Config,
    private readonly store: OAuthStore
  ) {
    this.clientsStore = {
      getClient: (clientId: string) => this.store.getClient(clientId),
      registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) =>
        this.store.registerClient({
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000)
        } as OAuthClientInformationFull)
    };
  }

  /**
   * Step 1 of the flow. The SDK has already validated the client and
   * redirect_uri; we park the request server-side and show the login form.
   * Only an opaque transaction id goes into the page, so the OAuth parameters
   * cannot be tampered with between here and the POST.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    const txn = await this.store.createPending({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString()
    });

    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(
        renderLoginPage({
          txn,
          clientName: client.client_name ?? 'An MCP client',
          environmentLabel: this.config.envName,
          defaultDomain: this.config.defaultLoginDomain
        })
      );
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = await this.store.peekCode(authorizationCode);
    if (!record) throw new InvalidGrantError('Authorization code is invalid or expired.');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    // PKCE itself is verified by the SDK against challengeForAuthorizationCode.
    // takeCode uses Redis GETDEL, so a second concurrent redemption gets nothing.
    const record = await this.store.takeCode(authorizationCode);
    if (!record) throw new InvalidGrantError('Authorization code is invalid or expired.');
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client.');
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request.');
    }

    return this.issue(client.client_id, record.identity, []);
  }

  /**
   * We cannot mint a fresh MeraMonitor token (that backend has no refresh
   * endpoint and we never store passwords), so a refresh is only honoured
   * while the original MeraMonitor token is still accepted. Once it is not,
   * the client has to send the user through sign-in again.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[]
  ): Promise<OAuthTokens> {
    const existing = await this.store.getByRefreshToken(refreshToken);
    if (!existing) throw new InvalidGrantError('Refresh token is invalid or expired.');
    if (existing.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client.');
    }

    const stillValid = await isTokenStillValid(this.config.baseUrl, existing.identity.accessToken);
    if (!stillValid) {
      await this.store.revokeRefreshToken(refreshToken);
      throw new InvalidGrantError(
        'The underlying MeraMonitor session has expired. Please reconnect the connector to sign in again.'
      );
    }

    await this.store.revokeRefreshToken(refreshToken);
    return this.issue(client.client_id, existing.identity, scopes ?? existing.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getToken(token);
    if (!record) throw new InvalidTokenError('Access token is invalid or expired.');

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      // Tools read the MeraMonitor identity straight off the verified token.
      extra: { sub: record.identity.userId, identity: record.identity }
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    await this.store.revokeAccessToken(request.token);
    await this.store.revokeRefreshToken(request.token);
  }

  private async issue(
    clientId: string,
    identity: MeraMonitorIdentity,
    scopes: string[]
  ): Promise<OAuthTokens> {
    const { accessToken, refreshToken, expiresIn } = await this.store.issueToken(
      clientId,
      identity,
      scopes,
      this.config.tokenTtlSeconds
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(' ')
    };
  }
}

/**
 * Handles the login form POST. Not part of OAuthServerProvider - it is our own
 * endpoint, mounted alongside the SDK's OAuth router.
 */
export function createLoginHandler(config: Config, store: OAuthStore): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { txn, email, password, domain } = (req.body ?? {}) as Record<string, string | undefined>;

    if (!txn) {
      res.status(400).type('html').send(renderErrorPage('Invalid request', 'The sign-in form was incomplete.'));
      return;
    }

    const pending = await store.takePending(txn);
    if (!pending) {
      res
        .status(400)
        .type('html')
        .send(
          renderErrorPage(
            'Sign-in expired',
            'This sign-in link is no longer valid. Start the connection again from your MCP client.'
          )
        );
      return;
    }

    const client = await store.getClient(pending.clientId);
    const resolvedDomain = domain?.trim() || config.defaultLoginDomain;

    const reject = async (message: string): Promise<void> => {
      // Re-park the request so the user can retry without restarting the flow.
      const retry = await store.createPending({
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        state: pending.state,
        scopes: pending.scopes,
        resource: pending.resource
      });
      res
        .status(401)
        .type('html')
        .send(
          renderLoginPage({
            txn: retry,
            clientName: client?.client_name ?? 'An MCP client',
            environmentLabel: config.envName,
            defaultDomain: resolvedDomain,
            error: message
          })
        );
    };

    if (!email || !password || !resolvedDomain) {
      await reject('Email, password and domain are all required.');
      return;
    }

    let identity: MeraMonitorIdentity;
    try {
      identity = await loginWithDomain(
        config.baseUrl,
        email,
        password,
        resolvedDomain,
        config.apiTimeoutMs
      );
    } catch (error) {
      await reject(error instanceof Error ? error.message : 'Sign-in failed.');
      return;
    }

    const code = await store.createCode({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      identity,
      resource: pending.resource
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', code);
    if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
    res.redirect(302, redirect.toString());
  };
}

export { InvalidRequestError };
