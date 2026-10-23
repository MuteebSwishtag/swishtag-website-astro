# Website management through MCP

This adds a separate authenticated Node.js MCP service for the existing Astro website. It edits the private GitHub source repository, manages the existing WordPress posts and Salient portfolio projects, runs validation in GitHub Actions, creates Hostinger PR previews and publishes through your existing Hostinger Node.js GitHub connection.

The endpoint is `https://mcp.YOUR-DOMAIN/mcp`, using Streamable HTTP and individual OAuth sign-ins. The service never needs access to the website's `.env`, form database, SMTP password, Zoom credentials or existing shared website administration login.

## What is implemented

| Area | Tools / behavior |
| --- | --- |
| Source inspection | `site_inspect`, `site_read_file`; pinned revisions, file sizes and protected-path filtering |
| Changes and history | `change_create`, `change_inspect`, `history_list`; individual subject attribution, isolated `mcp/<uuid>` branches, production commits and rollback targets |
| Content, footer, navigation, layouts, pages | `content_edit_text`, `content_edit_attribute`; parser-based edits to visible text and literal safe attributes |
| Full source access | `source_write`; create/replace/delete pages, layouts, styles and website code; raw executable code requires `website.full` |
| SEO | `seo_update` updates existing literal page metadata; full-access source edits handle dynamic metadata, structured data and other markup |
| Images | `image_upload` commits PNG/JPEG/GIF/WebP bytes; update template `src` and `alt` separately |
| Redirects | `redirect_set` writes `src/data/redirects.json`, imported by Astro; local targets, supported HTTP redirect status, cycle checks |
| WordPress | `wordpress_inspect`, `wordpress_stage_update`, `wordpress_stage_restore`, `wordpress_stage_image`, `wordpress_apply`, `wordpress_operation` |
| Validation and preview | `build_validate`, `build_status`, `preview_create`; exact source SHA, SSR smoke tests, authenticated build artifacts and Hostinger PR links |
| Production | `publish`, `deployment_status`, `rollback_prepare`; direct publishing for permitted users, live SHA verification and history-preserving source rollback |

WordPress updates are separate live operations. An existing published item's edit requires `wordpress.publish` even if its `status` field is omitted. Each update records its before-snapshot and proposed fields in Git **before** calling WordPress, then records its result. Astro source publication requires a successful validation of the exact current head and an unchanged production base. Authorized publishers need no second approval inside the MCP service.

## Credentials and hosting still needed

These are not present or provisioned by this implementation:

1. **Identity provider:** none is selected yet. Choose an OAuth authorization server supporting your MCP client's registration, authorization code + PKCE, JWT access tokens, the exact MCP resource audience, and individual team accounts. Auth0 or Keycloak are possible providers; confirm the client/provider combination supports resource indicators or equivalent audience configuration. See [individual sign-in setup](mcp-auth.md).
2. **GitHub service credential:** repository-scoped fine-grained PAT or externally rotated GitHub App installation token for `MuteebSwishtag/swishtag-website-astro`. Permissions: Contents read/write, Actions read/write, Pull requests read/write, Issues read (preview comments), Metadata read. No workflow-write permission is needed by runtime tools. Provision/install the workflow separately as an operator.
3. **WordPress service account + application password:** HTTPS access to `https://cms.swishtag.com`, allowed to edit the existing posts and portfolio projects and upload media. Activate the included plugin v1.2.0 to expose portfolio REST/revision support. See [WordPress setup](mcp-wordpress.md).
4. **MCP hosting:** a separate HTTPS Node.js 24 service, reachable by the team's AI clients, with outbound access to the identity provider/JWKS, GitHub, WordPress and optionally Hostinger. Provide a persistent private audit directory and a private config file. Run **one active service instance**, because WordPress mutation locks and the append-only audit writer are process-local. Use a shared transactional operation store before running replicas.
5. **Hostinger configuration:** your website already uses a Node.js Web App connected to GitHub. Confirm its deployment branch matches `github.baseBranch` (currently `master`), auto-deployment is enabled, and enable PR previews. Verify how your plan handles preview environment variables before relying on isolation: Hostinger's automatic previews are separate from the secret-free GitHub validation. Use restricted staging resources if preview-specific environment separation is unavailable. See [Hostinger setup](mcp-hostinger.md).
6. **Optional Hostinger API token + account username:** only needed for provider build states. The native Git deployment trigger needs no Hostinger API token. The live release marker works independently when the build can determine its commit SHA.

