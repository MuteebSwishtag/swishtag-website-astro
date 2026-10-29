# Astro to WordPress Forms and Portfolio Content

This project now includes a custom WordPress plugin at:

`wordpress-plugin/swishtag-astro-form-submissions/`

It registers:

- REST endpoint: `POST /wp-json/astro-form/v1/submit`
- Custom Post Type: `Form Submissions`
- Admin dashboard list, search, view, and delete support
- Email notification to the WordPress admin email
- Read-only REST access for published Salient `portfolio` projects

## 1. Install The WordPress Plugin

1. Zip the folder `wordpress-plugin/swishtag-astro-form-submissions`.
2. In WordPress Admin, go to `Plugins -> Add New -> Upload Plugin`.
3. Upload the zip file and activate `Swishtag Astro Form Submissions`.
4. Confirm that `Form Submissions` appears in the WordPress admin menu.

Recommended `wp-config.php` configuration:

```php
define('ASTRO_FORM_TOKEN', 'replace-with-a-long-random-token');
define('ASTRO_FORM_ALLOWED_ORIGINS', 'https://cms.swishtag.com,https://www.swishtag.com');
```

Use the same token in Astro as `PUBLIC_ASTRO_FORM_TOKEN`.

If you do not define `ASTRO_FORM_TOKEN`, the plugin generates a token on activation and stores it in the WordPress option `swishtag_astro_form_token`. You can read it with WP-CLI:

```bash
wp option get swishtag_astro_form_token
```

## 2. Configure Astro Environment

Add these values to the Astro deployment environment:

```env
PUBLIC_FORM_SUBMISSION_MODE=wordpress
PUBLIC_DIRECT_FORM_ENDPOINT=/api/send-form.php
PUBLIC_WORDPRESS_FORM_ENDPOINT=https://cms.swishtag.com/wp-json/astro-form/v1/submit
WORDPRESS_PROJECTS_ENDPOINT=https://cms.swishtag.com/wp-json/wp/v2/portfolio
WORDPRESS_CMS_ORIGIN=https://cms.swishtag.com
PUBLIC_ASTRO_FORM_TOKEN=replace-with-the-same-token-used-by-wordpress
```

Use `PUBLIC_FORM_SUBMISSION_MODE=direct` when you want the forms to submit to the existing PHP email endpoint.

Use `PUBLIC_FORM_SUBMISSION_MODE=wordpress` when you want the forms to submit to WordPress and save entries as `Form Submissions`.

Then rebuild and deploy the Astro site:

```bash
npm run build
```

### Portfolio project routes

Version 1.1.0 of the WordPress plugin exposes Salient's existing `portfolio`
custom post type through the standard, read-only WordPress REST response. Update
the installed plugin before deploying the Astro project route.

Confirm a legacy project can be fetched:

```text
https://cms.swishtag.com/wp-json/wp/v2/portfolio?slug=true-number&_embed=1
```

The Astro route at `src/pages/project/[slug].astro` uses the final URL segment
as the WordPress slug, so one dynamic page supports every existing URL such as:

```text
/project/true-number/
/project/chatbase/
/project/tag-analytics/
```

The page fetches from the same-origin endpoint `/api/projects/{slug}`. This
automatically resolves to `http://localhost:4321` during local development and
to the current production domain after deployment. The server endpoint then
contacts the separately configured WordPress CMS origin. It also supports the
legacy WordPress project permalink as a temporary fallback while an older
version of the plugin is still installed.

Only published portfolio entries are returned to unauthenticated visitors.
WordPress continues to require authentication and the appropriate capabilities
for create, update, and delete requests.

## 3. Exact Astro Form Changes

The existing form UI, field names, validation, success states, and styling remain unchanged.

The two form `action` values now use the selected environment mode.

Direct email mode:

```html
action="/api/send-form.php"
```

WordPress mode:

```astro
action={formEndpoint}
data-form-token={formToken}
```

`formEndpoint` resolves to `PUBLIC_DIRECT_FORM_ENDPOINT` in direct mode and `PUBLIC_WORDPRESS_FORM_ENDPOINT` in WordPress mode.

On Hostinger, direct PHP mode only works if the PHP endpoint has a public URL. It is fine for private mail configuration files to live outside `public_html`, but the endpoint file itself must be reachable by the browser, for example `/api/send-form.php`, or routed to by the server.

The submit JavaScript sends the same JSON payload in both modes. In WordPress mode, it also includes:

```js
headers["X-Astro-Form-Token"] = formToken;
payload.form_loaded_at = formLoadedAt;
```

Updated Astro files:

- `src/pages/book-demo/index.astro`
- `src/pages/solutions/custom-software-automation/index.astro`

## 4. Stored Fields

The plugin accepts the Swishtag form fields below. Book-demo country, city, and UTC slot fields are required.

