export function setupListing() {
  const grid = document.querySelector('[data-project-grid]');
  const cards = [...document.querySelectorAll('[data-project-card]')];
  const count = document.querySelector('[data-project-count]');
  const empty = document.querySelector('[data-project-empty]');
  const sort = document.querySelector('[data-project-sort]');
  const searches = [...document.querySelectorAll('[data-project-search]')];
  const pills = [...document.querySelectorAll('[data-category]')];
  const checks = [...document.querySelectorAll('[data-industry]')];
  const toggle = document.querySelector('[data-filter-toggle]');
  const checksWrap = document.querySelector('[data-filter-checks]');
  if (!grid || !count || !empty || !sort) return;

  let category = 'All';
  const selectedIndustries = () => checks.filter((input) => input.checked).map((input) => input.value);

  const render = () => {
    const terms = searches
      .map((input) => input.value.trim().toLowerCase())
      .find(Boolean)
      ?.split(/\s+/)
      .filter(Boolean) ?? [];
    const industries = selectedIndustries();
    const visible = cards.filter((card) => {
      const matchesCategory = category === 'All' || card.dataset.category === category;
      const haystack = card.dataset.search ?? '';
      const matchesSearch = terms.every((term) => haystack.includes(term));
      const matchesIndustry = !industries.length || industries.includes(card.dataset.industry ?? '');
      const showCard = matchesCategory && matchesSearch && matchesIndustry;
      card.hidden = !showCard;
      return showCard;
    });
    const ordered = [...visible].sort((left, right) => {
      const leftName = left.dataset.name ?? '';
      const rightName = right.dataset.name ?? '';
      if (sort.value === 'az') return leftName.localeCompare(rightName);
      if (sort.value === 'za') return rightName.localeCompare(leftName);
      return Number(left.dataset.order) - Number(right.dataset.order);
    });
    ordered.forEach((card) => grid.append(card));
    count.textContent = `Showing ${visible.length} of ${cards.length} Projects`;
    empty.classList.toggle('is-visible', visible.length === 0);
  };

  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      category = pill.dataset.category ?? 'All';
      pills.forEach((item) => item.classList.toggle('is-active', item === pill));
      render();
    });
  });
  checks.forEach((input) => input.addEventListener('change', render));
  searches.forEach((input) => {
    input.addEventListener('input', () => {
      searches.forEach((other) => {
        if (other !== input) other.value = input.value;
      });
      render();
    });
  });
  sort.addEventListener('change', render);
  document.querySelector('[data-filter-clear]')?.addEventListener('click', () => {
    category = 'All';
    pills.forEach((pill) => pill.classList.toggle('is-active', pill.dataset.category === 'All'));
    checks.forEach((input) => {
      input.checked = false;
    });
    searches.forEach((input) => {
      input.value = '';
    });
    sort.value = 'default';
    render();
  });
  toggle?.addEventListener('click', () => {
    const open = checksWrap?.classList.toggle('is-open') ?? false;
    toggle.setAttribute('aria-expanded', String(open));
  });

  render();
}
