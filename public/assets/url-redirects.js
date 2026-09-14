(function () {
  const REDIRECTS = Object.freeze({
    "/contact-us/": "/book-demo/",
    "/services/": "/solutions/custom-software-automation/",
    "/shopify-company-store/": "/solutions/shopify-company-store/",
    "/shopify-sage-connect-integration/": "/solutions/shopify-sage-connect-integration/",
    "/enterprise-shopify-automation/": "/solutions/enterprise-shopify-automation/",
    "/shopify-migration-service/": "/solutions/custom-software-automation/",
    "/shopify-development-agency-swishtag/": "/solutions/custom-software-automation/",
    "/ui-ux-design-services/": "/solutions/custom-software-automation/",
    "/shopify-agency-new-york/": "/solutions/custom-software-automation/",
    "/shopify-theme-development/": "/solutions/custom-software-automation/",
    "/shopify-ecommerce-solutions-for-promotional-product-distributors/": "/solutions/shopify-company-store/",
    "/shopify-customer-migration/": "/solutions/custom-software-automation/",
    "/platform/": "/platforms/",
    "/punchout-solutions/": "/platforms/punchout-solutions/",
    "/promo-plus/": "/platforms/promo-plus/",
    "/xecutor/": "/platforms/xecutor/",
    "/shopify-apps-for-promotional-products/": "/platforms/shopify-apps-for-promotional-products/",
    "/rocket-apps/": "/platforms/shopify-apps-for-promotional-products/",
    "/rocket-gift-card-and-discount-shopify-app/": "/platforms/shopify-apps-for-promotional-products/",
    "/platform/punchout/": "/platforms/punchout-solutions/",
    "/product/punchout/": "/platforms/punchout-solutions/",
    "/platform/purchase-orders/": "/platforms/punchout-solutions/",
    "/platform/invoices/": "/platforms/punchout-solutions/",
    "/platform/multi-store/": "/platforms/",
    "/platform/transactions/": "/platforms/",
    "/integrations/": "/platforms/",
    "/integrations/cxml/": "/platforms/punchout-solutions/",
    "/integrations/jaggaer/": "/platforms/punchout-solutions/",
    "/integrations/sap-ariba/": "/platforms/punchout-solutions/",
    "/integrations/coupa/": "/platforms/punchout-solutions/",
    "/integrations/oci/": "/platforms/punchout-solutions/",
    "/integrations/oracle/": "/platforms/punchout-solutions/",
    "/integrations/workday/": "/platforms/punchout-solutions/",
    "/promotional-products-distributors/": "/industries/promotional-products-distributors/",
    "/promotional-products-suppliers/": "/industries/promotional-products-suppliers/",
    "/promotional-products-decorators/": "/industries/promotional-products-decorators/",
    "/industries/promotional-print-uniforms/": "/industries/promotional-products-distributors/",
    "/industries/industrial-mro/": "/industries/",
    "/industries/lab-scientific/": "/industries/",
    "/manufacturing-execution-system/": "/platforms/xecutor/"
  });

  const PUBLIC_SITE_ORIGIN = "https://swishtag.com";
  const TRUSTED_HOSTS = new Set(["swishtag.com", "www.swishtag.com"]);

  function normalizePath(pathname) {
    if (!pathname) return "/";

    let value = String(pathname).trim();
    try {
      value = decodeURIComponent(value);
    } catch (error) {}

    value = value.replace(/\/{2,}/g, "/").toLowerCase();
    if (!value.startsWith("/")) value = `/${value}`;
    if (!value.endsWith("/")) value = `${value}/`;
    return value;
  }

  function isTrustedHost(url) {
    return url.hostname === window.location.hostname || TRUSTED_HOSTS.has(url.hostname) || url.hostname.startsWith("dei.");
  }

  function withOriginalSuffix(target, sourceUrl) {
    try {
      const targetOrigin = sourceUrl.hostname.startsWith("dei.") ? PUBLIC_SITE_ORIGIN : window.location.origin;
      const targetUrl = new URL(target, targetOrigin);
      if (!targetUrl.search && sourceUrl.search) targetUrl.search = sourceUrl.search;
      if (!targetUrl.hash && sourceUrl.hash) targetUrl.hash = sourceUrl.hash;
      return targetUrl.origin === window.location.origin
        ? `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
        : targetUrl.href;
    } catch (error) {
      return target;
    }
  }

  function resolve(value, base = window.location.href) {
    if (!value) return "";

    try {
      const url = new URL(value, base);
      if (!isTrustedHost(url)) return "";

      const target = REDIRECTS[normalizePath(url.pathname)];
      return target ? withOriginalSuffix(target, url) : "";
    } catch (error) {
      return "";
    }
  }

  window.SwishtagUrlRedirects = {
    redirects: REDIRECTS,
    normalizePath,
    resolve
  };

  const currentTarget = resolve(window.location.href);
  if (currentTarget) {
    const currentUrl = new URL(window.location.href);
    const targetUrl = new URL(currentTarget, window.location.origin);
    if (targetUrl.href !== currentUrl.href) window.location.replace(targetUrl.href);
  }
})();
