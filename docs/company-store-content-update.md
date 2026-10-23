# Company Store update, October 23, 2026

Implemented from the supplied **Oct 23 content spec** and **Company Store: Cold Caller Poster**. The linked Google Doc could not be retrieved in this environment, so its live revision could not be compared with the supplied copy. The user's instructions override historical instructions and superseded offers inside those documents.

The existing page layout, components, imagery, colors, and protected SEO copy are retained. The offer now shows a $1,200 first store, $300 cloned stores, and the $100/month/store Care Plan, cancel anytime and billed as one Shopify charge. Migration, Care, separate costs, preview guarantee, ownership, distributor benefits, and the four-step process use the existing cards. Old pricing, the app promotion, SAGE, competitor copy, the broken integration link, and the PunchOut pitch are removed from the offer content. Site-wide navigation still links to separate solutions and platforms.

## Verification

| Check | Result |
| --- | --- |
| Production build | `npm.cmd run build` passes |
| Route | `/solutions/shopify-company-store/` returns 200 locally; no redirect added |
| Title, description, H1, eyebrow | Exact original text retained; one H1 |
| Existing H2s | Retained except the two pricing/inclusions replacements specified in the brief |
| Canonical, social URL, structured-data URLs | Use `https://swishtag.com/solutions/shopify-company-store/` as specified; no CMS domain in rendered page |
| Sitemap and robots | Existing sitemap entry retained; page remains indexable |
| FAQ | 12 visible questions; FAQ JSON-LD generated from the same array, with matching text |
| Pricing schema | $1,200 setup, $300 clone, $100/month Care Plan; no old anchor price or scarcity |
| Offer cleanup | No SAGE, named competing store platforms, PunchOut, separate app prices, app promotion, or old offer name in the main content |
| Pending content | Live demo buttons, Club Colors quote, and video are not rendered; existing MOVOPACK testimonial retained |
| Responsive checks | Headless Edge at 1440, 768, and 390px; no document-level horizontal overflow; three pricing tiles and four process steps |
| Mobile | Stacked pricing, compact process cards, body/list text at least 14px, and secondary navigation hides on downward scroll |
| JavaScript disabled | All main content reveal blocks remain visible |
| Demo form | Company Store selected by the original query string; SAGE option absent; 15-minute slots; three-step submission and success state verified with mocked transport |
| Scheduler | Mocked Zoom requests confirm demo meetings use 15 minutes even with a general 30-minute setting; other meeting types retain their setting |
| Images | Three embedded page images moved to cacheable WebP files; hero srcsets added; social image is 1200x630 |
| Icons | Existing artwork retained; combined SVG, ICO, and Apple icon size reduced from the original 1.28 MB SVG to 6,024 bytes |
| Asset cache configuration | LiteSpeed/Apache headers configured for images/fonts and immutable hashed JS/CSS; production headers require a deployed check |

Counts use the same main-content text extraction before and after, including the FAQ:

| Metric | Before | After |
| --- | ---: | ---: |
| Words | 2,126 | 2,778 |
| `company store` | 33 | 43 |
| `Shopify company store` | 8 | 10 |

## Pending inputs and verification limits

Set approved media in `src/data/company-store.js`: live demo URL, Trustpilot profile URL, Club Colors quote/name/title/image, and direct video/poster/caption URLs. The quote requires all author/image fields; video requires its poster and captions. Pending content is omitted from the HTML rather than displayed as placeholders.

The existing Shopify CDN logo could not load in the local browser environment; local page images loaded. Live email/CRM writes, live Zoom bookings, production cache headers, Lighthouse scores, external rich-result validators, and Google Search Console were not exercised. No deployment was performed. Font self-hosting and broad site-wide CSS pruning were outside this content update.

## Hero image branding cleanup

Removed the embedded `Search Printful` wording from the desktop screenshot. The phone now uses the existing unbranded `Company Store` product screenshot in the repo. Updated both responsive image sets and the social preview, using new filenames to avoid stale cached images. The hero components and layout are unchanged; the production build passes.

Saved assets under `public/assets/images/`: `company-store-desktop-neutral.webp`, `company-store-desktop-neutral-600.webp`, `company-store-mobile-neutral.webp`, `company-store-mobile-neutral-240.webp`, and `shopify-company-store-promo-distributors-neutral.webp`.

The desktop edit used the built-in imagegen tool with this final prompt: "Edit this desktop UI screenshot. Change only the placeholder text in the search input at the top from 'Search Printful' to 'Search products'. Match the current small gray font. Keep the entire rest of the screenshot unchanged, with its full framing and original aspect ratio."
