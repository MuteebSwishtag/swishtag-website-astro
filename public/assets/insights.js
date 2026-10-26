const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const WORDPRESS_POSTS_API = 'https://cms.swishtag.com/wp-json/wp/v2/posts';
const WORDPRESS_CATEGORIES_API = 'https://cms.swishtag.com/wp-json/wp/v2/categories';
const CMS_MEDIA_HOST = 'cms.swishtag.com';
const PUBLIC_SITE_HOST = 'swishtag.com';
const LEGACY_MEDIA_HOSTS = new Set(['swishtag.com', 'www.swishtag.com', 'dei.bcv.mybluehost.me']);
const POSTS_PER_PAGE = 12;
const FILTER_FALLBACK_SEARCH = {
  shopify: 'shopify',
  'company-stores': 'company store company stores',
  'promotional-products': 'promotional products promo',
  automation: 'automation',
  integrations: 'integration integrations',
  migration: 'migration',
  commerce: 'commerce ecommerce'
};
const EXCLUDED_CATEGORY_SLUGS = new Set(['uncategorized']);
let categoryCache;
let tocObserver;
let tocScrollHandler;
let tocResizeHandler;

function decodeHtml(value = '') {
  const element = document.createElement('textarea');
  element.innerHTML = value;
  return element.value;
}

function stripWordPressShortcodes(value = '') {
  let output = decodeHtml(String(value));
  const shortcodePattern = /\[(?:\/)?(?:vc_[\w-]+|mk_[\w-]+|et_pb_[\w-]+|fusion_[\w-]+|nectar_[\w-]+|porto_[\w-]+|us_[\w-]+|caption|gallery|embed|audio|video|playlist|contact-form-7|gravityform|wp_caption|rev_slider)(?:[^\]]*)?\]/gi;

  for (let index = 0; index < 3; index += 1) {
    output = output.replace(shortcodePattern, ' ');
  }

  return output
    .replace(/\[[A-Za-z_][\w-]*(?:\s+[^\]]*)?\]/g, ' ')
    .replace(/\[\/[A-Za-z_][\w-]*\]/g, ' ');
}

function htmlToText(value = '') {
  const element = document.createElement('div');
  element.innerHTML = stripWordPressShortcodes(value).replace(/<!--[\s\S]*?-->/g, ' ');
  $$('script, style, iframe, noscript', element).forEach(node => node.remove());
  return decodeHtml(element.textContent)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasShortcodeNoise(value = '') {
  return /\b(?:vc_row|vc_column|vc_column_text|full_screen_row_position|column_margin|column_padding|column_direction|row_border_radius|background_color_opacity|background_hover_color_opacity|column_shadow|column_backdrop_filter|overlay_strength|shape_divider_position|bg_image_animation)\b/i.test(value);
}

function truncateText(value = '', maxLength = 185) {
  const text = htmlToText(value);
  if (text.length <= maxLength) return text;
  const shortened = text.slice(0, maxLength).replace(/\s+\S*$/, '').trim();
  return shortened ? `${shortened}...` : text;
}

function getPostExcerpt(post, maxLength = 185) {
  const excerpt = truncateText(post?.excerpt?.rendered || '', maxLength);
  if (excerpt && excerpt.length > 24 && !hasShortcodeNoise(excerpt)) return excerpt;

  const content = truncateText(post?.content?.rendered || '', maxLength);
  if (content && !hasShortcodeNoise(content)) return content;

  return '';
}

function formatDate(value, options = { month: 'short', day: 'numeric' }) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', options).format(date);
}

function estimateReadTime(post) {
  const text = htmlToText(post?.content?.rendered || post?.excerpt?.rendered || '');
  const minutes = Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 220));
  return `${minutes} min read`;
}

function getFeaturedImage(post) {
  const media = post?._embedded?.['wp:featuredmedia']?.[0];
  const sizes = media?.media_details?.sizes || {};
  return normalizeCmsMediaUrl(sizes.large?.source_url || sizes.medium_large?.source_url || sizes.full?.source_url || media?.source_url || '');
}

