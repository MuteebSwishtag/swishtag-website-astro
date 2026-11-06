const bySlug = /* @__PURE__ */ new Map();
function text(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}
function show(id, visible) {
  document.getElementById(id)?.toggleAttribute("hidden", !visible);
}
function setupListing(records) {
  records.forEach((record) => bySlug.set(record.slug, record));
  const grid = document.querySelector("[data-project-grid]");
  const cards = [...document.querySelectorAll("[data-project-card]")];
  const count = document.querySelector("[data-project-count]");
  const empty = document.querySelector("[data-project-empty]");
  const sort = document.querySelector("[data-project-sort]");
  const searches = [...document.querySelectorAll("[data-project-search]")];
  const pills = [...document.querySelectorAll("[data-category]")];
  const checks = [...document.querySelectorAll("[data-industry]")];
  const toggle = document.querySelector("[data-filter-toggle]");
  const checksWrap = document.querySelector("[data-filter-checks]");
  const panel = document.querySelector("#projectPanel");
  if (!grid || !count || !empty || !sort || !panel) return;
  let category = "All";
  const selectedIndustries = () => checks.filter((input) => input.checked).map((input) => input.value);
  const render = () => {
    const terms = searches.map((input) => input.value.trim().toLowerCase()).find(Boolean)?.split(/\s+/).filter(Boolean) ?? [];
    const industries = selectedIndustries();
    const visible = cards.filter((card) => {
      const matchesCategory = category === "All" || card.dataset.category === category;
      const haystack = card.dataset.search ?? "";
      const matchesSearch = terms.every((term) => haystack.includes(term));
      const matchesIndustry = !industries.length || industries.includes(card.dataset.industry ?? "");
      const showCard = matchesCategory && matchesSearch && matchesIndustry;
      card.hidden = !showCard;
      return showCard;
    });
    const ordered = [...visible].sort((a, b) => {
      const left = a.dataset.name ?? "";
      const right = b.dataset.name ?? "";
      if (sort.value === "az") return left.localeCompare(right);
      if (sort.value === "za") return right.localeCompare(left);
      return Number(a.dataset.order) - Number(b.dataset.order);
    });
    ordered.forEach((card) => grid.append(card));
    count.textContent = `Showing ${visible.length} of ${cards.length} Projects`;
    empty.classList.toggle("is-visible", visible.length === 0);
  };
  pills.forEach((pill) => {
    pill.addEventListener("click", () => {
      category = pill.dataset.category ?? "All";
      pills.forEach((item) => item.classList.toggle("is-active", item === pill));
      render();
    });
  });
  checks.forEach((input) => input.addEventListener("change", render));
  searches.forEach((input) => {
    input.addEventListener("input", () => {
      searches.forEach((other) => {
        if (other !== input) other.value = input.value;
      });
      render();
    });
  });
  sort.addEventListener("change", render);
  document.querySelector("[data-filter-clear]")?.addEventListener("click", () => {
    category = "All";
    pills.forEach((pill) => pill.classList.toggle("is-active", pill.dataset.category === "All"));
    checks.forEach((input) => {
      input.checked = false;
    });
    searches.forEach((input) => {
      input.value = "";
    });
    sort.value = "default";
    render();
  });
  toggle?.addEventListener("click", () => {
    const open = checksWrap?.classList.toggle("is-open") ?? false;
    toggle.setAttribute("aria-expanded", String(open));
  });
  const shown = (value) => value && value !== "Not specified" && value !== "To be confirmed" && value !== "Uncategorized" ? value : "";
  const openPanel = (slug) => {
    const record = bySlug.get(slug);
    if (!record || record.href) return;
    const story = record.panel;
    const category2 = shown(story?.category) || record.category;
    const industry = shown(story?.industry) || shown(record.industry);
    const platform = shown(story?.platform) || shown(record.platform);
    text("panelKicker", `Swishtag / ${category2}`);
    text("panelIndex", `${String([...bySlug.keys()].indexOf(slug) + 1).padStart(2, "0")} / ${bySlug.size}`);
    text("panelTitle", record.name);
    text("panelLead", story?.title ?? record.sourceCategory);
    text("panelIntro", story?.intro ?? "Selected Swishtag work.");
    const chips = document.querySelector("#panelChips");
    if (chips) {
      chips.replaceChildren();
      [category2, industry, platform].filter(Boolean).forEach((value) => {
        const chip = document.createElement("span");
        chip.textContent = value;
        chips.append(chip);
      });
    }
    const logo = document.querySelector("#panelLogo");
    if (logo) {
      if (story?.logo) {
        logo.hidden = false;
        logo.src = story.logo;
        logo.alt = `${record.name} logo`;
      } else {
        logo.hidden = true;
        logo.removeAttribute("src");
      }
    }
    text("panelProject", record.name);
    text("panelIndustry", industry);
    text("panelPlatform", platform);
    text("panelCategory", category2);
    show("panelIndustryWrap", Boolean(industry));
    show("panelPlatformWrap", Boolean(platform));
    const visual = document.querySelector("#panelImage");
    if (visual) {
      visual.src = record.image;
      visual.alt = `${record.name} project preview`;
    }
    show("panelOpportunity", Boolean(story?.opportunity));
    text("panelOpportunityTitle", story?.opportunityTitle ?? "");
    text("panelOpportunityBody", story?.opportunity ?? "");
    const features = document.querySelector("#panelFeatures");
    if (features) {
      features.replaceChildren();
      (story?.features ?? []).forEach(([title, body], index) => {
        const item = document.createElement("article");
        item.className = "cs-feature";
        const label = document.createElement("small");
        label.textContent = `${String(index + 1).padStart(2, "0")} / Core capability`;
        const heading = document.createElement("h3");
        heading.textContent = title;
        const copy = document.createElement("p");
        copy.textContent = body;
        item.append(label, heading, copy);
        features.append(item);
      });
      features.toggleAttribute("hidden", !(story?.features ?? []).length);
    }
    show("panelFeatureBlock", Boolean(story?.features?.length));
    show("panelExperience", Boolean(story?.experience));
    text("panelExperienceTitle", story?.experienceTitle ?? "");
    text("panelExperienceBody", story?.experience ?? "");
    show("panelStatus", Boolean(story?.status));
    text("panelStatus", story?.status ?? "");
    show("panelTakeawayWrap", Boolean(story?.takeaway));
    text("panelTakeaway", story?.takeaway ?? "");
    text("panelSubtitle", story?.subtitle ?? "");
    const shots = document.querySelector("#panelShots");
    if (shots) {
      shots.replaceChildren();
      record.gallery.forEach((src, index) => {
        const figure = document.createElement("figure");
        figure.className = "cs-shot";
        const image = document.createElement("img");
        image.src = src;
        image.alt = `${record.name} project screenshot ${index + 2}`;
        figure.append(image);
        shots.append(figure);
      });
      shots.toggleAttribute("hidden", record.gallery.length === 0);
    }
    show("panelShotsBlock", record.gallery.length > 0);
    const link = document.querySelector("#panelExternal");
    if (link) {
      if (story?.url) {
        link.hidden = false;
        link.href = story.url;
      } else {
        link.hidden = true;
        link.removeAttribute("href");
      }
    }
    const related = document.querySelector("#panelRelated");
    if (related) {
      related.replaceChildren();
      [...bySlug.values()].filter((item) => item.slug !== record.slug && item.image).slice(0, 3).forEach((item) => {
        const control = document.createElement(item.href ? "a" : "button");
        control.className = "cs-explore-card";
        if (item.href) control.setAttribute("href", item.href);
        else control.setAttribute("type", "button");
        control.dataset.relatedSlug = item.slug;
        const image = document.createElement("img");
        image.src = item.image;
        image.alt = `${item.name} project preview`;
        const label = document.createElement("strong");
        label.textContent = item.name;
        control.append(image, label);
        related.append(control);
      });
    }
    if (!panel.open) panel.showModal();
    if (location.hash !== `#${slug}`) history.replaceState(null, "", `#${slug}`);
  };
  grid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-project-card]");
    if (!card || card.dataset.href) return;
    event.preventDefault();
    const slug = card.dataset.slug;
    if (slug) openPanel(slug);
  });
  panel.addEventListener("click", (event) => {
    const related = event.target.closest("[data-related-slug]");
    if (!related || related.tagName === "A") return;
    event.preventDefault();
    const slug = related.dataset.relatedSlug;
    if (slug) openPanel(slug);
  });
  panel.querySelector("[data-panel-close]")?.addEventListener("click", () => panel.close());
  panel.addEventListener("click", (event) => {
    if (event.target === panel) panel.close();
  });
  panel.addEventListener("close", () => {
    if (location.hash) history.replaceState(null, "", location.pathname);
  });
  const hash = location.hash.replace("#", "");
  if (hash && bySlug.has(hash) && !bySlug.get(hash)?.href) openPanel(hash);
  render();
}
export {
  setupListing
};
