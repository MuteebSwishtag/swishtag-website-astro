import { createRemoteJWKSet, jwtVerify } from 'jose';
import { loadPolicy, PERMISSIONS } from './config.mjs';

const permissions = new Set(PERMISSIONS);

export class AuthenticationError extends Error {
  constructor(code = 'invalid_token', message = 'A valid website access token is required.', status = 401) {
    super(message);
    this.name = 'AuthenticationError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

export class AuthorizationError extends AuthenticationError {
  constructor(message = 'This account does not have permission for this operation.') {
    super('forbidden', message, 403);
    this.name = 'AuthorizationError';
  }
}

function activeUser(policy, principal) {
  if (!Object.hasOwn(policy.users, principal.subject)) return undefined;
  const user = policy.users[principal.subject];
  if (user.enabled === false) return undefined;
  if (user.revokedBefore && principal.issuedAt <= Date.parse(user.revokedBefore) / 1000) return undefined;
  if (!Number.isFinite(principal.expiresAt) || principal.expiresAt <= Date.now() / 1000) return undefined;
  return user;
}

async function currentPolicy(principal) {
  try { return await loadPolicy(principal.policyPath); } catch { throw new AuthorizationError('Website authorization policy is unavailable.'); }
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') &&
    !/[\\:%\x00-\x1f]/u.test(value) && !value.includes('//') &&
    !value.split('/').some(segment => segment === '.' || segment === '..' || segment === '');
}

function allowedPath(paths = [], value) {
  if (!safePath(value)) return false;
  return paths.some(prefix => prefix === '*' || (prefix.endsWith('/') ? value.startsWith(prefix) : value === prefix));
}

/** Policy grants and optional path restrictions must come from the SAME role. */
export async function authorize(principal, permission, repositoryPath) {
  if (!principal || !permissions.has(permission)) return false;
  const policy = await currentPolicy(principal);
  const user = activeUser(policy, principal);
  if (!user) return false;
  return user.roles.some(name => {
    const role = policy.roles[name];
    if (!role || (!role.permissions.includes(permission) && !role.permissions.includes('website.full'))) return false;
    return repositoryPath === undefined || allowedPath(role.paths, repositoryPath);
  });
}

export async function assertPermission(principal, permission, repositoryPath) {
  if (!await authorize(principal, permission, repositoryPath)) throw new AuthorizationError();
}

/**
 * OAuth resource server only. Login, consent, PKCE, MFA and refresh tokens belong
 * to the configured authorization server and MCP client, never this process.
 */
export function createAuthenticator(config, { keySet } = {}) {
  const { auth, server, policyPath } = config;
  const keys = keySet || createRemoteJWKSet(new URL(auth.jwksUri), {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  });
  const resourceMetadataUrl = `${new URL(server.publicUrl).origin}/.well-known/oauth-protected-resource/mcp`;

  function metadata() {
    return {
      resource: server.publicUrl,
      authorization_servers: [auth.issuer],
      scopes_supported: [...auth.requiredScopes],
      bearer_methods_supported: ['header'],
      resource_name: 'Swishtag Website Management',
    };
  }

  function challenge(error) {
    const parameters = [
      `resource_metadata="${resourceMetadataUrl}"`,
      `scope="${auth.requiredScopes.join(' ')}"`,
    ];
    if (error?.code === 'invalid_token' || error?.code === 'insufficient_scope') parameters.push(`error="${error.code}"`);
    return `Bearer ${parameters.join(', ')}`;
  }

  async function authenticate(authorizationHeader) {
    if (typeof authorizationHeader !== 'string' || authorizationHeader.length > 16384) throw new AuthenticationError();
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(authorizationHeader);
    if (!match) throw new AuthenticationError();
    let verified;
    try {
      verified = await jwtVerify(match[1], keys, {
        issuer: auth.issuer,
        audience: auth.audience,
        algorithms: auth.algorithms,
        requiredClaims: ['iss', 'aud', 'sub', 'exp', 'iat'],
        maxTokenAge: auth.maxTokenAgeSeconds,
        clockTolerance: auth.clockToleranceSeconds,
      });
    } catch { throw new AuthenticationError(); }
    const { payload, protectedHeader } = verified;
    if (!auth.tokenTypes.includes(protectedHeader.typ) || typeof payload.sub !== 'string' || !payload.sub ||
        payload.exp <= payload.iat || payload.exp - payload.iat > auth.maxTokenAgeSeconds + auth.clockToleranceSeconds) throw new AuthenticationError();
    const claim = payload[auth.scopesClaim];
    const scopes = typeof claim === 'string' ? claim.split(/\s+/u).filter(Boolean) :
      Array.isArray(claim) && claim.every(scope => typeof scope === 'string') ? claim : [];
    if (auth.requiredScopes.some(scope => !scopes.includes(scope))) throw new AuthenticationError('insufficient_scope', 'This access token is missing the website management scope.', 403);
    const principal = Object.freeze({
      subject: payload.sub,
      issuer: payload.iss,
      name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : undefined,
      email: typeof payload.email === 'string' ? payload.email.slice(0, 320) : undefined,
      scopes: Object.freeze([...new Set(scopes)]),
      tokenId: typeof payload.jti === 'string' ? payload.jti : undefined,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      policyPath,
    });
    if (!activeUser(await currentPolicy(principal), principal)) throw new AuthorizationError('This account is not authorized to manage this website.');
    return principal;
  }

  return { authenticate, metadata, challenge, resourceMetadataUrl };
}
