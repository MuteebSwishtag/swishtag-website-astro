(() => {
  const page = document.querySelector('[data-project-page]');
  if (!page) return;

  const CMS_MEDIA_HOST = 'cms.swishtag.com';
  const LEGACY_MEDIA_HOSTS = new Set([
    'swishtag.com',
    'www.swishtag.com',
    'dei.bcv.mybluehost.me',
  ]);

  const select = (selector, scope = document) => scope.querySelector(selector);
  const selectAll = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  function decodeHtml(value = '') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = String(value);
    return textarea.value;
  }

  function htmlToText(value = '') {
    const element = document.createElement('div');
    element.innerHTML = String(value)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(?:div|h[1-6]|li|ol|p|section|ul)>/gi, ' ');
    selectAll('script, style, iframe, noscript', element).forEach((node) => node.remove());
    return decodeHtml(element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(value = '', maxLength = 220) {
    const text = htmlToText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).replace(/\s+\S*$/, '').trim()}...`;
  }

  function normalizeMediaUrl(value = '') {
    if (!value || String(value).startsWith('data:') || String(value).startsWith('blob:')) {
      return value;
    }

    try {
      const url = new URL(value, window.location.href);
      if (!LEGACY_MEDIA_HOSTS.has(url.hostname) || !url.pathname.startsWith('/wp-content/')) {
        return value;
      }
      url.protocol = 'https:';
      url.hostname = CMS_MEDIA_HOST;
      return url.href;
    } catch (error) {
      return value;
    }
  }

  function normalizeSrcset(value = '') {
    return String(value)
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        if (parts[0]) parts[0] = normalizeMediaUrl(parts[0]);
        return parts.join(' ');
      })
      .join(', ');
  }

  function getFeaturedImage(project) {
    const media = project?._embedded?.['wp:featuredmedia']?.[0];
    const sizes = media?.media_details?.sizes || {};
    return normalizeMediaUrl(
      sizes.full?.source_url
      || sizes.large?.source_url
      || sizes.medium_large?.source_url
      || media?.source_url
      || '',
    );
  }

  function getProjectType(project) {
    const terms = (project?._embedded?.['wp:term'] || []).flat();
    const projectType = terms.find((term) =>
      ['project-type', 'project_type', 'portfolio-type'].includes(term?.taxonomy),
    );
    return htmlToText(projectType?.name || '') || 'Swishtag project';
  }

  function getProjectSummary(project, renderedContent) {
    const excerpt = htmlToText(project?.excerpt?.rendered || '');
    if (excerpt.length >= 40) return truncate(excerpt, 220);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderedContent;
    const paragraph = selectAll('p', wrapper)
      .map((element) => htmlToText(element.innerHTML))
      .find((text) => text.length >= 60);

    return truncate(paragraph || renderedContent, 220)
      || 'A project designed and built by Swishtag.';
  }

  function sanitizeProjectContent(html = '') {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;

    selectAll('script, style, iframe, object, embed, form, link, meta, base', wrapper)
      .forEach((element) => element.remove());

    selectAll('*', wrapper).forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (name.startsWith('on') || name === 'srcdoc') {
          element.removeAttribute(attribute.name);
          return;
        }
        if (['href', 'src', 'poster', 'action', 'xlink:href'].includes(name)
          && /^\s*(?:javascript|vbscript):/i.test(value)) {
          element.removeAttribute(attribute.name);
        }
      });
    });

    const contentRoot = wrapper.children.length === 1
      && wrapper.firstElementChild?.classList.contains('wpb-content-wrapper')
      ? wrapper.firstElementChild
      : wrapper;

    [...contentRoot.children]
      .filter((element) => element.matches('.vc_row, .wpb_row'))
      .filter((element) => {
        const text = htmlToText(element.innerHTML).toLowerCase();
        return text.includes('have a project in mind') && text.includes('get in touch');
      })
      .forEach((element) => element.remove());

    selectAll('.nectar-scrolling-text-inner', wrapper).forEach((scroller) => {
      selectAll('.nectar-scrolling-text-inner__text-chunk', scroller)
        .slice(1)
        .forEach((duplicate) => duplicate.remove());
    });

    selectAll('.nectar-post-grid-filters', wrapper).forEach((filters) => filters.remove());

    selectAll('img', wrapper).forEach((image) => {
      const lazySrc = image.dataset.nectarImgSrc
        || image.dataset.src
        || image.dataset.lazySrc
        || image.dataset.original;
      const currentSrc = image.getAttribute('src') || '';
      if (lazySrc && (!currentSrc || currentSrc.startsWith('data:image'))) {
        image.src = normalizeMediaUrl(lazySrc);
      } else if (currentSrc) {
        image.src = normalizeMediaUrl(currentSrc);
      }

      const lazySrcset = image.dataset.nectarImgSrcset
        || image.dataset.srcset
        || image.dataset.lazySrcset;
      const currentSrcset = image.getAttribute('srcset');
      if (currentSrcset || lazySrcset) {
        image.setAttribute('srcset', normalizeSrcset(currentSrcset || lazySrcset));
      }

      image.loading = 'lazy';
      image.decoding = 'async';
      image.removeAttribute('width');
      image.removeAttribute('height');
    });

    selectAll('a', wrapper).forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      try {
        const url = new URL(href, window.location.href);
        if (LEGACY_MEDIA_HOSTS.has(url.hostname) && url.pathname.startsWith('/project/')) {
          link.href = `${url.pathname}${url.search}${url.hash}`;
        }
      } catch (error) {}
    });

    return wrapper;
  }

  function updateMeta(project, title, summary, imageUrl) {
    const canonicalUrl = `${window.location.origin}/project/${encodeURIComponent(project.slug)}/`;
    document.title = `${title} | Swishtag`;

    const setMeta = (selector, content) => {
      const tag = select(selector);
      if (tag && content) tag.setAttribute('content', content);
    };

    setMeta('meta[name="description"]', summary);
    setMeta('meta[property="og:title"]', title);
    setMeta('meta[property="og:description"]', summary);
    setMeta('meta[property="og:url"]', canonicalUrl);
    setMeta('meta[property="og:image"]', imageUrl);
    setMeta('meta[name="twitter:image"]', imageUrl);

    const canonical = select('link[rel="canonical"]');
    if (canonical) canonical.href = canonicalUrl;

    const schema = select('[data-project-schema]');
    if (schema) {
      schema.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CreativeWork',
        name: title,
        description: summary,
        image: imageUrl || undefined,
        datePublished: project.date || undefined,
        dateModified: project.modified || undefined,
        url: canonicalUrl,
        creator: { '@id': 'https://swishtag.com/#organization' },
      });
    }
  }

  function renderProject(project) {
    const title = htmlToText(project?.title?.rendered || project?.title || 'Project');
    const renderedContent = project?.content?.rendered || '';
    const summary = getProjectSummary(project, renderedContent);
    const imageUrl = getFeaturedImage(project);

    select('[data-project-title]').textContent = title;
    select('[data-project-summary]').textContent = summary;
    select('[data-project-breadcrumb]').textContent = title;
    select('[data-project-type]').textContent = getProjectType(project);

    const media = select('[data-project-image]');
    media.classList.remove('is-loading');
    media.innerHTML = '';
    if (imageUrl) {
      const image = document.createElement('img');
      image.src = imageUrl;
      image.alt = title;
      image.decoding = 'async';
      image.fetchPriority = 'high';
      media.appendChild(image);
      media.removeAttribute('aria-hidden');
    } else {
      media.hidden = true;
    }

    const content = select('[data-project-content]');
    const safeContent = sanitizeProjectContent(renderedContent);
    content.replaceChildren(...safeContent.childNodes);
    content.hidden = false;

    const state = select('[data-project-state]');
    state.hidden = true;
    select('[data-project-cta]').hidden = false;
    page.classList.remove('is-loading', 'has-error');
    page.classList.add('is-ready');
    page.removeAttribute('aria-busy');
    updateMeta(project, title, summary, imageUrl);
  }

  function renderError(kind) {
    const isMissing = kind === 'missing';
    const title = isMissing ? 'Project not found' : 'Project unavailable';
    const summary = isMissing
      ? 'This project may have moved or is no longer published.'
      : 'We could not load this project from the Swishtag portfolio right now.';

    select('[data-project-title]').textContent = title;
    select('[data-project-summary]').textContent = summary;
    select('[data-project-breadcrumb]').textContent = title;
    select('[data-project-type]').textContent = isMissing ? '404' : 'Portfolio';
    select('[data-project-image]').hidden = true;

    const state = select('[data-project-state]');
    state.classList.add('is-error');
    state.innerHTML = `<strong>${title}</strong><span>${summary}</span><a href="/">Return home -&gt;</a>`;
    state.hidden = false;

    page.classList.remove('is-loading');
    page.classList.add('has-error');
    page.removeAttribute('aria-busy');
    document.title = `${title} | Swishtag`;
    const robots = select('meta[name="robots"]');
    if (isMissing && robots) robots.setAttribute('content', 'noindex,follow');
  }

  async function loadProject() {
    const slug = page.dataset.projectSlug || '';
    const endpoint = page.dataset.projectApi || '';
    if (!slug || !endpoint) {
      renderError('missing');
      return;
    }

    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set('slug', slug);
      url.searchParams.set('_embed', '1');
      url.searchParams.set('per_page', '1');

      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (response.status === 404) {
        renderError('missing');
        return;
      }
      if (!response.ok) throw new Error(`WordPress returned ${response.status}`);

      const projects = await response.json();
      const project = Array.isArray(projects) ? projects[0] : projects;
      if (!project?.slug) {
        renderError('missing');
        return;
      }

      renderProject(project);
    } catch (error) {
      renderError('api');
    }
  }

  loadProject();
})();