Do not paste credentials into AI messages. Set them directly in the MCP service's private environment or secret manager. Keep the repository private: WordPress before-snapshots may include unpublished content.

## Install and configure

Install Node.js 24, then from the repository root:

```powershell
npm.cmd ci
npm.cmd --prefix mcp ci
Copy-Item mcp/config.example.json mcp/config.json
Copy-Item mcp/.env.example mcp/.env
```

On Linux/macOS use `npm` and `cp`. Root dependencies belong to the website; MCP dependencies and lockfile are separate under `mcp/`. Production builds do not install the MCP SDK into the website.

Edit the ignored `mcp/config.json`:

- Set `server.publicUrl`, `auth.issuer`, `auth.jwksUri` and the exact matching `auth.audience`.
- Set `github.baseBranch` to Hostinger's actual live branch. Keep the workflow on GitHub's default branch as well as that branch.
- Add real identity-provider `sub` values to `policy.users` and assign roles. The shipped example has **zero authorized users**. Give `administrator` (`website.full`) only to trusted developers. Add `deploy.publish` or `wordpress.publish` to appropriate roles when direct publishing is wanted.
- Match each role's `paths` to the source it may manage. Prefixes ending `/` include descendants; other entries are exact files. A permission and its path grant must belong to the same role. Source validation, previews and publishing check path grants across the change's complete website diff.
- Configure `deployment.siteUrl` to the actual canonical website origin. Optional `hostingerAccount` and `hostingerDomain` enable provider status with its token.
- After the Hostinger GitHub App creates a PR comment, verify its exact bot login and add it to `github.previewBotLogins`. This list defaults to empty; preview PRs still work, but automated link extraction stays disabled until you configure the trusted bot identity. Verify its comment's commit before using a link.

Set the server-side values in `mcp/.env` using the example. `MCP_GITHUB_TOKEN`, `MCP_WORDPRESS_USERNAME` and `MCP_WORDPRESS_APPLICATION_PASSWORD` are the main service credentials. No OAuth client secret is needed for JWT verification; client registration and callback URLs belong to the identity provider and MCP client. Configure browser origins only if your client needs them; wildcard origins are unsupported.

```powershell
npm.cmd run mcp:check
npm.cmd run mcp:test
npm.cmd run mcp:start
```

The configuration checker reports missing credentials without printing their values and makes no external requests. The server listens on loopback port 3100 by default. Readiness is `/healthz`; OAuth protected resource metadata is `/.well-known/oauth-protected-resource/mcp`. Put a TLS reverse proxy in front and preserve the public `Host` header. Access tokens are accepted only in the `Authorization: Bearer ...` header.

On a server, supply an absolute `MCP_CONFIG_PATH` and durable `MCP_AUDIT_PATH`. The default audit file is `.mcp-runtime/audit.jsonl` at the repository root. Ensure the service user can write it and only operators can edit the policy/config. Use a process manager for restarts. The audit log contains subjects, tool names, outcomes and commit references, without tokens or content bodies. Git commits hold source and WordPress change history. Audit files require normal access controls and backups; they are not a cryptographically tamper-proof ledger.

For a container deployment, build from `mcp/Dockerfile` with context `mcp/`. Mount config read-only at `/run/mcp/config.json` and make it readable by the non-root `node` user. Mount persistent storage writable by that user at `/var/lib/mcp` and inject credentials through the hosting secret manager. Bind port 3100 behind HTTPS. The image copies only source and locked dependencies. A second Hostinger Node app is suitable only if it supports these persistent private files and runtime settings; otherwise host this service on a VPS/container host while leaving the website on its existing Hostinger app. Configure upstream request limits at the reverse proxy; the service applies authenticated limits per subject and does not trust forwarded client IP headers.

## Connect and use

Add the remote URL to an MCP-compatible AI client and complete individual sign-in. The client must support OAuth discovery and the selected provider's registration method. See [authentication setup](mcp-auth.md) for issuer/audience/scope requirements. Static shared bearer keys and the website's existing admin password are not accepted.

A normal source edit is:

