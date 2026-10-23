# Individual sign-in and permissions

The MCP service is an OAuth resource server. Each team member signs into an external OAuth/OIDC identity provider through their MCP client. The service validates the resulting JWT access token against a configured HTTPS JWKS endpoint, exact issuer, resource audience, expiration, signature algorithm and management scope. Website admin passwords, WordPress passwords and shared API keys cannot sign a person into MCP.

This follows the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). The client and identity provider handle the browser login, consent, PKCE, MFA and refresh tokens. The MCP service publishes protected resource metadata at `/.well-known/oauth-protected-resource/mcp`; its HTTP authentication challenge points clients to that document.

## Identity provider configuration

1. Provision an OAuth 2.1 compatible authorization server with OAuth authorization server metadata or OIDC discovery. Require individual accounts and MFA for publishers. Confirm that it supports your selected MCP client's registration method: pre-registered client, Client ID Metadata Documents, or supported dynamic registration. A provider with OIDC login alone may need additional OAuth resource/audience configuration.
2. Register this API's resource identifier and access-token audience as the exact endpoint, for example `https://mcp.swishtag.com/mcp`. Enable authorization code flow with PKCE S256. Clients must send this resource URL in both authorization and token requests. Register the MCP client's exact callback URLs with the provider; this service does not implement login callbacks.
3. Create the `website:manage` scope, issue JWT **access tokens** containing `iss`, `aud`, `sub`, `iat`, `exp`, and `scope`, and limit their lifetime to one hour or less. Default accepted signatures are RS256 and ES256. Configure an equivalent approved asymmetric algorithm explicitly when needed. ID tokens and tokens for WordPress or GitHub must never be supplied to this API. A separate resource audience plus the management scope distinguishes the website access token from login ID tokens.
4. Set the exact issuer and JWKS URLs in `mcp/config.json` or `MCP_OAUTH_ISSUER` and `MCP_OAUTH_JWKS_URI`. Issuers are compared literally, including trailing slashes. The audience must equal `server.publicUrl`. Metadata must refer to the same issuer. The MCP client discovers authorization endpoints directly from the identity provider; this service does not proxy them.
5. If your provider uses `scp`, set `auth.scopesClaim` to `scp`; the configured claim may be a space-separated string or string array. Select `tokenTypes` matching the provider's signed access-token `typ` header (`at+jwt`, `application/at+jwt`, or `JWT`). Prefer RFC 9068 `at+jwt` where supported. Missing or unrecognized token types fail authentication. Opaque access tokens require a separate introspection adapter and are not supported by this JWT implementation.
6. Add the person's stable issuer-issued `sub` value to `policy.users`. Obtain it from the identity provider's administrative interface. Display names and email addresses never grant access. Tokens cannot self-assign roles through claims.
7. In the MCP client, add `https://mcp.swishtag.com/mcp` as a remote authenticated server and complete the provider's individual sign-in. Configure pre-registration credentials in the client when its provider needs them. The server itself needs no OAuth client secret for JWT verification.

`server.publicUrl` must use public HTTPS. The process can still listen at `127.0.0.1:3100` behind a TLS reverse proxy. No authentication bypass or local shared bearer key is provided. Every MCP request needs a valid authorization header. Query string access tokens are rejected by the HTTP integration.

## Permission policy

Copy `mcp/config.example.json` to `mcp/config.json` on the MCP host. The example denies all users until you add explicit subject entries. Keep this production configuration outside the repository or ignored by Git, writable only by trusted operators. Policy changes are an operator task; no MCP tool edits authentication settings or credentials.

For example, within the configuration's `policy` object:

```json
{
  "roles": {
    "content-team": {
      "permissions": ["site.read", "content.edit", "seo.edit", "footer.edit", "wordpress.read", "wordpress.edit", "build.validate", "preview.create", "history.read"],
      "paths": ["src/pages/", "src/components/layout/Footer.astro", "src/data/", "public/assets/"]
    },
    "site-owner": {
      "permissions": ["website.full"],
      "paths": ["*"]
    }
  },
  "users": {
    "provider|REAL-EDITOR-SUBJECT": { "roles": ["content-team"], "enabled": true },
    "provider|REAL-OWNER-SUBJECT": { "roles": ["site-owner"], "enabled": true }
  }
}
```

