// Site-wide structured data (schema.org JSON-LD).
// Organization facts are the ones shown in the footer (src/components/layout/Footer.astro).
// No AggregateRating or Review markup: there is no third-party review source to cite.

export const SITE_URL = 'https://swishtag.com';
export const ORG_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;

export const ORGANIZATION = {
  name: 'Swishtag',
  legalName: 'Swishtag LLC',
  email: 'hello@swishtag.com',
  telephone: '+1-518-650-1201',
  logo: `${SITE_URL}/assets/swishtag-logo.svg`,
  address: {
    streetAddress: '90 State St Ste 700 Office 40',
    addressLocality: 'Albany',
    addressRegion: 'NY',
    postalCode: '12207',
    addressCountry: 'US',
  },
  sameAs: [
    'https://www.facebook.com/helloswishtag',
    'https://www.linkedin.com/company/helloswishtag',
    'https://www.youtube.com/@helloswishtag',
    'https://x.com/helloswishtag',
    'https://www.instagram.com/helloswishtag/',
    'https://www.pinterest.com/helloswishtag/',
  ],
};

export function orgNode({ contactPoint = false } = {}) {
  const node = {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: ORGANIZATION.name,
    legalName: ORGANIZATION.legalName,
    url: `${SITE_URL}/`,
    logo: ORGANIZATION.logo,
    email: ORGANIZATION.email,
    telephone: ORGANIZATION.telephone,
    address: { '@type': 'PostalAddress', ...ORGANIZATION.address },
    sameAs: ORGANIZATION.sameAs,
  };
  if (contactPoint) {
    node.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'sales',
      email: ORGANIZATION.email,
      telephone: ORGANIZATION.telephone,
    };
  }
  return node;
}

export function websiteNode() {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: `${SITE_URL}/`,
    name: ORGANIZATION.name,
    inLanguage: 'en',
    publisher: { '@id': ORG_ID },
  };
}

// Absolute https://swishtag.com URL for a path or an absolute URL.
export function siteUrl(pathOrUrl = '/') {
  const value = String(pathOrUrl || '/');
  if (value.startsWith(`${SITE_URL}/`) || value === SITE_URL) return value === SITE_URL ? `${SITE_URL}/` : value;
  let path = value;
  try {
    path = new URL(value, `${SITE_URL}/`).pathname;
  } catch {}
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

export function webPageId(url) {
  return `${url}#webpage`;
}

export function webPageNode({ path, url, title, description, type = 'WebPage' }) {
  const pageUrl = url || siteUrl(path);
  const node = {
    '@type': type,
    '@id': webPageId(pageUrl),
    url: pageUrl,
    name: title,
    isPartOf: { '@id': WEBSITE_ID },
    about: { '@id': ORG_ID },
    publisher: { '@id': ORG_ID },
    inLanguage: 'en',
  };
  if (description) node.description = description;
  return node;
}

// FAQPage from a faqs.json entry; only pass the entry the page actually renders.
export function faqNode(faq, pageUrl) {
  const items = Array.isArray(faq?.items) ? faq.items : [];
  if (!items.length) return null;
  return {
    '@type': 'FAQPage',
    '@id': `${pageUrl}#faq`,
    isPartOf: { '@id': webPageId(pageUrl) },
    mainEntity: items.map(item => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

// Strip "@context" from nodes that are placed inside the shared @graph.
export function graphNode(node) {
  if (!node || typeof node !== 'object') return node;
  const { ['@context']: _context, ...rest } = node;
  return rest;
}

// JSON for a <script type="application/ld+json">, with "<" escaped.
export function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
