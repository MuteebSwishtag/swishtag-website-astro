import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERMISSIONS = Object.freeze([
  'site.read', 'content.edit', 'seo.edit', 'assets.edit', 'navigation.edit',
  'footer.edit', 'layouts.edit', 'pages.edit', 'redirects.edit',
  'wordpress.read', 'wordpress.edit', 'wordpress.publish', 'build.validate',
  'preview.create', 'deploy.publish', 'deploy.rollback', 'history.read', 'website.full',
]);

const permissionSet = new Set(PERMISSIONS);
const safeAlgorithms = new Set(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA', 'Ed25519']);

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = 'configuration_error';
  }
}

function fail(message) { throw new ConfigurationError(message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function string(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\x00]/u.test(value)) fail(`${label} must be a nonempty string.`);
  return value;
}

function httpsUrl(value, label, { allowPath = true } = {}) {
  string(value, label);
  let url;
  try { url = new URL(value); } catch { fail(`${label} must be an absolute HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`${label} must be an HTTPS URL without credentials, query, or fragment.`);
  if (!allowPath && url.pathname !== '/') fail(`${label} must be an origin without a path.`);
  return value;
}

function integer(value, fallback, label, minimum, maximum) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) fail(`${label} is outside the allowed range.`);
  return number;
}

function stringList(value, label, fallback) {
  const list = value === undefined ? fallback : value;
  if (!Array.isArray(list) || list.some(item => typeof item !== 'string' || !item || /[\r\n\x00]/u.test(item))) fail(`${label} must be an array of strings.`);
  return [...new Set(list)];
}

/** Parse policy on every request: removing a subject takes effect without a restart. */
export function validatePolicy(policy) {
  if (!record(policy) || !record(policy.roles) || !record(policy.users)) fail('policy.roles and policy.users must be objects.');
  for (const [roleName, role] of Object.entries(policy.roles)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/u.test(roleName) || !record(role)) fail('Policy contains an invalid role.');
    if (!Array.isArray(role.permissions)) fail('Role permissions must be an array.');
    const permissions = stringList(role.permissions, 'Role permissions', []);
    if (permissions.some(permission => !permissionSet.has(permission))) fail('Policy contains an unknown permission.');
    const paths = stringList(role.paths, 'Role paths', []);
    if (paths.some(prefix => prefix !== '*' && (prefix.startsWith('/') || /[\\:%\x00-\x1f]/u.test(prefix) || prefix.split('/').some(segment => segment === '.' || segment === '..') || prefix.includes('//')))) fail('Role paths must be repository relative paths, directory prefixes, or "*".');
  }
  for (const [subject, user] of Object.entries(policy.users)) {
    if (!subject || subject.length > 1024 || /[\x00-\x1f]/u.test(subject) || !record(user)) fail('Policy contains an invalid subject.');
    if (user.enabled !== undefined && typeof user.enabled !== 'boolean') fail('User enabled must be a boolean.');
    if (!Array.isArray(user.roles)) fail('User roles must be an array.');
    const roles = stringList(user.roles, 'User roles', []);
    if (roles.some(role => !Object.hasOwn(policy.roles, role))) fail('Policy refers to an unknown role.');
    if (user.revokedBefore !== undefined && (typeof user.revokedBefore !== 'string' || !Number.isFinite(Date.parse(user.revokedBefore)))) fail('User revokedBefore must be an ISO date.');
  }
  return policy;
}

export async function loadPolicy(policyPath) {
  try {
    const document = JSON.parse(await readFile(policyPath, 'utf8'));
    return validatePolicy(document.policy);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    fail('Unable to read a valid authorization policy.');
  }
}

/** Credentials are accepted from the process environment only, never repository JSON. */
export async function loadConfig({ env = process.env, configPath } = {}) {
  const filename = path.resolve(configPath || env.MCP_CONFIG_PATH || fileURLToPath(new URL('../config.json', import.meta.url)));
  let raw;
  try { raw = JSON.parse(await readFile(filename, 'utf8')); } catch { fail('Unable to read MCP configuration; copy mcp/config.example.json to mcp/config.json.'); }
  if (!record(raw)) fail('MCP configuration must be an object.');
  const server = raw.server || {};
  const auth = raw.auth || {};
  const github = raw.github || {};
  const wordpress = raw.wordpress || {};
  const deployment = raw.deployment || {};
  const publicUrl = httpsUrl(env.MCP_PUBLIC_URL || server.publicUrl, 'server.publicUrl');
  if (new URL(publicUrl).pathname !== '/mcp') fail('server.publicUrl must point to the /mcp endpoint.');
  const audience = string(env.MCP_OAUTH_AUDIENCE || auth.audience || publicUrl, 'auth.audience');
  if (audience !== publicUrl) fail('auth.audience must equal server.publicUrl; register this resource URL with the identity provider.');
  const issuer = httpsUrl(env.MCP_OAUTH_ISSUER || auth.issuer, 'auth.issuer');
  const jwksUri = httpsUrl(env.MCP_OAUTH_JWKS_URI || auth.jwksUri, 'auth.jwksUri');
  const algorithms = stringList(auth.algorithms, 'auth.algorithms', ['RS256', 'ES256']);
  if (!algorithms.length || algorithms.some(algorithm => !safeAlgorithms.has(algorithm))) fail('auth.algorithms must contain supported asymmetric signature algorithms.');
  const requiredScopes = stringList(auth.requiredScopes, 'auth.requiredScopes', ['website:manage']);
  if (!requiredScopes.length || requiredScopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope))) fail('auth.requiredScopes must contain valid OAuth scope names.');
  const scopesClaim = auth.scopesClaim || 'scope';
  if (!['scope', 'scp'].includes(scopesClaim)) fail('auth.scopesClaim must be scope or scp.');
  const tokenTypes = stringList(auth.tokenTypes, 'auth.tokenTypes', ['at+jwt', 'JWT']);
  if (!tokenTypes.length || tokenTypes.some(type => !['at+jwt', 'application/at+jwt', 'JWT'].includes(type))) fail('auth.tokenTypes must contain JWT access token types.');
  const allowedOrigins = stringList(server.allowedOrigins, 'server.allowedOrigins', []);
  for (const origin of allowedOrigins) {
    httpsUrl(origin, 'server.allowedOrigins entry', { allowPath: false });
    if (origin !== new URL(origin).origin) fail('Allowed origins must be canonical origins without trailing slashes.');
  }
  const owner = string(env.MCP_GITHUB_OWNER || github.owner, 'github.owner');
  const repo = string(env.MCP_GITHUB_REPO || github.repo, 'github.repo');
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) fail('GitHub owner and repository are invalid.');
  validatePolicy(raw.policy);
  const baseUrl = env.MCP_WORDPRESS_BASE_URL || wordpress.baseUrl;
  if (baseUrl) httpsUrl(baseUrl, 'wordpress.baseUrl');
  const siteUrl = deployment.siteUrl ? httpsUrl(deployment.siteUrl, 'deployment.siteUrl') : undefined;
  const previewBaseUrl = deployment.previewBaseUrl ? httpsUrl(deployment.previewBaseUrl, 'deployment.previewBaseUrl') : undefined;
  const baseBranch = string(github.baseBranch || 'master', 'github.baseBranch');
  const workflow = string(github.workflow || 'mcp-validate.yml', 'github.workflow');
  if (!/^[A-Za-z0-9_./-]+$/u.test(baseBranch) || baseBranch.includes('..') || baseBranch.startsWith('-') || baseBranch.endsWith('/')) fail('github.baseBranch is invalid.');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(workflow)) fail('github.workflow must be a workflow filename.');
  return {
    configPath: filename,
    policyPath: filename,
    server: {
      publicUrl,
      host: string(env.MCP_HOST || server.host || '127.0.0.1', 'server.host'),
      port: integer(env.MCP_PORT ?? server.port, 3100, 'server.port', 1, 65535),
      allowedOrigins,
    },
    auth: {
      issuer, audience, jwksUri, algorithms, requiredScopes, scopesClaim, tokenTypes,
      maxTokenAgeSeconds: integer(auth.maxTokenAgeSeconds, 3600, 'auth.maxTokenAgeSeconds', 60, 86400),
      clockToleranceSeconds: integer(auth.clockToleranceSeconds, 5, 'auth.clockToleranceSeconds', 0, 30),
    },
    github: { owner, repo, baseBranch, workflow, previewBotLogins: stringList(github.previewBotLogins, 'github.previewBotLogins', []), token: env.MCP_GITHUB_TOKEN || '' },
    wordpress: {
      baseUrl,
      username: env.MCP_WORDPRESS_USERNAME || '',
      applicationPassword: env.MCP_WORDPRESS_APPLICATION_PASSWORD || '',
      metaKeys: stringList(wordpress.metaKeys, 'wordpress.metaKeys', []),
    },
    deployment: {
      siteUrl, previewBaseUrl,
      hostingerAccount: deployment.hostingerAccount || '',
      hostingerDomain: deployment.hostingerDomain || '',
      hostingerToken: env.MCP_HOSTINGER_TOKEN || '',
    },
  };
}
