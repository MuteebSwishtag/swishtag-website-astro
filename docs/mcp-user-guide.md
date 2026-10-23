# Edit the Swishtag website with AI

Use the Swishtag-MCP plugin in ChatGPT to ask for website changes in plain language. Sign in with your authorized team account. Your assigned permissions determine what you can edit and publish.

## Start a request

Start a new ChatGPT conversation, type `@`, and select Swishtag-MCP. Include the page URL, what should change, and whether you want a draft or a live update.

> Use Swishtag-MCP to inspect https://swishtag.com/solutions/shopify-company-store/. Change each demo button label from “Book a 15-minute demo” to “Book a demo”. Keep the links and styling. Prepare and validate the change, but do not publish yet.

## What you can edit

| Area | Example request |
| --- | --- |
| Page content | “Update the heading and introduction on this page to the following text…” |
| SEO metadata | “Change this page’s SEO title and description to…” |
| Images | “Use this supplied image in the hero and set its alt text to…” |
| Navigation and footer | “Update the Contact link in the footer to…” |
| Pages, layouts and styles | “Create a page using the existing layout…” Full source changes require administrator access. |
| Redirects | “Redirect this old local path to this new local path permanently.” Requires redirect permission. |

WordPress posts and portfolio tools exist, but WordPress setup is currently deferred. Ask an administrator before requesting those changes.

## Review and publish

1. **Inspect:** Ask the AI to read the relevant files before editing.
2. **Prepare:** It creates a separate change branch and saves edits in GitHub. Ask for the change ID and a summary of the diff.
3. **Validate:** Ask it to run build validation and wait for a successful result. Every further edit needs validation again.
4. **Preview:** Ask for a preview and inspect it when available. Preview hosting must be configured; a pull request alone does not guarantee a working preview URL.
5. **Publish:** Say “Publish change [change ID]” when ready. Authorized users can publish directly after validation.
6. **Verify:** Ask it to check deployment status until the live website matches the published commit. A Git commit alone does not mean the deployment is live.

To undo a published change, ask the AI to inspect history and prepare a rollback to the chosen commit. Review, validate and publish that rollback. Source rollback requires full website access.

## Useful tool names

You normally do not need to name tools. These names help when checking whether the connection works:

- Read: `site_inspect`, `site_read_file`, `history_list`.
- Edit: `change_create`, `content_edit_text`, `content_edit_attribute`, `seo_update`, `image_upload`, `redirect_set`.
- Review: `change_inspect`, `build_validate`, `build_status`, `preview_create`.
- Release: `publish`, `deployment_status`, `rollback_prepare`.
- Full source editing: `source_write`, restricted to full-access users for raw source changes.

## If something fails

- **Tools unavailable:** Reconnect or refresh the plugin, then start a new conversation. Ask an administrator to check server logs if discovery fails.
- **Access denied:** Ask an administrator to check your exact Auth0 user ID and assigned permissions. Google and password logins can have different IDs despite sharing an email address.
- **Text edit cannot find one match:** Ask the AI to inspect the exact source text. Repeated or dynamic labels may need an administrator to use `source_write` and review the diff.
- **GitHub or build error:** Ask for the exact tool error and change ID. Resolve the failure before publishing.
- **Uncertain write result:** Ask the AI to inspect the current change or deployment before retrying.

Keep passwords, access tokens and client secrets out of chat. Hosting and authentication settings belong to your administrator.
