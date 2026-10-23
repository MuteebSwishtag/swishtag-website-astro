# Hostinger deployment for the website MCP server

This repository is an Astro server application. `astro.config.mjs` uses `output: 'server'` and the standalone Node adapter. It includes dynamic WordPress routes, form APIs, administration APIs and database access. Its production deployment needs Hostinger's **Node.js Web App** pipeline. Uploading only `dist/client` or using the generic PHP/HTML Git integration will omit those server features.

The existing Hostinger Node.js Web App is already connected to GitHub. This integration keeps that connection: the MCP server edits a source branch, validates an immutable commit in GitHub Actions, and advances the configured live branch when an authorized team member publishes. Hostinger then performs its normal build and restart. No Hostinger account token is needed to trigger that native Git deployment. [Hostinger Git deployment documentation](https://docs.hostinger.com/node.js/git-deployments)

## One-time settings

1. Install this integration's source files and `.github/workflows/mcp-validate.yml` in the repository. Enable GitHub Actions. A manually dispatched workflow must be present on the repository's default branch.
2. In hPanel, open the existing Node.js Web App and confirm the connected repository is `MuteebSwishtag/swishtag-website-astro`.
3. Set the live branch to the same value as `github.baseBranch` in the MCP configuration. The checked-out repository currently uses `master`; change both settings together if you adopt a separate production branch. Publishing advances this branch immediately for users with publishing permission.
4. Apply these build settings:

   | Setting | Value |
   | --- | --- |
   | Framework/application type | `astro` |
   | Node.js | `24` (matching the validation workflow) |
   | Root directory | Repository root |
   | Package manager | `npm` |
   | Build script | `build` |
   | Output directory | `dist` |
   | Entry file | `server/entry.mjs` |

   Hostinger resolves Astro's entry file relative to the output directory. The correct hPanel value is `server/entry.mjs`. The local `npm start` command uses `node ./dist/server/entry.mjs`. [Hostinger Astro settings](https://docs.hostinger.com/node.js/overview-1/astro)
5. Keep the website's existing production environment variables in hPanel. Database, mail, Zoom and website administration credentials stay server-side. Configure form delivery to use its existing server endpoint. Never put WordPress application passwords or the MCP server's GitHub token into a `PUBLIC_*` variable.
6. Grant the MCP server's dedicated GitHub credential access to this repository: Contents read/write, Actions read/write, Pull requests read/write, Issues read and Metadata read. Restrict direct writes to the live branch to the integration and your release maintainers. Existing branch protection can prevent direct publishing; grant the integration an explicit permitted path if that behavior is required.

Hostinger's supported Node versions and build limits are documented in [Build settings](https://docs.hostinger.com/node.js/build-settings). Keep runtime and CI versions aligned when changing dependencies.

## Validation and previews

The MCP server dispatches `mcp-validate.yml` with one input, `ref`: the complete lowercase 40-character candidate commit SHA. The workflow's run title is `MCP Validate <sha>` and its validation job is `MCP build validation`.

The workflow checks out candidate source without persisted Git credentials, installs from the lockfile, builds the application, and starts its standalone Node server locally. It checks the release marker and HTML responses for `/`, `/company/`, and `/contact-us/`. GitHub runners receive no production, WordPress or identity-provider secrets. Build and receipt helper scripts come from the trusted dispatch branch.

Successful runs retain two authenticated GitHub Actions artifacts:

- `mcp-build-<sha>`: the complete `dist` directory, including the SSR bundle and client assets; retained for 7 days.
- `mcp-validation-<sha>`: a JSON receipt containing the exact source SHA, workflow identifiers and SHA-256 inventory of the build; retained for 30 days.

A build artifact is a runnable application package, not a public preview website. For an interactive preview, open the MCP change's pull request. Hostinger's GitHub integration builds a separate PR preview and comments with its commit and temporary `hostingersite.com` URL. The preview disappears after the PR closes or merges. Confirm the comment's commit matches the candidate SHA you want to inspect. [Hostinger pull request previews](https://www.hostinger.com/support/how-to-use-pull-request-previews-for-node-js-websites-in-hostinger/)

To run the equivalent local smoke check, first build the website, then run:

```powershell
npm.cmd run build
node scripts/mcp-smoke-test.mjs
```

On macOS/Linux, use `npm` instead of `npm.cmd`. The smoke check does not submit forms or modify WordPress content.

## Publishing, deployment status and rollback

A successful GitHub validation means the candidate built and served its smoke routes. Publishing updates the source branch; Hostinger's deployment completes asynchronously and can still fail. Check deployment status after publishing.

The website build writes `dist/client/.well-known/site-release.json`, served at `https://YOUR-SITE/.well-known/site-release.json`. It contains the build time and source SHA obtained from `MCP_BUILD_SHA` or the checkout's Git metadata. The MCP deployment status checks this configured URL without forwarding any credentials or following redirects. Exempt it from long-lived CDN caching. If Hostinger's build environment omits Git metadata, the marker reports a null SHA and deployment status explicitly leaves the live revision unknown.

For Hostinger's own build states and commit history, add these optional settings to the MCP server's private configuration/environment:

```json
{
  "deployment": {
    "siteUrl": "https://YOUR-SITE",
    "hostingerAccount": "u123456789",
    "hostingerDomain": "YOUR-SITE"
  }
}
```

```dotenv
MCP_HOSTINGER_TOKEN=YOUR_SERVER_SIDE_API_TOKEN
```

`hostingerAccount` is the hosting account's username, not your email address or a VPS ID. Generate the token in [hPanel → API](https://hpanel.hostinger.com/profile/api); it inherits its owner's permissions. The adapter reads the fixed Node.js builds endpoint and returns only build IDs, states, commit SHAs, branches and timestamps. It never returns raw logs, environment variables or API error bodies. [Hostinger API authentication](https://docs.hostinger.com/api-reference/overview), [Node.js build status](https://docs.hostinger.com/api-reference/endpoints/hosting/nodejs/get-node-js-build-details)

Rollback creates a new source commit restoring an earlier version's website files while preserving current MCP and deployment controls, validates that commit, and publishes it through the same path. It preserves Git history. Hostinger's redeploy action instead rebuilds the current live branch and does not select an old commit. [Hostinger deployment behavior](https://docs.hostinger.com/node.js/deployments)

WordPress content is stored in WordPress separately from the Astro source. An Astro rollback does not restore WordPress posts, portfolio records, uploaded media, databases or form submissions. Use the MCP WordPress revision/restore tools for supported content changes, and the hosting backup process for full database/media recovery.

## Requirements still needed for activation

- The final website URL and confirmation that hPanel's selected live branch matches `github.baseBranch`.
- A dedicated GitHub credential with the permissions above, installed only on the MCP server.
- An identity provider and per-person OAuth application registration; see the main MCP setup guide for sign-in and permission configuration.
- A WordPress service account/application password allowed to edit the existing posts and REST-exposed `portfolio` type.
- The hosting account username and optional Hostinger API token for provider build status.
- HTTPS hosting for the separate MCP service with Node.js 24, outbound access to GitHub, WordPress, the identity provider and optionally Hostinger, and persistent private storage for its audit history.

No credentials were used to deploy this integration during implementation. The local build and mocked integration tests do not prove that a specific GitHub credential, identity-provider registration or Hostinger account is configured correctly; complete the live acceptance sequence in the main setup guide after provisioning them.