function getCategory(post) {
  const termGroups = post?._embedded?.['wp:term'] || [];
  const category = termGroups.flat().find(term => term.taxonomy === 'category');
  const text = `${htmlToText(post?.title?.rendered)} ${getPostExcerpt(post)} ${category?.name || ''}`.toLowerCase();
  const inferred = [
    { slug: 'migration', name: 'Migration', terms: ['migration', 'migrate', 'moving to shopify', 'checkout', 'seo'] },
    { slug: 'integrations', name: 'Integrations', terms: ['integration', 'erp', 'api', 'workflow'] },
    { slug: 'automation', name: 'Automation', terms: ['automation', 'fulfillment', 'ai', 'production'] },
    { slug: 'company-stores', name: 'Company Stores', terms: ['company store', 'corporate swag', 'b2b'] },
    { slug: 'promotional-products', name: 'Promotional Products', terms: ['promotional product', 'promo brand', 'promo products', 'print shop', 'custom print'] },
    { slug: 'shopify', name: 'Shopify', terms: ['shopify'] },
    { slug: 'commerce', name: 'Commerce', terms: ['commerce', 'ecommerce', 'e-commerce'] }
  ].find(item => item.terms.some(term => text.includes(term)));

  if (category) return { name: decodeHtml(category.name || 'Blog'), slug: category.slug || normalizeSlug(category.name || 'blog') };
  return inferred || { name: category?.name || 'Blog', slug: category?.slug || 'blog' };
}

function getMappedUrl(value) {
  return window.SwishtagUrlRedirects?.resolve(value) || '';
}

function normalizeCmsMediaUrl(value) {
  if (!value || String(value).trim().startsWith('data:') || String(value).trim().startsWith('blob:')) return value || '';

  try {
    const url = new URL(value, location.href);
    if (!LEGACY_MEDIA_HOSTS.has(url.hostname)) return value;
    url.protocol = 'https:';
    url.hostname = CMS_MEDIA_HOST;
    return url.href;
  } catch (error) {
    return value;
  }
}

function normalizeCmsSrcset(value) {
  if (!value) return '';
  return String(value).split(',').map(candidate => {
    const parts = candidate.trim().split(/\s+/);
    if (!parts.length) return candidate;
    parts[0] = normalizeCmsMediaUrl(parts[0]);
    return parts.join(' ');
  }).join(', ');
}

function normalizePublicSiteUrl(value) {
  if (!value) return '';

  try {
    const url = new URL(value, location.href);
    if (!url.hostname.startsWith('dei.')) return '';
    url.protocol = 'https:';
    url.hostname = PUBLIC_SITE_HOST;
    return url.href;
  } catch (error) {
    return '';
  }
}

function buildPostUrl(post) {
  const mappedPostLink = getMappedUrl(post?.link);
  if (mappedPostLink) return mappedPostLink;

  const slug = post?.slug || '';
  const postUrl = slug ? `/${encodeURIComponent(slug)}/` : '';
  return getMappedUrl(postUrl) || postUrl;
}

function disableLoadingLinks(scope = document) {
  $$('[data-loading-link]', scope).forEach(link => {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '-1');
  });
}

function enableLink(link, href) {
  if (!link || !href) return false;
  link.href = href;
  link.removeAttribute('aria-disabled');
  link.removeAttribute('tabindex');
  link.removeAttribute('data-loading-link');
  return true;
}

function setImage(target, imageUrl, altText) {
  if (!target) return;
  target.innerHTML = '';
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = normalizeCmsMediaUrl(imageUrl);
    img.alt = altText || '';
    img.loading = 'lazy';
    target.appendChild(img);
    return;
  }

  const fallback = document.createElement('div');
  fallback.className = 'insights-image-placeholder';
  fallback.setAttribute('aria-hidden', 'true');
  target.appendChild(fallback);
}

