import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GEONAMES = "https://download.geonames.org/export/dump";
const POPULATION_FLOOR = 5000;
const OUTPUT = path.resolve("src/data/locations.json");

const SOURCE = "GeoNames geographical database (https://www.geonames.org/), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Filtered to populated places with a population of at least 5000. A country capital below that threshold is still included so every country has a city. Labels combine the place name with its first-level administrative region. Each city includes its GeoNames IANA timezone.";

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes);
  return bytes;
}

function readZipText(zipPath) {
  return execFileSync("unzip", ["-p", zipPath], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function countryRows(text) {
  const countries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const columns = line.split("\t");
    const code = columns[0]?.trim();
    const name = columns[4]?.trim();
    const capital = columns[5]?.trim() || "";
    if (!code || !name) continue;
    countries.push({ code, name, capital });
  }
  return countries;
}

function adminNames(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const columns = line.split("\t");
    const code = columns[0]?.trim();
    const name = columns[1]?.trim();
    if (code && name) names.set(code, name);
  }
  return names;
}

function validTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function countryTimeZones(text) {
  const zones = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("CountryCode")) continue;
    const [code, timeZone] = line.split("\t");
    const countryCode = code?.trim();
    const zone = timeZone?.trim();
    if (!countryCode || !zone || !validTimeZone(zone)) continue;
    if (!zones.has(countryCode)) zones.set(countryCode, []);
    zones.get(countryCode).push(zone);
  }
  return zones;
}

function cityRows(text, regions) {
  const best = new Map();

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const columns = line.split("\t");
    const name = columns[1]?.trim();
    const countryCode = columns[8]?.trim();
    const adminCode = columns[10]?.trim() || "";
    const population = Number(columns[14] || 0);
    if (!name || !countryCode) continue;

    const region = regions.get(`${countryCode}.${adminCode}`) || "";
    const timezone = columns[17]?.trim() || "";
    const key = `${countryCode}|${fold(name)}|${fold(region)}`;
    const current = best.get(key);
    if (!current || population > current.population) {
      best.set(key, { countryCode, name, region, population, timezone });
    }
  }

  return best;
}

const workdir = path.join(tmpdir(), "swishtag-geonames");
mkdirSync(workdir, { recursive: true });

const citiesZip = path.join(workdir, "cities5000.zip");
const countryPath = path.join(workdir, "countryInfo.txt");
const adminPath = path.join(workdir, "admin1Codes.txt");
const timeZonePath = path.join(workdir, "timeZones.txt");

await Promise.all([
  download(`${GEONAMES}/cities5000.zip`, citiesZip),
  download(`${GEONAMES}/countryInfo.txt`, countryPath),
  download(`${GEONAMES}/admin1CodesASCII.txt`, adminPath),
  download(`${GEONAMES}/timeZones.txt`, timeZonePath),
]);

const { readFileSync } = await import("node:fs");
const countries = countryRows(readFileSync(countryPath, "utf8"));
const regions = adminNames(readFileSync(adminPath, "utf8"));
const zonesByCountry = countryTimeZones(readFileSync(timeZonePath, "utf8"));
const cities = cityRows(readZipText(citiesZip), regions);

const byCountry = new Map(countries.map(country => [country.code, []]));
let skipped = 0;

for (const city of cities.values()) {
  if (city.population < POPULATION_FLOOR) continue;
  const bucket = byCountry.get(city.countryCode);
  if (!bucket) {
    skipped += 1;
    continue;
  }
  bucket.push(city);
}

let capitalsAdded = 0;
let timezonesFilled = 0;
for (const country of countries) {
  const bucket = byCountry.get(country.code);
  const capital = country.capital.trim();
  if (capital && !bucket.some(city => fold(city.name) === fold(capital))) {
    bucket.push({ name: capital, region: "", population: 0, timezone: "" });
    capitalsAdded += 1;
  }

  const largest = bucket.reduce((best, city) => {
    if (!validTimeZone(city.timezone)) return best;
    if (!best || city.population > best.population) return city;
    return best;
  }, null);
  const listed = zonesByCountry.get(country.code) || [];
  const fallback = largest?.timezone || listed[0] || "UTC";

  for (const city of bucket) {
    if (validTimeZone(city.timezone)) continue;
    city.timezone = fallback;
    timezonesFilled += 1;
  }
}

const payload = {
  source: SOURCE,
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  populationFloor: POPULATION_FLOOR,
  countries: countries
    .map(country => {
      const seen = new Set();
      const cityList = byCountry.get(country.code)
        .filter(city => {
          const key = `${fold(city.name)}|${fold(city.region)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .sort((left, right) => {
          const leftLabel = left.region ? `${left.name}, ${left.region}` : left.name;
          const rightLabel = right.region ? `${right.name}, ${right.region}` : right.name;
          return leftLabel.localeCompare(rightLabel, "en");
        })
        .map(city => [city.name, city.region || "", city.timezone]);

      return {
        code: country.code,
        name: country.name,
        cities: cityList,
      };
    })
    .filter(country => country.cities.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name, "en")),
};

writeFileSync(OUTPUT, JSON.stringify(payload));

const cityCount = payload.countries.reduce((total, country) => total + country.cities.length, 0);
console.log(JSON.stringify({
  countries: payload.countries.length,
  cities: cityCount,
  capitalsAdded,
  timezonesFilled,
  skippedUnknownCountry: skipped,
  bytes: Buffer.byteLength(JSON.stringify(payload)),
  sample: payload.countries.find(country => country.code === "US")?.cities.find(city => city[0] === "Austin" && city[1] === "Texas"),
}, null, 2));
