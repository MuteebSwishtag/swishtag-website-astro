import {
  buildOfferedSlots,
  groupSlotsByDate,
  slotIsBusy,
  timezoneLabel,
} from "../../lib/meeting-slots.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function initBookDemoForm() {
  const form = document.getElementById("demoForm");
  if (!form) return;

  const flow = document.getElementById("bookingFlow");
  const success = document.getElementById("successState");
  const bookAnotherBtn = document.getElementById("bookAnotherBtn");
  const stepIndicators = [...document.querySelectorAll("[data-step-indicator]")];
  const panels = [...document.querySelectorAll(".panel")];
  const nextBtns = [...document.querySelectorAll("[data-next]")];
  const backBtns = [...document.querySelectorAll("[data-back]")];
  const dateList = document.getElementById("dateList");
  const timeList = document.getElementById("timeList");
  const timeIntro = document.getElementById("timeIntro");
  const selectedDatePill = document.getElementById("selectedDatePill");
  const selectedDateLabel = selectedDatePill.querySelector("span");
  const bookingSummary = document.getElementById("bookingSummary");
  const timezoneText = document.getElementById("timezoneText");
  const availabilityNote = document.getElementById("availabilityNote");
  const submitBtn = document.getElementById("submitBtn");
  const countryInput = document.getElementById("country");
  const countryList = document.getElementById("countryList");
  const cityInput = document.getElementById("city");
  const cityList = document.getElementById("cityList");
  const formToken = form.dataset.formToken || "";
  const formLoadedAt = Date.now().toString();
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const state = {
    step: 1,
    selectedDate: "",
    selectedDateISO: "",
    selectedTime: "",
    selectedTime24: "",
    selectedSlotUtc: "",
    timezone: resolvedTimeZone,
    timezoneLabel: timezoneLabel(resolvedTimeZone),
    countryCode: "",
    countryName: "",
    cityLabel: "",
    countries: [],
    busy: [],
    schedule: [],
    countriesReady: false,
  };

  timezoneText.textContent = state.timezoneLabel;
  timeList.setAttribute("role", "group");
  timeList.setAttribute("aria-label", "Demo times");

  let countryActive = -1;
  let cityActive = -1;
  let cityRequest = 0;

  function applyQuerySelection() {
    const params = new URLSearchParams(window.location.search);
    const service = params.get("service") || "";
    const intent = params.get("intent") || "";
    if (!service) return;

    const options = [...form.querySelectorAll('input[name="solutionInterest"][data-service]')];
    const match = options.find(option => {
      const serviceMatches = option.dataset.service === service;
      const intentMatches = !intent || option.dataset.intent === intent;
      return serviceMatches && intentMatches;
    });

    if (match) match.checked = true;
  }

  function formatDateLong(date) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: state.timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(date);
  }

  function formatDateShort(date) {
    return {
      labelTop: new Intl.DateTimeFormat(undefined, { timeZone: state.timezone, weekday: "short" }).format(date),
      labelBottom: new Intl.DateTimeFormat(undefined, { timeZone: state.timezone, month: "short", day: "numeric" }).format(date),
    };
  }

  function formatTimeLabel(date) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: state.timezone,
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function setStep(step) {
    state.step = step;
    panels.forEach(panel => panel.classList.toggle("active", Number(panel.dataset.step) === step));
    stepIndicators.forEach(indicator => {
      const n = Number(indicator.dataset.stepIndicator);
      indicator.classList.toggle("active", n === step);
      indicator.classList.toggle("done", n < step);
    });
    const activePanel = panels.find(panel => Number(panel.dataset.step) === step);
    if (activePanel) {
      const error = activePanel.querySelector(".error");
      error.classList.remove("show");
      error.textContent = "";
    }
    if (step === 3) refreshSchedule({ preserve: true });
  }

  function showError(step, message) {
    const panel = panels.find(item => Number(item.dataset.step) === step);
    if (!panel) return;
    const error = panel.querySelector(".error");
    error.textContent = message;
    error.classList.add("show");
  }

  function normalizeWebsite(value) {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (/\s/.test(trimmed)) return "";

    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(candidate);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      if (!url.hostname || !url.hostname.includes(".")) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function validateStep(step) {
    if (step === 1) {
      const required = [
        ["fullName", "Please enter your full name before continuing."],
        ["workEmail", "Please enter your work email before continuing."],
        ["companyName", "Please enter your company before continuing."],
      ];
      for (const [id, message] of required) {
        const field = document.getElementById(id);
        if (!field.value.trim()) {
          field.focus();
          showError(1, message);
          return false;
        }
      }
      const email = document.getElementById("workEmail");
      if (!email.checkValidity()) {
        email.focus();
        showError(1, "Please enter a valid work email address.");
        return false;
      }
      const website = document.getElementById("website");
      if (website.value.trim()) {
        const normalizedWebsite = normalizeWebsite(website.value);
        if (!normalizedWebsite) {
          website.focus();
          showError(1, "If you add a website, please enter a valid domain like google.com or www.google.com.");
          return false;
        }
        website.value = normalizedWebsite;
      }
      if (!state.countriesReady) {
        countryInput.focus();
        showError(1, "We couldn't load the country list. Please refresh the page and try again.");
        return false;
      }
      if (!state.countryCode || countryInput.value.trim() !== state.countryName) {
        countryInput.focus();
        showError(1, "Please choose your country from the list.");
        return false;
      }
      if (cityInput.disabled || !state.cityLabel || cityInput.value.trim() !== state.cityLabel) {
        if (!cityInput.disabled) cityInput.focus();
        showError(1, "Please choose your city from the list.");
        return false;
      }
      return true;
    }
    if (step === 2) {
      const chosen = form.querySelector('input[name="solutionInterest"]:checked');
      if (!chosen) {
        showError(2, "Please choose what you want help with so we can tailor the demo.");
        return false;
      }
      return true;
    }
    if (step === 3) {
      if (!state.selectedDateISO) {
        showError(3, "Please choose a date for your demo.");
        return false;
      }
      if (!state.selectedSlotUtc || !state.selectedTime) {
        showError(3, "Please choose a time slot before booking your demo.");
        return false;
      }
      const slot = currentSlot();
      if (!slot || slotIsBusy(slot, state.busy)) {
        showError(3, "That time was just booked. Please choose another slot.");
        return false;
      }
      return true;
    }
    return true;
  }

  function currentSlot() {
    return state.schedule.find(slot => slot.start.toISOString() === state.selectedSlotUtc) || null;
  }

  function closeList(list, input) {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function openList(list, input) {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function setActiveOption(list, input, index) {
    const options = [...list.querySelectorAll("[role='option']")];
    options.forEach((option, optionIndex) => {
      const active = optionIndex === index;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
      if (active) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function renderOptions(list, input, items, activeIndex, onPick, emptyLabel) {
    list.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "combo-empty";
      empty.textContent = emptyLabel;
      list.appendChild(empty);
      openList(list, input);
      return;
    }

    items.forEach((item, index) => {
      const option = document.createElement("li");
      option.id = `${list.id}-opt-${index}`;
      option.setAttribute("role", "option");
      option.className = "combo-option";
      option.textContent = item.label;
      option.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      if (index === activeIndex) option.classList.add("is-active");
      option.addEventListener("mousedown", event => event.preventDefault());
      option.addEventListener("click", () => onPick(item));
      list.appendChild(option);
    });
    openList(list, input);
    if (activeIndex >= 0) input.setAttribute("aria-activedescendant", `${list.id}-opt-${activeIndex}`);
  }

  function filteredCountries() {
    const query = countryInput.value.trim().toLowerCase();
    const folded = query.normalize("NFD").replace(/\p{M}/gu, "");
    return state.countries.filter(country => {
      const name = country.name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      return !folded || name.includes(folded) || country.code.toLowerCase().includes(folded);
    }).slice(0, folded ? 80 : state.countries.length);
  }

  function renderCountries() {
    const items = filteredCountries().map(country => ({ ...country, label: country.name }));
    countryActive = items.length ? Math.min(Math.max(countryActive, 0), items.length - 1) : -1;
    renderOptions(countryList, countryInput, items, countryActive, selectCountry, "No matching countries");
  }

  function selectCountry(country) {
    state.countryCode = country.code;
    state.countryName = country.name;
    countryInput.value = country.name;
    countryInput.setAttribute("aria-invalid", "false");
    closeList(countryList, countryInput);
    clearCity();
    cityInput.disabled = false;
    cityInput.setAttribute("aria-disabled", "false");
    cityInput.placeholder = "Type to search cities";
    primeCityPlaceholder();
  }

  function clearCity() {
    state.cityLabel = "";
    cityInput.value = "";
    cityActive = -1;
    closeList(cityList, cityInput);
  }

  async function primeCityPlaceholder() {
    const result = await fetchCities("");
    if (!result) return;
    cityInput.placeholder = result.truncated
      ? `Type to search ${result.total.toLocaleString()} cities`
      : "Select your city";
  }

  async function fetchCities(query) {
    const requestId = ++cityRequest;
    const params = new URLSearchParams({ country: state.countryCode, q: query });
    try {
      const response = await fetch(`/api/locations/cities?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (requestId !== cityRequest) return null;
      if (!response.ok || !result.ok) throw new Error(result.message || "Could not load cities.");
      return result;
    } catch (error) {
      if (requestId !== cityRequest) return null;
      showError(1, error.message || "We couldn't load cities for that country. Please try again.");
      return null;
    }
  }

  async function renderCities() {
    if (!state.countryCode || cityInput.disabled) return;
    const result = await fetchCities(cityInput.value.trim());
    if (!result) return;
    cityInput.placeholder = result.truncated && !cityInput.value.trim()
      ? `Type to search ${result.total.toLocaleString()} cities`
      : cityInput.placeholder;
    const items = result.cities.map(city => ({ label: city.label }));
    const emptyLabel = result.truncated && !cityInput.value.trim()
      ? "Type to search cities"
      : "No matching cities";
    cityActive = items.length ? Math.min(Math.max(cityActive, 0), items.length - 1) : -1;
    renderOptions(cityList, cityInput, items, cityActive, selectCity, emptyLabel);
  }

  function selectCity(city) {
    state.cityLabel = city.label;
    cityInput.value = city.label;
    cityInput.setAttribute("aria-invalid", "false");
    closeList(cityList, cityInput);
  }

  function moveActive(kind, delta) {
    if (kind === "country") {
      const count = countryList.querySelectorAll("[role='option']").length;
      if (!count) return;
      countryActive = (countryActive + delta + count) % count;
      setActiveOption(countryList, countryInput, countryActive);
      return;
    }
    const count = cityList.querySelectorAll("[role='option']").length;
    if (!count) return;
    cityActive = (cityActive + delta + count) % count;
    setActiveOption(cityList, cityInput, cityActive);
  }

  function chooseActive(kind) {
    const list = kind === "country" ? countryList : cityList;
    const active = list.querySelector(".combo-option.is-active");
    if (active) active.click();
  }

  countryInput.addEventListener("focus", () => {
    if (!state.countriesReady) return;
    countryActive = 0;
    renderCountries();
  });
  countryInput.addEventListener("input", () => {
    if (countryInput.value.trim() !== state.countryName) {
      state.countryCode = "";
      state.countryName = "";
      clearCity();
      cityInput.disabled = true;
      cityInput.setAttribute("aria-disabled", "true");
      cityInput.placeholder = "Choose a country first";
    }
    countryActive = 0;
    renderCountries();
  });
  countryInput.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (countryList.hidden) renderCountries();
      moveActive("country", 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive("country", -1);
    } else if (event.key === "Enter" && !countryList.hidden) {
      event.preventDefault();
      chooseActive("country");
    } else if (event.key === "Escape") {
      closeList(countryList, countryInput);
    }
  });
  countryInput.addEventListener("blur", () => {
    window.setTimeout(() => closeList(countryList, countryInput), 120);
  });

  cityInput.addEventListener("focus", () => {
    if (cityInput.disabled) return;
    cityActive = 0;
    renderCities();
  });
  let cityTimer = 0;
  cityInput.addEventListener("input", () => {
    if (cityInput.value.trim() !== state.cityLabel) state.cityLabel = "";
    cityActive = 0;
    window.clearTimeout(cityTimer);
    cityTimer = window.setTimeout(() => {
      renderCities();
    }, 150);
  });
  cityInput.addEventListener("keydown", event => {
    if (cityInput.disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (cityList.hidden) renderCities();
      moveActive("city", 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive("city", -1);
    } else if (event.key === "Enter" && !cityList.hidden) {
      event.preventDefault();
      chooseActive("city");
    } else if (event.key === "Escape") {
      closeList(cityList, cityInput);
    }
  });
  cityInput.addEventListener("blur", () => {
    window.setTimeout(() => closeList(cityList, cityInput), 120);
  });

  document.addEventListener("click", event => {
    if (!event.target.closest(".combo")) {
      closeList(countryList, countryInput);
      closeList(cityList, cityInput);
    }
  });

  async function refreshBusy() {
    try {
      const response = await fetch("/api/book-demo/availability", {
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.busy)) {
        throw new Error(result.message || "Could not load booked times.");
      }
      state.busy = result.busy;
      availabilityNote.hidden = true;
      availabilityNote.textContent = "";
    } catch {
      availabilityNote.hidden = false;
      availabilityNote.textContent = "We couldn't check which times are already booked. You can still choose a time, and we'll confirm it's open when you book.";
    }
  }

  function renderDates({ preferredDate = "", preferredSlot = "" } = {}) {
    const groups = groupSlotsByDate(state.schedule);
    dateList.innerHTML = "";
    if (!groups.length) {
      timeList.innerHTML = "";
      timeIntro.textContent = "No demo times are available in your timezone right now.";
      return;
    }

    let preferredButton = null;
    let firstButton = null;
    groups.forEach(group => {
      const parts = formatDateShort(group.start);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "date-btn";
      button.innerHTML = `<small>${escapeHtml(parts.labelTop)}</small><strong>${escapeHtml(parts.labelBottom)}</strong>`;
      button.addEventListener("click", () => selectDate(group, button));
      dateList.appendChild(button);
      if (!firstButton) firstButton = { group, button };
      if (group.dateISO === preferredDate) preferredButton = { group, button };
    });

    const chosen = preferredButton || firstButton;
    selectDate(chosen.group, chosen.button, { preferredSlot });
  }

  function selectDate(group, button, { preferredSlot = "" } = {}) {
    state.selectedDate = formatDateLong(group.start);
    state.selectedDateISO = group.dateISO;
    [...dateList.children].forEach(item => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    selectedDatePill.hidden = false;
    selectedDateLabel.textContent = state.selectedDate;
    timeIntro.textContent = `Available slots for ${state.selectedDate}`;
    renderTimes(group, preferredSlot);
  }

  function renderTimes(group, preferredSlot = "") {
    timeList.innerHTML = "";
    state.selectedTime = "";
    state.selectedTime24 = "";
    state.selectedSlotUtc = "";
    let restored = false;

    group.slots.forEach(slot => {
      const label = formatTimeLabel(slot.start);
      const booked = slotIsBusy(slot, state.busy);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `time-btn${booked ? " is-booked" : ""}`;
      button.innerHTML = booked
        ? `${escapeHtml(label)}<span class="booked-label">Booked</span>`
        : escapeHtml(label);
      if (booked) {
        button.setAttribute("aria-disabled", "true");
        button.tabIndex = -1;
        button.title = "Booked";
        button.dataset.booked = "true";
        button.setAttribute("aria-label", `${label}, Booked`);
      } else {
        button.setAttribute("aria-disabled", "false");
        button.setAttribute("aria-pressed", "false");
        button.title = `${label}, 15-minute demo`;
        button.setAttribute("aria-label", `${label}, 15-minute demo`);
      }
      button.addEventListener("click", () => {
        if (button.dataset.booked === "true") return;
        selectTime(slot, label, button);
      });
      button.addEventListener("keydown", event => {
        if (button.dataset.booked === "true" && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
        }
      });
      timeList.appendChild(button);
      if (!booked && preferredSlot && slot.start.toISOString() === preferredSlot) {
        selectTime(slot, label, button);
        restored = true;
      }
    });

    if (!restored) updateSummary();
  }

  function selectTime(slot, label, button) {
    [...timeList.children].forEach(item => {
      const active = item === button;
      item.classList.toggle("active", active);
      if (item.dataset.booked !== "true") item.setAttribute("aria-pressed", active ? "true" : "false");
    });
    state.selectedTime = label;
    state.selectedTime24 = slot.time24;
    state.selectedSlotUtc = slot.start.toISOString();
    state.selectedDate = formatDateLong(slot.start);
    state.selectedDateISO = slot.dateISO;
    updateSummary();
  }

  function updateSummary() {
    if (state.selectedDate && state.selectedTime) {
      bookingSummary.classList.add("show");
      bookingSummary.innerHTML = `<strong>Your selected slot</strong>${escapeHtml(state.selectedDate)} at ${escapeHtml(state.selectedTime)} &middot; 15 minutes &middot; ${escapeHtml(state.timezoneLabel)}`;
    } else if (state.selectedDate) {
      bookingSummary.classList.add("show");
      bookingSummary.innerHTML = `<strong>Date selected</strong>${escapeHtml(state.selectedDate)}. Choose a time slot to finish booking.`;
    } else {
      bookingSummary.classList.remove("show");
      bookingSummary.innerHTML = "";
    }
  }

  async function refreshSchedule({ preserve = true } = {}) {
    const previousDate = preserve ? state.selectedDateISO : "";
    const previousSlot = preserve ? state.selectedSlotUtc : "";
    state.schedule = buildOfferedSlots(state.timezone);
    await refreshBusy();
    renderDates({ preferredDate: previousDate, preferredSlot: previousSlot });
  }

  nextBtns.forEach(button => button.addEventListener("click", () => {
    if (!validateStep(state.step)) return;
    setStep(Math.min(3, state.step + 1));
  }));

  backBtns.forEach(button => button.addEventListener("click", () => {
    setStep(Math.max(1, state.step - 1));
  }));

  function setSubmitting(isSubmitting) {
    submitBtn.disabled = isSubmitting;
    submitBtn.innerHTML = isSubmitting ? "Sending..." : "Book my demo <b>&#8599;</b>";
  }

  async function postForm(payload) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (formToken) headers["X-Astro-Form-Token"] = formToken;

    const response = await fetch(form.action, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const responseText = await response.text().catch(() => "");
      console.error("[Swishtag form] Non-JSON response from form service", {
        status: response.status,
        statusText: response.statusText,
        contentType,
        endpoint: form.action,
        responsePreview: responseText.slice(0, 500),
      });
      throw new Error("The form service returned an unexpected response. Please try again or email hello@swishtag.com directly.");
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      console.error("[Swishtag form] JSON error response from form service", {
        status: response.status,
        endpoint: form.action,
        result,
      });
      const error = new Error(result.message || "Something went wrong while sending your request.");
      error.code = result.code || "";
      throw error;
    }
    return result;
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (document.getElementById("nickname").value.trim()) return;
    await refreshSchedule({ preserve: true });
    if (!validateStep(3)) return;

    const email = document.getElementById("workEmail").value.trim();
    const company = document.getElementById("companyName").value.trim();
    const selectedInterest = form.querySelector('input[name="solutionInterest"]:checked');
    const focus = selectedInterest.value;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.form_source = "book-demo";
    payload.country = state.countryName;
    payload.countryCode = state.countryCode;
    payload.city = state.cityLabel;
    payload.service = selectedInterest.dataset.service || "";
    payload.intent = selectedInterest.dataset.intent || "";
    payload.selectedDate = state.selectedDate;
    payload.selectedDateISO = state.selectedDateISO;
    payload.selectedTime = state.selectedTime;
    payload.selectedTime24 = state.selectedTime24;
    payload.selectedSlotUtc = state.selectedSlotUtc;
    payload.timezone = state.timezone;
    payload.page = window.location.href;
    payload.form_loaded_at = formLoadedAt;

    try {
      setSubmitting(true);
      await postForm(payload);
      document.getElementById("successEmail").textContent = email;
      document.getElementById("successDate").textContent = state.selectedDate;
      document.getElementById("successTime").textContent = `${state.selectedTime} - ${state.timezoneLabel}`;
      document.getElementById("successCompany").textContent = company;
      document.getElementById("successFocus").textContent = focus;
      flow.style.display = "none";
      success.classList.add("show");
      success.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      if (error.code === "slot_taken") {
        state.selectedTime = "";
        state.selectedTime24 = "";
        state.selectedSlotUtc = "";
        await refreshSchedule({ preserve: true });
      }
      showError(3, error.message || "We could not send your request right now. Please try again.");
    } finally {
      setSubmitting(false);
    }
  });

  bookAnotherBtn.addEventListener("click", () => {
    form.reset();
    state.countryCode = "";
    state.countryName = "";
    state.cityLabel = "";
    state.selectedTime = "";
    state.selectedTime24 = "";
    state.selectedSlotUtc = "";
    cityInput.disabled = true;
    cityInput.setAttribute("aria-disabled", "true");
    cityInput.placeholder = "Choose a country first";
    countryInput.disabled = !state.countriesReady;
    countryInput.placeholder = state.countriesReady ? "Search for a country" : "Countries unavailable";
    flow.style.display = "";
    success.classList.remove("show");
    setStep(1);
    refreshSchedule({ preserve: false });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  async function loadCountries() {
    try {
      const response = await fetch("/api/locations/countries", {
        headers: { Accept: "application/json" },
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.countries)) {
        throw new Error(result.message || "Could not load countries.");
      }
      state.countries = result.countries;
      state.countriesReady = true;
      countryInput.disabled = false;
      countryInput.placeholder = "Search for a country";
    } catch {
      state.countriesReady = false;
      countryInput.disabled = true;
      countryInput.placeholder = "Countries unavailable";
      showError(1, "We couldn't load the country list. Please refresh the page and try again.");
    }
  }

  applyQuerySelection();
  loadCountries();
  refreshSchedule({ preserve: false });
}