function createCard(post, index) {
  const category = getCategory(post);
  const article = document.createElement('article');
  article.className = 'article-card';
  article.dataset.category = category.slug;

  const link = document.createElement('a');
  const postUrl = buildPostUrl(post);
  if (postUrl) {
    link.href = postUrl;
  } else {
    link.dataset.loadingLink = '';
    link.setAttribute('aria-disabled', 'true');
    link.setAttribute('tabindex', '-1');
  }

  const imageWrap = document.createElement('div');
  imageWrap.className = 'article-image';
  setImage(imageWrap, getFeaturedImage(post), htmlToText(post?.title?.rendered));

  const categoryLabel = document.createElement('div');
  categoryLabel.className = 'card-category';
  categoryLabel.textContent = category.name;

  const title = document.createElement('h3');
  title.textContent = decodeHtml(htmlToText(post?.title?.rendered));

  const excerpt = document.createElement('p');
  excerpt.textContent = getPostExcerpt(post);

  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';

  const meta = document.createElement('div');
  meta.className = 'meta';
  [formatDate(post?.date), estimateReadTime(post)].filter(Boolean).forEach(value => {
    const span = document.createElement('span');
    span.textContent = value;
    meta.appendChild(span);
  });

  const arrow = document.createElement('span');
  arrow.className = 'card-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '\u2192';

  bottom.append(meta, arrow);
  link.append(imageWrap, categoryLabel, title, excerpt, bottom);
  article.appendChild(link);
  return article;
}

function renderFeaturedPost(post) {
  const featured = $('[data-wp-featured-card]');
  if (!featured) return;

  const featuredWrap = featured.closest('.featured-wrap');
  featured.classList.remove('is-loading');
  featured.removeAttribute('aria-busy');

  if (!post) {
    if (featuredWrap) featuredWrap.hidden = true;
    return;
  }

  if (featuredWrap) featuredWrap.hidden = false;

  const category = getCategory(post);
  enableLink(featured, buildPostUrl(post));
  setImage($('.featured-visual', featured), getFeaturedImage(post), htmlToText(post?.title?.rendered));
  $('.featured-content .eyebrow', featured).textContent = category.name;
  $('.featured-content h2', featured).textContent = decodeHtml(htmlToText(post?.title?.rendered));
  $('.featured-content p', featured).textContent = getPostExcerpt(post, 210);

  const meta = $('.featured-content .meta', featured);
  if (meta) {
    meta.innerHTML = '';
    [formatDate(post?.date, { month: 'long', day: 'numeric', year: 'numeric' }), estimateReadTime(post)].filter(Boolean).forEach(value => {
      const span = document.createElement('span');
      span.textContent = value;
      meta.appendChild(span);
    });
  }
}

function renderFeaturedArticleImage(imageUrl, altText) {
  const featuredImage = $('.featured-article-image');
  if (!featuredImage) return;

  featuredImage.innerHTML = '';
  featuredImage.setAttribute('role', 'img');
  featuredImage.setAttribute('aria-label', altText || 'Featured article image');

  const placeholder = document.createElement('div');
  placeholder.className = 'insights-image-placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  featuredImage.appendChild(placeholder);

  if (!imageUrl) {
    featuredImage.classList.remove('is-loading');
    featuredImage.removeAttribute('aria-busy');
    return;
  }

  featuredImage.classList.add('is-loading');
  featuredImage.setAttribute('aria-busy', 'true');
  placeholder.classList.add('insights-image-placeholder--loading');

  const img = document.createElement('img');
  img.className = 'featured-article-image__media';
  img.alt = altText || '';
  img.decoding = 'async';
  img.loading = 'eager';
  if ('fetchPriority' in img) img.fetchPriority = 'high';

  img.addEventListener('load', () => {
    placeholder.remove();
    img.classList.add('is-loaded');
    featuredImage.classList.remove('is-loading');
    featuredImage.removeAttribute('aria-busy');
  }, { once: true });

  img.addEventListener('error', () => {
    img.remove();
    placeholder.classList.remove('insights-image-placeholder--loading');
    featuredImage.classList.remove('is-loading');
    featuredImage.removeAttribute('aria-busy');
  }, { once: true });

  featuredImage.appendChild(img);
  img.src = normalizeCmsMediaUrl(imageUrl);
}

