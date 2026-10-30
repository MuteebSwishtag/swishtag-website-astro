// Leave pending content empty until Hammaad supplies the approved assets.
export const companyStoreMedia = {
  demoStoreUrl: '',
  trustpilotUrl: '',
  clubColors: { quote: '', name: '', title: '', imageUrl: '' },
  video: { url: '', posterUrl: '', captionsUrl: '' },
};

export const companyStoreService = {
  "@context": "https://schema.org",
  "@type": "Service",
  "name": "Company Store Design, Launch & Management",
  "serviceType": "Branded Shopify company store design, launch, and ongoing care for promotional products distributors",
  "provider": {
    "@type": "Organization",
    "name": "Swishtag",
    "url": "https://swishtag.com/"
  },
  "areaServed": "United States",
  "url": "https://swishtag.com/solutions/shopify-company-store/",
  "audience": {
    "@type": "BusinessAudience",
    "audienceType": "Promotional products distributors and corporate clients"
  },
  "description": "Company stores, done for you. Swishtag designs, launches and supports branded Shopify company stores for promotional products distributors.",
  "offers": [
    {
      "@type": "Offer",
      "name": "First company store",
      "price": "1200",
      "priceCurrency": "USD",
      "description": "One-time fee for the first custom branded store. Launch about 10 business days after content is received.",
      "url": "https://swishtag.com/solutions/shopify-company-store/#pricing"
    },
    {
      "@type": "Offer",
      "name": "Additional store cloned from template",
      "price": "300",
      "priceCurrency": "USD",
      "description": "One-time fee per additional store cloned from a template. Launch in 2 to 3 business days.",
      "url": "https://swishtag.com/solutions/shopify-company-store/#pricing"
    },
    {
      "@type": "Offer",
      "name": "Care Plan",
      "priceCurrency": "USD",
      "priceSpecification": {
        "@type": "UnitPriceSpecification",
        "price": "100",
        "priceCurrency": "USD",
        "unitText": "month",
        "referenceQuantity": {
          "@type": "QuantitativeValue",
          "value": 1,
          "unitCode": "MON"
        }
      },
      "description": "Care Plan, $100 a month per store, cancel anytime. Billed as one charge on the client's Shopify bill through one Swishtag company store app. Covers all store features plus updates, fixes, and support within 1 business day.",
      "url": "https://swishtag.com/solutions/shopify-company-store/#care"
    }
  ]
};

export const companyStoreBreadcrumbs = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Home",
      "item": "https://swishtag.com/"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Solutions",
      "item": "https://swishtag.com/solutions/"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "Shopify Company Store",
      "item": "https://swishtag.com/solutions/shopify-company-store/"
    }
  ]
};
