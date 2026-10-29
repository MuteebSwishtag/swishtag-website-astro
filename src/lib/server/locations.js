import locationsData from "../../data/locations.json" with { type: "json" };

const BROWSE_ALL_MAX = 80;
const cityCache = new Map();

export const locationSource = locationsData.source || "";

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function cityLabel(name, region) {
  return region ? `${name}, ${region}` : name;
}

function prepareCities(entries) {
  const counts = new Map();
  const cities = (entries || []).map(entry => {
    const name = String(entry?.[0] || "").trim();
    const region = String(entry?.[1] || "").trim();
    const timezone = String(entry?.[2] || "").trim();
    const label = cityLabel(name, region);
    counts.set(label, (counts.get(label) || 0) + 1);
    return { name, region, label, timezone };
  }).filter(city => city.name);

  if ([...counts.values()].every(count => count === 1)) return cities;

  const seen = new Map();
  return cities.map(city => {
    if ((counts.get(city.label) || 0) < 2) return city;
    const next = (seen.get(city.label) || 0) + 1;
    seen.set(city.label, next);
    return next === 1 ? city : { ...city, label: `${city.label} (${next})` };
  });
}

export function listCountries() {
  return locationsData.countries.map(country => ({
    code: country.code,
    name: country.name,
  }));
}

function countryRecord(code) {
  return locationsData.countries.find(country => country.code === code) || null;
}

export function citiesForCountry(code) {
  if (cityCache.has(code)) return cityCache.get(code);
  const record = countryRecord(code);
  const cities = prepareCities(record?.cities || []);
  cityCache.set(code, cities);
  return cities;
}

export function findCountry({ country = "", countryCode = "" } = {}) {
  const countries = listCountries();
  const code = String(countryCode || "").trim().toUpperCase();
  const text = String(country || "").trim();

  if (code) {
    const byCode = countries.find(item => item.code === code) || null;
    if (!byCode) return null;
    if (text && fold(text) !== fold(byCode.name) && text.toUpperCase() !== byCode.code) return null;
    return byCode;
  }

  if (/^[A-Za-z]{2}$/.test(text)) {
    const byCode = countries.find(item => item.code === text.toUpperCase());
    if (byCode) return byCode;
  }

  const byName = countries.filter(item => fold(item.name) === fold(text));
  return byName.length === 1 ? byName[0] : null;
}

function rankCity(city, query) {
  const name = fold(city.name);
  const label = fold(city.label);
  const region = fold(city.region);
  if (!query) return 0;
  if (name.startsWith(query) || label.startsWith(query)) return 0;
  if (name.includes(query) || label.includes(query) || region.includes(query)) return 1;
  return -1;
}

export function searchCities({ country = "", countryCode = "", query = "", limit = 40 } = {}) {
  const match = findCountry({ country, countryCode });
  if (!match) {
    return {
      ok: false,
      message: "Please choose a country from the list.",
    };
  }

  const cities = citiesForCountry(match.code);
  const q = fold(query);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 40));
  const countryPayload = { code: match.code, name: match.name };

  if (!q && cities.length > BROWSE_ALL_MAX) {
    return {
      ok: true,
      country: countryPayload,
      total: cities.length,
      matchCount: 0,
      truncated: true,
      cities: [],
    };
  }

  const matched = q
    ? cities
      .map(city => ({ city, rank: rankCity(city, q) }))
      .filter(item => item.rank >= 0)
      .sort((left, right) => left.rank - right.rank || left.city.label.localeCompare(right.city.label, "en"))
      .map(item => item.city)
    : cities;
  const visible = q ? matched.slice(0, safeLimit) : matched;

  return {
    ok: true,
    country: countryPayload,
    total: cities.length,
    matchCount: matched.length,
    truncated: visible.length < matched.length,
    cities: visible.map(city => ({
      name: city.name,
      region: city.region,
      label: city.label,
      timezone: city.timezone,
    })),
  };
}

export function resolveLocation({ country = "", city = "", countryCode = "", timeZone = "" } = {}) {
  const match = findCountry({ country, countryCode });
  if (!match || (country && fold(country) !== fold(match.name))) {
    return {
      ok: false,
      message: "Please choose a country from the list.",
    };
  }

  const requested = fold(city);
  if (!requested) {
    return {
      ok: false,
      message: "Please choose a city in the selected country.",
    };
  }

  const cityMatch = citiesForCountry(match.code).find(item => fold(item.label) === requested);
  if (!cityMatch) {
    return {
      ok: false,
      message: "Please choose a city in the selected country.",
    };
  }

  const requestedTimeZone = String(timeZone || "").trim();
  if (requestedTimeZone && requestedTimeZone !== cityMatch.timezone) {
    return {
      ok: false,
      message: "Please choose a demo time in the selected city's timezone.",
    };
  }

  return {
    ok: true,
    country: match.name,
    countryCode: match.code,
    city: cityMatch.label,
    region: cityMatch.region,
    timezone: cityMatch.timezone,
  };
}