function setListingState(message, isError = false, isLoading = false) {
  const grid = $('[data-wp-posts-grid]');
  if (!grid) return;
  const state = document.createElement('div');
  state.className = `insights-state${isError ? ' insights-state--error' : ''}${isLoading ? ' insights-state--loading' : ''}`;
  state.textContent = message;

  grid.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  grid.replaceChildren(state);
}

function setLoadMoreState(loadMore, { hidden = false, disabled = false, text = 'Load more insights' } = {}) {
  if (!loadMore) return;
  const loadRow = loadMore.closest('.load-row');
  if (loadRow) loadRow.hidden = hidden;
  loadMore.hidden = hidden;
  loadMore.disabled = disabled;
  loadMore.textContent = text;
}

function normalizeSlug(value = '') {
  return value.toLowerCase().replace(/&amp;/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function getCategories() {
  if (categoryCache) return categoryCache;

  const categories = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = new URL(WORDPRESS_CATEGORIES_API);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('_fields', 'id,slug,name,count');

    const response = await fetch(url);
    if (!response.ok) throw new Error(`WordPress categories returned ${response.status}`);

    categories.push(...await response.json());
    totalPages = Number(response.headers.get('X-WP-TotalPages') || page);
    page += 1;
  } while (page <= totalPages);

  categoryCache = categories
    .filter(category => Number(category.count || 0) > 0)
    .filter(category => !EXCLUDED_CATEGORY_SLUGS.has(normalizeSlug(category.slug || category.name || '')))
    .map(category => ({
      ...category,
      name: decodeHtml(htmlToText(category.name || 'Blog')),
      slug: normalizeSlug(category.slug || category.name || 'blog')
    }));
  return categoryCache;
}

async function getCategoryIds(filter) {
  if (!filter || filter === 'all') return [];
  const idMatch = String(filter).match(/^id:(\d+)$/);
  if (idMatch) return [Number(idMatch[1])];

  let categories = [];
  try {
    categories = await getCategories();
  } catch (error) {
    return null;
  }

  const wanted = normalizeSlug(filter);
  const matches = categories.filter(category => {
    const slug = normalizeSlug(category.slug);
    const name = normalizeSlug(category.name);
    return slug === wanted || name === wanted;
  });

  return matches.map(category => category.id);
}

function createFilterButton({ label, value, count, active = false }) {
  const button = document.createElement('button');
  button.className = `filter-pill${active ? ' active' : ''}`;
  button.type = 'button';
  button.dataset.filter = value;
  button.textContent = label;
  if (Number.isFinite(count)) button.dataset.count = String(count);
  return button;
}

function renderCategoryFilters(container, categories, activeFilter = 'all') {
  if (!container || !categories.length) return activeFilter;

  const filters = [
    { label: 'All', value: 'all' },
    ...categories
      .slice()
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || a.name.localeCompare(b.name))
      .map(category => ({
        label: category.name,
        value: `id:${category.id}`,
        count: Number(category.count || 0)
      }))
  ];
  const nextActive = filters.some(filter => filter.value === activeFilter) ? activeFilter : 'all';

  container.innerHTML = '';
  filters.forEach(filter => {
    container.appendChild(createFilterButton({
      ...filter,
      active: filter.value === nextActive
    }));
  });

  return nextActive;
}

