# WordPress connection for the website MCP server

The website already reads published blog posts from `https://cms.swishtag.com/wp-json/wp/v2/posts` and Salient portfolio projects from `/wp-json/wp/v2/portfolio`. The MCP service adds an authenticated server-side connection to these same records; the public Astro rendering and form submission endpoints stay compatible.

## Configure WordPress

1. Update the installed `Swishtag Astro Form Submissions` plugin using `wordpress-plugin/swishtag-astro-form-submissions/`. Version 1.2.0 enables standard WordPress revisions for Salient's `portfolio` type while retaining its existing REST permission checks. The Salient theme or plugin must still register that type.
2. Create a dedicated WordPress integration account. Give it `edit_posts`, `edit_others_posts` when needed, `publish_posts` for direct publishing, and `upload_files` for media. Salient can use custom portfolio capabilities; the account also needs those capabilities. An Editor account is a practical starting point, but verify it against the installed portfolio type.
3. Under that account's WordPress profile, create an **Application Password** named for this MCP deployment. Use the generated application password rather than the account's interactive login password.
4. Put the HTTPS REST base URL, WordPress username, and application password in the MCP service's server-side environment, following [the main setup guide](./mcp-setup.md). Do not put them in Astro `PUBLIC_` variables, browser code, chat prompts, or committed configuration. The adapter accepts the CMS origin, `/wp-json`, or `/wp-json/wp/v2/` as its configured base URL.
5. Use the MCP WordPress inspection tool to verify connection and capabilities. List and inspect a real draft before attempting changes. The implementation tests use fake HTTP responses; installation, the live application password, Salient capabilities, and a real draft edit must be verified after credentials are supplied.

Application passwords require HTTPS and can be revoked independently. Confirm security plugins, reverse proxies, and Hostinger preserve the `Authorization` header and allow authenticated REST requests. This connection does not use the existing public form-submission token. Individual team sign-ins and MCP permissions are enforced by the MCP server; WordPress also applies the capabilities of the dedicated integration account. WordPress will attribute API edits to that integration account, while the MCP change history records the individual team member.

## Supported records and fields

The adapter supports listing and reading `posts` and `portfolio`, editing draft or published records, creating drafts, reading revisions, restoring recorded snapshots, and uploading PNG, JPEG, GIF, or WebP images up to 5 MiB. Image uploads take bytes from the repository workflow, never a URL to download. Uploads use one request including alternative text; returned media IDs can be assigned through `featured_media`.

Editable common fields are `title`, `content`, `excerpt`, `slug`, `status`, `featured_media`, `date`, and `date_gmt`; post categories and tags accept existing numeric term IDs. Unsupported fields fail validation. Custom portfolio taxonomies and Salient layout meta are intentionally not accepted without a dedicated typed integration. Existing Salient shortcode content is preserved as raw source.

Metadata starts with an empty allowlist. To edit SEO plugin metadata, an administrator must both register the relevant scalar fields as writable in WordPress REST with appropriate authorization callbacks and configure those exact keys in the MCP server's `wordpress.metaKeys` allowlist. An allowlist entry alone does not expose a private WordPress field. Yoast and other plugins can expose read-only SEO output that is not a writable metadata API. Confirm the installed plugin's supported API before enabling it. Website page SEO in Astro source is handled by the repository tools independently.

## Repository history and recovery

The adapter itself does not write to Git. The MCP workflow must save a validated intent and the existing editable snapshot to the repository **before** updating WordPress. It then records the response or failure. An uploaded image's bytes and metadata must likewise be recorded before upload. Git and WordPress cannot be committed atomically: if the process loses its response after WordPress applies a request, inspect the current record and the pending intent before retrying. Blindly retrying a media upload can create a duplicate attachment.

Updates check the record's `modified_gmt` against the saved snapshot immediately before sending the update, and reject changes that have become stale. Standard WordPress REST does not provide atomic conditional writes; an external edit can still race between that check and the update. Coordinate edits to the same record and use a custom transactional endpoint if strict cross-system conflict prevention is required.

Restoring a repository snapshot restores the supported editable fields, including status and featured media. Restoring a WordPress revision restores its title, content, and excerpt; native revisions do not contain all status, taxonomy, media, or plugin metadata. Site deployment rollback does not roll back the WordPress database automatically. Keep regular WordPress database and uploads backups in addition to Git history. Uploaded attachments are retained for recovery; removing references to an image does not delete it from WordPress.

## Adapter interface

`mcp/src/wordpress.mjs` exports `WordPressClient`, `validateWordPressFields`, `validateWordPressImage`, and `revisionToFields`. The client takes `{ baseUrl, username, applicationPassword, metaKeys }` and implements:

| Method | Result / behavior |
| --- | --- |
| `configured()` / `inspect()` | Connection state and a restricted capability summary; no credentials |
| `list({ type, page, perPage, search, status })` | Bounded summaries and total page counts |
| `get({ type, id })` / `snapshot(...)` | `{ type, id, modified_gmt, link, fields }`, using editable raw content |
| `validate(fields, { type })` | Validated fields with the configured metadata allowlist |
| `update({ type, id, fields, expectedModified })` | Conflict preflight and an updated snapshot |
| `createDraft({ type, fields })` | Creates a draft; cannot publish on creation |
| `revisions({ type, id, page, perPage })` | Raw title/content/excerpt of bounded revision pages |
| `getRevision({ type, id, revisionId })` | Checks the revision's parent |
| `restore({ type, id, snapshot, expectedModified })` | Restores the supplied snapshot through the update checks |
| `uploadMedia({ filename, mimeType, base64, altText })` | Checks file signature and uploads one image with its alternative text |

`type` is exactly `posts` or `portfolio`. Per-user permissions, publication permission, audit recording, serialization, and repository commits are the caller's responsibility. Network calls use only the administrator-configured HTTPS endpoint, prohibit redirects, have a 20-second timeout, cap JSON responses at 4 MiB, and return sanitized upstream errors.

Run the isolated verification with `node --test mcp/test/wordpress.test.mjs` and validate the PHP plugin with `php -l wordpress-plugin/swishtag-astro-form-submissions/swishtag-astro-form-submissions.php`.

## Official references

- [WordPress authentication and application passwords](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)
- [Application password administration](https://developer.wordpress.org/advanced-administration/security/application-passwords/)
- [Posts API and editable fields](https://developer.wordpress.org/rest-api/reference/posts/)
- [Post revisions API](https://developer.wordpress.org/rest-api/reference/post-revisions/)
- [Media API](https://developer.wordpress.org/rest-api/reference/media/)
- [Writable registered metadata](https://developer.wordpress.org/rest-api/extending-the-rest-api/modifying-responses/)
- [Post type revision support](https://developer.wordpress.org/reference/functions/add_post_type_support/)