Replace the subject placeholders with real values. Users can have several roles. A path ending in `/` is a directory prefix; another path is an exact file; `*` permits all eligible repository paths. A permission and its allowed path must come from the same role, so a broad viewer role cannot expand an editor's write access. Omitted `paths` grants no file access. Path restrictions apply to file edits and every website path in a validation, preview or source publication diff. WordPress permissions apply to its separate capabilities. The repository backend blocks secrets, authentication configuration and deployment control files, including for `website.full` users.

| Permission | Grants |
| --- | --- |
| `site.read` | Inspect website source and structure within allowed paths |
| `content.edit`, `seo.edit` | Edit page content and search metadata |
| `assets.edit` | Add or replace eligible website assets |
| `navigation.edit`, `footer.edit` | Edit shared navigation or footer |
| `layouts.edit`, `pages.edit` | Edit layouts or page implementations |
| `redirects.edit` | Edit website redirects |
| `wordpress.read`, `wordpress.edit`, `wordpress.publish` | Inspect, stage edits to, or publish supported WordPress content |
| `build.validate`, `preview.create` | Trigger validation or preview workflow |
| `deploy.publish`, `deploy.rollback` | Publish directly or restore a deployment through the configured workflow |
| `history.read` | Read change and deployment history |
| `website.full` | All website tool permissions, subject to backend protections and configured paths |

Direct publishing uses `deploy.publish` (and `wordpress.publish` for WordPress content). `website.full` includes both. Authorized users can publish without a second MCP approval. GitHub branch protection or hosting policy can still deny that update; configure those explicitly to match your team's policy. Granular editors use parser-based text, attribute and SEO tools. Raw Astro/JavaScript/PHP, new page implementations and dependency edits require `website.full`; those contributors are trusted with production website code. Source rollback also requires full access. Protect secrets at the workflow/runtime boundary.

## Revocation and operational security

The policy file is read at authentication and every tool permission check. Remove a user or set `enabled: false` to deny subsequent requests without restarting. To reject existing tokens but allow fresh sign-ins, set the user's `revokedBefore` to an ISO UTC timestamp; tokens issued at or before that instant are denied. An already running operation is not canceled. Invalid, missing or unreadable policies deny requests.

Also disable the account and revoke sessions at the identity provider. JWT signature validation alone cannot observe provider logout or per-token revocation until token expiry. Keep the one-hour maximum token lifetime (or reduce `maxTokenAgeSeconds`, minimum 60 seconds). Removing a JWKS key has cache latency: this service caches keys for up to ten minutes and refreshes for an unknown key after a short cooldown. Use policy removal for immediate local denial. Avoid changing issuer or audience without restarting the service and reconfiguring clients.

Credentials are loaded only from the standalone service's environment:

- `MCP_GITHUB_TOKEN`: repository-scoped GitHub App installation token or fine-grained personal access token. Grant Contents read/write, Actions read/write, Pull requests read/write, Issues read and Metadata read for the target repository. A GitHub App installation token expires and must be rotated externally before expiry. A nonexpiring token is not created by this integration.
- `MCP_WORDPRESS_USERNAME` and `MCP_WORDPRESS_APPLICATION_PASSWORD`: a dedicated WordPress application password over HTTPS, with a least-privilege account. Individual MCP users are identified in repository change records; upstream WordPress API requests share this restricted service identity.
- `MCP_HOSTINGER_TOKEN`: optional Hostinger API token for provider build status. The existing Hostinger GitHub connection triggers production deployment without SSH/SFTP keys.

Do not expose these variables through Astro `PUBLIC_*`, browser code, AI tool responses, Git commits or build logs. Restrict access to the MCP service environment and reverse proxy logs. The API never forwards users' OAuth tokens to GitHub, WordPress or Hostinger. Avoid request-body/header logging, terminate TLS at a trusted proxy, and allow browser origins only when needed using `server.allowedOrigins`.

Production configuration and service credentials must not be mounted into untrusted preview builds. Preview builds are arbitrary code from an editor's branch. Use separate low-privilege preview resources, run validation without production secrets, and reserve production deployment secrets for approved publish jobs. Versioned change records identify the individual OAuth subject even though provider API calls use service credentials.

The implementation uses [`jose` JWT claim and signature verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md) and [remote public JWKS verification](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md). These files configure a resource server; deploying a compatible authorization server and testing the real MCP client's browser sign-in remain required setup work.