async function fetchPosts({ page = 1, filter = 'all', query = '', signal } = {}) {
  const url = new URL(WORDPRESS_POSTS_API);
  const categoryIds = await getCategoryIds(filter);
  if (filter !== 'all' && Array.isArray(categoryIds) && !categoryIds.length) {
    return { posts: [], totalPages: 1 };
  }

  const fallbackSearch = categoryIds === null && filter !== 'all'
    ? FILTER_FALLBACK_SEARCH[filter] || filter.replace(/-/g, ' ')
    : '';

  url.searchParams.set('_embed', '1');
  url.searchParams.set('per_page', String(POSTS_PER_PAGE));
  url.searchParams.set('page', String(page));
  url.searchParams.set('orderby', 'date');
  url.searchParams.set('order', 'desc');

  if (Array.isArray(categoryIds) && categoryIds.length) {
    url.searchParams.set('categories', categoryIds.join(','));
  }

  const search = [query, fallbackSearch].filter(Boolean).join(' ').trim();
  if (search) {
    url.searchParams.set('search', search);
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    if (response.status === 400 && page > 1) {
      return { posts: [], totalPages: page };
    }
    throw new Error(`WordPress returned ${response.status}`);
  }
  return {
    posts: await response.json(),
    totalPages: Number(response.headers.get('X-WP-TotalPages') || page)
  };
}

async function loadListingPosts() {
  const grid = $('[data-wp-posts-grid]');
  if (!grid) return;

  disableLoadingLinks();

  const loadMore = $('[data-wp-load-more]');
  const filterContainer = $('.category-scroll');
  const searchInput = $('#insight-search');
  let page = 1;
  let totalPages = 1;
  let activeFilter = $('.filter-pill.active')?.dataset.filter || 'all';
  let searchQuery = (searchInput?.value || '').trim();
  let requestId = 0;
  let canLoadMore = true;
  let abortController;

  const renderPage = async append => {
    const currentRequest = requestId + 1;
    requestId = currentRequest;
    abortController?.abort();
    abortController = new AbortController();

    if (!append) {
      page = 1;
      totalPages = 1;
      setListingState('Loading insights...', false, true);
      setLoadMoreState(loadMore, { hidden: true, disabled: true, text: 'Loading...' });
    } else {
      setLoadMoreState(loadMore, { hidden: false, disabled: true, text: 'Loading...' });
    }

    const result = await fetchPosts({
      page,
      filter: activeFilter,
      query: searchQuery,
      signal: abortController.signal
    });

    if (currentRequest !== requestId) return;
    const posts = Array.isArray(result.posts) ? result.posts : [];
    totalPages = result.totalPages;

    if (!append) {
      renderFeaturedPost(posts[0]);
      grid.innerHTML = '';
    }

    posts.forEach((post, index) => grid.appendChild(createCard(post, grid.children.length + index)));
    grid.setAttribute('aria-busy', 'false');
    canLoadMore = posts.length === POSTS_PER_PAGE;

    if (!grid.children.length) {
      const emptyFilter = activeFilter === 'all'
        ? ''
        : ` in ${$('.filter-pill.active')?.textContent?.trim() || 'this category'}`;
      const emptySearch = searchQuery ? ` for "${searchQuery}"` : '';
      setListingState(`No insights found${emptyFilter}${emptySearch}.`);
    }

    setLoadMoreState(loadMore, {
      hidden: !canLoadMore,
      disabled: false,
      text: 'Load more insights'
    });
  };

  const resetAndLoad = async () => {
    activeFilter = $('.filter-pill.active')?.dataset.filter || 'all';
    searchQuery = (searchInput?.value || '').trim();
    canLoadMore = true;
    try {
      await renderPage(false);
    } catch (error) {
      if (error.name === 'AbortError') return;
      setListingState('Insights could not be loaded right now. Please try again shortly.', true);
      setLoadMoreState(loadMore, { hidden: true, disabled: false });
    }
  };

  let searchTimer;
  const scheduleSearch = () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(resetAndLoad, 350);
  };

  filterContainer?.addEventListener('click', event => {
    const button = event.target.closest('.filter-pill');
    if (!button || !filterContainer.contains(button) || button.classList.contains('active')) return;
    $$('.filter-pill', filterContainer).forEach(current => current.classList.remove('active'));
    button.classList.add('active');
    resetAndLoad();
  });

  searchInput?.addEventListener('input', scheduleSearch);

  try {
    try {
      activeFilter = renderCategoryFilters(filterContainer, await getCategories(), activeFilter);
    } catch (error) {}
    await renderPage(false);
    loadMore?.addEventListener('click', async () => {
      if (!canLoadMore) {
        setLoadMoreState(loadMore, { hidden: true, disabled: false });
        return;
      }

      page += 1;
      try {
        await renderPage(true);
      } catch (error) {
        if (error.name === 'AbortError') return;
        page -= 1;
        setLoadMoreState(loadMore, { hidden: false, disabled: false, text: 'Try again' });
      }
    });
  } catch (error) {
    if (error.name === 'AbortError') return;
    setListingState('Insights could not be loaded right now. Please try again shortly.', true);
    setLoadMoreState(loadMore, { hidden: true, disabled: false });
  }
}