Book Demo:

- `form_source`
- `fullName`
- `workEmail`
- `companyName`
- `website`
- `solutionInterest`
- `service`
- `intent`
- `storeCount`
- `notes`
- `selectedDate`
- `selectedDateISO`
- `selectedTime`
- `selectedTime24`
- `selectedSlotUtc`
- `timezone`
- `country`
- `countryCode`
- `city`
- `page`
- `form_loaded_at`

Custom Software:

- `form_source`
- `name`
- `email`
- `project_type`
- `stage`
- `problem`
- `integrations`
- `budget`
- `page`
- `form_loaded_at`

Each accepted field is saved as post metadata using the key pattern:

```text
astro_form_field_{field_name}
```

The full sanitized payload is also stored in:

```text
astro_form_payload
```

## 5. Security And Spam Protection

The endpoint uses:

- WordPress REST permission callback
- Required `X-Astro-Form-Token`
- Exact CORS origin allowlist
- Honeypot fields: `nickname` and `_gotcha`
- Per-IP/email/source rate limiting
- Minimum submit-time check when `form_loaded_at` is present
- Field whitelist by form source
- Required field validation
- Email and URL validation
- Text sanitization and max lengths
- Link-count spam rejection
- JSON success/error responses

Important: `PUBLIC_ASTRO_FORM_TOKEN` is sent by browser JavaScript, so it is a public site token, not a private server secret. Keep the CORS allowlist, rate limiting, honeypots, and validation enabled.

## 6. Book demo country, city, and booked times

Plugin 1.3.0 requires `country`, `city`, `timezone`, and `selectedSlotUtc` on book-demo submissions and stores them with the rest of the payload. `selectedSlotUtc` must be a UTC timestamp such as `2026-11-02T14:00:00.000Z`. The plugin rejects a second book-demo submission whose 15-minute window overlaps an existing `selectedSlotUtc`, with HTTP 409 and `"code": "slot_taken"`.

Country and city choices come from a bundled GeoNames extract, not a live third-party API:

- Dataset: `src/data/locations.json`
- Source: GeoNames (`https://www.geonames.org/`), CC BY 4.0
- Coverage: populated places with population of at least 5,000, plus a country capital when that capital is smaller
- Rebuild: `node scripts/build-locations.mjs`
- `GET /api/locations/countries`
- `GET /api/locations/cities?country=US&q=austin` returns each match with its IANA `timezone`

No API key or new environment variable is required. The page calls those same-origin endpoints, so the form still loads when GeoNames itself is down.

Before a city is chosen, the slot grid uses the browser timezone. After a city is chosen, times are generated in that city's IANA timezone from 9:00 through 15:00, every 15 minutes, on the next 10 business days. Changing to a city in a different zone clears the previously selected slot. The browser sends `selectedSlotUtc` plus that city's `timezone`. The Astro submit handler rejects a timezone that does not match the city, checks the instant against that city's grid, and stores it on `meetingAt` / `meetingAtISO`. If booked times cannot be read, `GET /api/book-demo/availability` returns HTTP 200 `{ "ok": true, "busy": [], "degraded": true }` and the page shows every slot as selectable. A slot taken in the meantime is rejected on submit with HTTP 409. After a submission is saved, a missing Zoom or mail configuration is logged and does not turn the response into an error.

Booked slots are exposed without personal data:

```json
GET /api/book-demo/availability
{
  "ok": true,
  "durationMinutes": 15,
  "busy": [
    { "start": "2026-11-02T14:00:00.000Z", "end": "2026-11-02T14:15:00.000Z" }
  ]
}
```

`start` and `end` are UTC. A slot that overlaps any range is shown and cannot be selected. Submitting a slot that was taken in the meantime returns HTTP 409, `"code": "slot_taken"`, and the message `That time was just booked. Please choose another slot.`

Storage does not need a schema migration. `country`, `city`, `countryCode`, and `selectedSlotUtc` live in the submission `fields` object (the MongoDB document, or MySQL `document_json`). The existing `meeting_at` column already stores the UTC instant. Direct-mode availability reads that same submissions database. WordPress mode enforces the overlap against Form Submissions, but the public availability endpoint does not read WordPress.

## 7. Testing The Endpoint

After the plugin is active and the env values are deployed, submit both live forms:

- `/book-demo/`
- `/solutions/custom-software-automation/`

Expected success response:

```json
{
  "ok": true,
  "message": "Thanks. Your demo request has been sent to Swishtag.",
  "submission_id": 123,
  "email_sent": true
}
```

Expected admin result:

- A new item appears under `Form Submissions`
- Submitted fields are visible on the edit/view screen
- The admin list can search by title, email, name, company, or submitted metadata
- The item can be deleted or moved to Trash like other WordPress admin records