1. `site_inspect`, then `site_read_file` for the relevant page/component.
2. `change_create` with a meaningful summary; save the returned `changeId` and `head`.
3. Edit with the structured tools, `image_upload`, `redirect_set`, or full-access `source_write`. Pass the latest `head` as `expectedHead` every time. Each edit returns the next head.
4. `build_validate` for the latest head; poll `build_status` until it reports `valid: true`.
5. `preview_create`; inspect Hostinger's preview for this exact commit.
6. `publish` when requested by the user. A permitted publisher advances the live branch directly; no PR merge is required. Branch protections can still deny that update and must explicitly permit the desired service workflow.
7. `deployment_status` until the live SHA matches the published SHA or investigate Hostinger's failed build. A successful Git update is never reported as a completed website deployment. Close the preview PR after the release when it is no longer needed.

If another change reaches production first, the old change's publication is rejected. Create a fresh change from current production and reapply its edits, validate and preview again. There is no automatic merge, force push or arbitrary shell-command tool.

For WordPress, inspect the item, stage its update in a source change, and call `wordpress_apply` with the returned operation ID/head. The snapshot comparison detects normal concurrent edits; native WordPress REST does not provide atomic conditional updates, so a narrow concurrent-write race remains. The existing project endpoint may serve its previous cached result for up to five minutes. Restoring an item uses `wordpress_stage_restore` plus `wordpress_apply`. Uploaded media is preserved in Git, but content rollback does not delete WordPress attachments.

If a WordPress write times out, its outcome is marked unknown and replay is blocked. `wordpress_operation` with `reconcile: true` and the latest `expectedHead` compares the intended fields with live fields and records the observation. Unresolved operations block source publication; inspect the WordPress admin/Media Library rather than re-uploading blindly. Source changes and WordPress updates are not a distributed transaction: an upstream write may succeed before its Git result receipt is stored. The already stored intent supports manual recovery.

To roll back website source, call `rollback_prepare` with an ancestor SHA, validate and preview the resulting change, then publish it. This requires full website access plus rollback permission (included in `website.full`). It restores website files while retaining current MCP, workflow and audit controls. It does not roll back WordPress or the form database. Rollback to source older than the current Astro runtime/control contract may need a developer adjustment to pass validation.

## Boundaries and verification

Structured edits escape inserted text, refuse script/style/expression edits, and only update safe literal attributes or existing metadata declarations. These tools intentionally refuse ambiguous matches. Use `website.full` to restructure markup, create pages or change dynamic code. Schema-validated FAQ JSON and CSS have narrower content/asset edit permissions; other raw data files and deletion require full access. FAQ text is escaped when rendered and its links are validated. Secrets, `.env`, dot paths, symlinks, MCP service code, workflows and deployment scripts cannot be read or changed through website tools. Full-access contributors can execute code in the production website and must be trusted with its runtime authority.

Local automated tests use signed test JWTs and mocked GitHub/WordPress/Hostinger APIs. HTTP integration uses the real MCP SDK. Build validation checks the actual Astro standalone app locally. No real OAuth tenant, remote GitHub Actions run, WordPress mutation or Hostinger publication was performed during implementation.

Verified locally: 118 MCP tests, 3 deployment-helper tests, the production Astro build, standalone HTML responses on `/`, `/company/`, `/contact-us/`, the `/services` HTTP 301 redirect, the release marker, PHP plugin syntax, and `git diff --check`. The configuration checker correctly exits with a missing-configuration message before provisioning. The container image has not been built here.

```powershell
npm.cmd run mcp:test
node --test scripts/mcp-deployment.test.mjs
npm.cmd run build
node scripts/mcp-smoke-test.mjs
php -l wordpress-plugin/swishtag-astro-form-submissions/swishtag-astro-form-submissions.php
```

After provisioning, complete one live acceptance test with a non-production change: sign in as a viewer and verify edit denial; sign in as an editor, edit footer text, validate and inspect the Hostinger preview; verify publishing is denied without permission; publish with a publisher, confirm the live SHA, prepare/validate/publish a rollback, then revoke the test subject and verify immediate denial. Test a WordPress draft update and restore before granting production publishing.

Protocol and provider references: [official MCP SDK HTTP example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts), [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Hostinger Astro configuration](https://docs.hostinger.com/node.js/overview-1/astro), [WordPress application passwords](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/).