async function loadSinglePost() {
  const body = $('.article-body');
  const hero = $('.article-hero-main');
  if (!body || !hero) return;

  const params = new URLSearchParams(location.search);
  const isLegacyBlogPage = location.pathname.includes('/insights/blog/');
  const isLegacyChecklistPage = location.pathname.includes('/insights/shopify-migration-checklist-2026/');
  const slug = params.get('slug') || location.pathname.split('/').filter(Boolean).at(-1);
  const currentPath = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
  if (!slug || slug === 'blog') {
    renderSinglePostError('No blog post was selected.');
    return;
  }
  if (!isLegacyBlogPage && !isLegacyChecklistPage && currentPath !== buildPostUrl({ slug })) return;

  let response = await fetch(`${WORDPRESS_POSTS_API}?_embed&slug=${encodeURIComponent(slug)}`);
  if (!response.ok) throw new Error(`WordPress returned ${response.status}`);
  let post = (await response.json())[0];
  if (!post && slug.endsWith('-2026')) {
    response = await fetch(`${WORDPRESS_POSTS_API}?_embed&slug=${encodeURIComponent(slug.replace(/-2026$/, ''))}`);
    if (!response.ok) throw new Error(`WordPress returned ${response.status}`);
    post = (await response.json())[0];
  }
  if (!post) {
    renderSinglePostError('This blog post could not be found.');
    return;
  }

  const category = getCategory(post);
  const cleanPostUrl = `${location.origin}${buildPostUrl(post)}`;
  if (location.href !== cleanPostUrl) {
    window.history.replaceState({}, '', cleanPostUrl);
  }
  document.title = `${htmlToText(post.title.rendered)} | Swishtag`;
  const postExcerpt = getPostExcerpt(post, 220);
  const description = $('meta[name="description"]');
  if (description) description.setAttribute('content', postExcerpt);
  const canonical = $('link[rel="canonical"]');
  if (canonical) canonical.setAttribute('href', cleanPostUrl);
  const metaUpdates = {
    'og:title': htmlToText(post.title.rendered),
    'og:description': postExcerpt,
    'og:url': cleanPostUrl
  };
  Object.entries(metaUpdates).forEach(([property, content]) => {
    const tag = $(`meta[property="${property}"]`);
    if (tag) tag.setAttribute('content', content);
  });
  const schema = $('script[type="application/ld+json"]');
  if (schema) {
    schema.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: htmlToText(post.title.rendered),
      datePublished: post.date,
      dateModified: post.modified,
      author: { '@type': 'Organization', name: 'Swishtag' },
      publisher: { '@type': 'Organization', name: 'Swishtag' },
      mainEntityOfPage: cleanPostUrl
    });
  }

  const breadcrumbTitle = $('.article-hero .breadcrumbs span:last-child');
  if (breadcrumbTitle) breadcrumbTitle.textContent = htmlToText(post.title.rendered);
  const breadcrumbCategory = $('.article-hero .breadcrumbs a:nth-of-type(2)');
  if (breadcrumbCategory) breadcrumbCategory.textContent = category.name;
  $('.eyebrow', hero).textContent = category.name;
  $('h1', hero).textContent = decodeHtml(htmlToText(post.title.rendered));
  $('.article-dek', hero).textContent = postExcerpt;

  const heroMeta = $('.hero-meta', hero);
  if (heroMeta) {
    heroMeta.innerHTML = '';
    ['Swishtag Team', formatDate(post.date, { month: 'long', day: 'numeric', year: 'numeric' }), estimateReadTime(post)].forEach(value => {
      const span = document.createElement('span');
      span.textContent = value;
      heroMeta.appendChild(span);
    });
  }

  renderFeaturedArticleImage(getFeaturedImage(post), htmlToText(post.title.rendered));

  const dynamicWrapper = document.createElement('div');
  dynamicWrapper.innerHTML = stripWordPressShortcodes(post.content.rendered);
  prepareArticleContent(dynamicWrapper);
  body.innerHTML = '';
  body.appendChild(dynamicWrapper);
  renderTableOfContents(body);
  initTocObserver();
}

