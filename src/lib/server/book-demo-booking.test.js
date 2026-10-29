import assert from "node:assert/strict";
import test from "node:test";
import { buildOfferedSlots, describeSlot } from "../meeting-slots.js";
import { createSubmissionDocument } from "./form-submissions.js";
import { listCountries, resolveLocation, searchCities, citiesForCountry } from "./locations.js";
import { busyRangesFromSubmissions, reserveBookDemoSubmission } from "./meeting-availability.js";

function request() {
  return new Request("https://swishtag.com/book-demo/", {
    headers: {
      "user-agent": "node-test",
      referer: "https://swishtag.com/book-demo/",
    },
  });
}

function memoryCollection(initial = []) {
  const rows = [...initial];
  let seq = rows.length;

  return {
    rows,
    async insertOne(document) {
      await Promise.resolve();
      seq += 1;
      document._id = String(seq);
      rows.push(document);
      return { insertedId: document._id };
    },
    async deleteOne(filter) {
      const id = String(filter._id);
      const index = rows.findIndex(row => String(row._id) === id);
      if (index < 0) return { deletedCount: 0 };
      rows.splice(index, 1);
      return { deletedCount: 1 };
    },
    find() {
      const cursor = {
        limit() {
          return cursor;
        },
        async toArray() {
          await Promise.resolve();
          return rows.slice();
        },
      };
      return cursor;
    },
  };
}

function booking(start, createdAt = new Date("2026-11-01T00:00:00.000Z")) {
  return {
    formType: "book-demo",
    source: "book-demo",
    createdAt,
    meetingAt: new Date(start),
    meetingAtISO: start.toISOString(),
    fields: {
      selectedSlotUtc: start.toISOString(),
    },
  };
}

test("country and city lists are bundled and searchable", () => {
  const countries = listCountries();
  assert.ok(countries.length >= 200);
  for (const country of countries) {
    assert.ok(citiesForCountry(country.code).length > 0, country.name);
  }

  const austin = searchCities({ country: "US", query: "Austin, Texas" });
  assert.equal(austin.ok, true);
  assert.ok(austin.cities.some(city => city.label === "Austin, Texas"));

  const browse = searchCities({ country: "US", query: "" });
  assert.equal(browse.truncated, true);
  assert.equal(browse.cities.length, 0);
  assert.ok(browse.total > 80);

  const resolved = resolveLocation({
    country: "United States",
    countryCode: "US",
    city: "Austin, Texas",
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.city, "Austin, Texas");
  assert.equal(resolveLocation({
    country: "United States",
    countryCode: "US",
    city: "Not a real city",
  }).ok, false);
  assert.equal(resolveLocation({
    country: "Canada",
    countryCode: "US",
    city: "Austin, Texas",
  }).ok, false);
});

test("book-demo submission stores country, city, and the UTC instant", () => {
  const slot = buildOfferedSlots("America/New_York")[0];
  const described = describeSlot(slot, "America/New_York");
  const result = createSubmissionDocument({
    form_source: "book-demo",
    fullName: "Ada Lovelace",
    workEmail: "ada@example.com",
    companyName: "Analytical Engines",
    country: "United States",
    countryCode: "US",
    city: "Austin, Texas",
    solutionInterest: "Company Store",
    ...described,
  }, request());

  assert.equal(result.error, undefined);
  assert.equal(result.document.fields.country, "United States");
  assert.equal(result.document.fields.countryCode, "US");
  assert.equal(result.document.fields.city, "Austin, Texas");
  assert.equal(result.document.fields.selectedSlotUtc, slot.start.toISOString());
  assert.equal(result.document.meetingAt.toISOString(), slot.start.toISOString());
  assert.equal(result.document.fields.timezone, "America/New_York");
});

test("book-demo submission rejects a city outside the country", () => {
  const slot = buildOfferedSlots("America/New_York")[0];
  const result = createSubmissionDocument({
    form_source: "book-demo",
    fullName: "Ada Lovelace",
    workEmail: "ada@example.com",
    companyName: "Analytical Engines",
    country: "United States",
    countryCode: "US",
    city: "Paris",
    solutionInterest: "Company Store",
    selectedDate: "Friday",
    selectedTime: "9:00 AM",
    timezone: "America/New_York",
    selectedSlotUtc: slot.start.toISOString(),
  }, request());

  assert.equal(result.error.status, 422);
  assert.match(result.error.message, /city/i);
});

test("busy ranges contain only UTC start and end", () => {
  const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  start.setUTCMinutes(0, 0, 0);
  const ranges = busyRangesFromSubmissions([{
    formType: "book-demo",
    email: "secret@example.com",
    displayName: "Secret Person",
    fields: {
      selectedSlotUtc: start.toISOString(),
      fullName: "Secret Person",
    },
  }]);

  assert.equal(ranges.length, 1);
  assert.deepEqual(Object.keys(ranges[0]).sort(), ["end", "start"]);
  assert.equal(ranges[0].start, start.toISOString());
  assert.equal(ranges[0].end, new Date(start.getTime() + 15 * 60 * 1000).toISOString());
  assert.equal(JSON.stringify(ranges).includes("secret@example.com"), false);
});

test("the same UTC slot cannot be reserved twice, including a race", async () => {
  const start = new Date("2026-11-03T15:00:00.000Z");
  const collection = memoryCollection();
  const [first, second] = await Promise.all([
    reserveBookDemoSubmission(collection, booking(start)),
    reserveBookDemoSubmission(collection, booking(start)),
  ]);

  const conflicts = [first, second].filter(result => result.conflict);
  assert.equal(conflicts.length, 1);
  assert.equal(collection.rows.length, 1);
  assert.equal(collection.rows[0].fields.selectedSlotUtc, start.toISOString());
});

test("a partial overlap is rejected and an adjacent slot is allowed", async () => {
  const start = new Date("2026-11-04T15:00:00.000Z");
  const collection = memoryCollection();
  const first = await reserveBookDemoSubmission(collection, booking(start));
  const overlap = await reserveBookDemoSubmission(collection, booking(new Date(start.getTime() + 10 * 60 * 1000)));
  const adjacent = await reserveBookDemoSubmission(collection, booking(new Date(start.getTime() + 15 * 60 * 1000)));

  assert.equal(first.conflict, false);
  assert.equal(overlap.conflict, true);
  assert.equal(adjacent.conflict, false);
  assert.equal(collection.rows.length, 2);
});