function renderSinglePostError(message) {
  const body = $('.article-body');
  const hero = $('.article-hero-main');
  if (hero) {
    $('.eyebrow', hero).textContent = 'INSIGHTS';
    $('h1', hero).textContent = 'Insight unavailable';
    $('.article-dek', hero).textContent = message;
  }
  renderFeaturedArticleImage('', 'Insight unavailable');
  if (body) body.innerHTML = `<div class="takeaway"><strong>Sorry about that.</strong>${message}</div>`;
}

function prepareArticleContent(wrapper) {
  $$('script, style, iframe', wrapper).forEach(element => element.remove());
  $$('#ez-toc-container', wrapper).forEach(element => element.remove());
  $$('img', wrapper).forEach(image => {
    const lazySrc = image.dataset.src || image.dataset.lazySrc || image.getAttribute('data-original');
    const lazySrcset = image.dataset.srcset || image.dataset.lazySrcset;
    const lazySizes = image.dataset.sizes;
    const currentSrc = image.getAttribute('src') || '';

    if (lazySrc && (!currentSrc || currentSrc.startsWith('data:image'))) {
      image.src = normalizeCmsMediaUrl(lazySrc);
    }
    if (lazySrcset && !image.getAttribute('srcset')) {
      image.setAttribute('srcset', normalizeCmsSrcset(lazySrcset));
    }
    if (image.getAttribute('src')) image.src = normalizeCmsMediaUrl(image.getAttribute('src'));
    if (image.getAttribute('srcset')) image.setAttribute('srcset', normalizeCmsSrcset(image.getAttribute('srcset')));
    if (lazySizes && !image.getAttribute('sizes')) {
      const sizes = lazySizes.replace(/^auto,\s*/i, '').trim();
      if (sizes && sizes !== 'auto') image.setAttribute('sizes', sizes);
    }

    image.loading = 'lazy';
    image.decoding = 'async';
    image.classList.remove('lazyload', 'lazyloaded');
    image.removeAttribute('data-src');
    image.removeAttribute('data-srcset');
    image.removeAttribute('data-sizes');
    image.removeAttribute('data-lazy-src');
    image.removeAttribute('data-lazy-srcset');
    image.removeAttribute('data-original');
  });
  $$('source[srcset]', wrapper).forEach(source => {
    source.setAttribute('srcset', normalizeCmsSrcset(source.getAttribute('srcset')));
  });
  $$('a[href]', wrapper).forEach(link => {
    const href = link.getAttribute('href');
    const mappedHref = getMappedUrl(href);
    if (mappedHref) {
      link.href = mappedHref;
      return;
    }

    try {
      const url = new URL(href, location.href);
      const publicHref = normalizePublicSiteUrl(href);
      if (publicHref) {
        link.href = publicHref;
        return;
      }

      if (url.hostname === 'swishtag.com' && url.pathname.startsWith('/blogs/')) {
        const slug = url.pathname.split('/').filter(Boolean).at(-1);
        if (slug) {
          const postHref = `/${encodeURIComponent(slug)}/`;
          link.href = getMappedUrl(postHref) || postHref;
        }
      }
      if (url.pathname.startsWith('/insights/blog/')) {
        const slug = url.searchParams.get('slug');
        if (slug) {
          const postHref = `/${encodeURIComponent(slug)}/`;
          link.href = getMappedUrl(postHref) || postHref;
        }
      }
    } catch (error) {}
  });
}

function renderTableOfContents(body) {
  const headings = $$('h2', body).slice(0, 8);
  const toc = $('.toc');
  const mobileToc = $('.toc-mobile div');
  const mobileSummary = $('.toc-mobile summary');

  if (!headings.length) {
    if (toc) toc.hidden = true;
    if ($('.toc-mobile')) $('.toc-mobile').hidden = true;
    return;
  }

  const links = headings.map((heading, index) => {
    if (!heading.id) heading.id = `section-${index + 1}`;
    const a = document.createElement('a');
    a.href = `#${heading.id}`;
    a.textContent = heading.textContent;
    return a;
  });

  if (toc) {
    toc.hidden = false;
    toc.innerHTML = '<h4>In this insight</h4>';
    links.forEach(link => toc.appendChild(link.cloneNode(true)));
  }

  if (mobileToc) {
    if (mobileSummary) mobileSummary.textContent = 'In this insight';
    mobileToc.innerHTML = '';
    links.forEach(link => mobileToc.appendChild(link.cloneNode(true)));
    $('.toc-mobile').hidden = false;
  }
}

loadListingPosts();
loadSinglePost().catch(() => {});

// Reading progress
const progress = $('.progress');
if (progress) {
  window.addEventListener('scroll', () => {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const value = max > 0 ? (doc.scrollTop / max) * 100 : 0;
    progress.style.width = `${value}%`;
  }, { passive: true });
}

// TOC active state
function initTocObserver() {
  if (tocObserver) tocObserver.disconnect();
  if (tocScrollHandler) window.removeEventListener('scroll', tocScrollHandler);
  if (tocResizeHandler) window.removeEventListener('resize', tocResizeHandler);
  const tocLinks = $$('.toc a, .toc-mobile a');
  const sections = [...new Set(tocLinks.map(link => link.getAttribute('href')))]
    .map(href => document.querySelector(href))
    .filter(Boolean);
  if (!sections.length) return;

  const setActiveSection = id => {
    tocLinks.forEach(link => {
      link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
    });
  };

  const getHeaderOffset = () => {
    const header = document.querySelector('header');
    return (header?.getBoundingClientRect().height || 90) + 34;
  };

  const updateActiveSection = () => {
    const activationLine = Math.max(getHeaderOffset() + 64, window.innerHeight * 0.3);
    const activeSection = sections.reduce((current, section) => {
      const top = section.getBoundingClientRect().top;
      if (top <= activationLine) return section;
      return current;
    }, sections[0]);

    setActiveSection(activeSection.id);
  };

  let ticking = false;
  const requestActiveUpdate = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      updateActiveSection();
      ticking = false;
    });
  };

  tocLinks.forEach(link => {
    link.addEventListener('click', () => {
      const id = link.getAttribute('href')?.slice(1);
      if (id) {
        setActiveSection(id);
        window.setTimeout(updateActiveSection, 350);
      }
    });
  });

  tocScrollHandler = requestActiveUpdate;
  tocResizeHandler = requestActiveUpdate;
  window.addEventListener('scroll', tocScrollHandler, { passive: true });
  window.addEventListener('resize', tocResizeHandler);

  tocObserver = new IntersectionObserver(requestActiveUpdate, {
    rootMargin: `-${getHeaderOffset()}px 0px -55% 0px`,
    threshold: 0
  });
  sections.forEach(section => tocObserver.observe(section));
  updateActiveSection();
}
initTocObserver();

// FAQ
$$('.faq-question').forEach(button => {
  button.addEventListener('click', () => {
    const item = button.closest('.faq-item');
    const open = item.classList.toggle('open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
});
