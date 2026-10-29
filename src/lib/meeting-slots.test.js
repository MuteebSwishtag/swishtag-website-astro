import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOfferedSlots,
  rangesOverlap,
  resolveBookDemoSlot,
  slotIsBusy,
  timezoneLabel,
  wallClockFromUtc,
  zonedDateTimeToUtc,
} from "./meeting-slots.js";
import { getBookDemoMeetingAt } from "./server/meeting-time.js";

const now = new Date("2026-10-29T15:00:00.000Z");

test("offers weekday slots in the visitor timezone and converts them to UTC", () => {
  const slots = buildOfferedSlots("America/New_York", now);
  const dates = [...new Set(slots.map(slot => slot.dateISO))];

  assert.equal(dates.length, 10);
  assert.equal(slots[0].dateISO, "2026-10-30");
  assert.equal(slots[0].time24, "09:00");
  assert.equal(slots[0].start.toISOString(), "2026-10-30T13:00:00.000Z");
  assert.equal(slots[0].end.toISOString(), "2026-10-30T13:15:00.000Z");

  const monday = slots.find(slot => slot.dateISO === "2026-11-02" && slot.time24 === "09:00");
  assert.equal(monday.start.toISOString(), "2026-11-02T14:00:00.000Z");

  for (const slot of slots) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(slot.start);
    assert.notEqual(weekday, "Sat");
    assert.notEqual(weekday, "Sun");
    assert.equal(slot.end.getTime() - slot.start.getTime(), 15 * 60 * 1000);
  }
});

test("converts fixed-offset zones without shifting the instant", () => {
  const india = buildOfferedSlots("Asia/Kolkata", now).find(slot => slot.time24 === "09:00");
  assert.equal(india.start.toISOString().slice(11, 19), "03:30:00");

  const nepal = zonedDateTimeToUtc({
    year: 2026,
    month: 10,
    day: 30,
    hour: 9,
    minute: 0,
    timeZone: "Asia/Kathmandu",
  });
  assert.equal(nepal.toISOString(), "2026-10-30T03:15:00.000Z");
});

test("does not treat a daylight-saving gap as the requested wall time", () => {
  const sprung = zonedDateTimeToUtc({
    year: 2026,
    month: 3,
    day: 8,
    hour: 2,
    minute: 30,
    timeZone: "America/New_York",
  });
  const wall = wallClockFromUtc(sprung, "America/New_York");
  assert.notEqual(`${wall.hour}:${wall.minute}`, "2:30");
});

test("adjacent slots do not overlap and a partial overlap does", () => {
  const start = new Date("2026-11-02T14:00:00.000Z");
  const end = new Date("2026-11-02T14:15:00.000Z");
  const nextEnd = new Date("2026-11-02T14:30:00.000Z");

  assert.equal(rangesOverlap(start, end, start, end), true);
  assert.equal(rangesOverlap(start, end, end, nextEnd), false);
  assert.equal(rangesOverlap(start, end, new Date("2026-11-02T14:10:00.000Z"), new Date("2026-11-02T14:25:00.000Z")), true);
  assert.equal(slotIsBusy({ start, end }, [{ start: end.toISOString(), end: nextEnd.toISOString() }]), false);
  assert.equal(slotIsBusy({ start, end }, [{ start: start.toISOString(), end: end.toISOString() }]), true);
});

test("rejects a slot that is not on the visitor's grid", () => {
  const slots = buildOfferedSlots("America/New_York", now);
  const accepted = resolveBookDemoSlot({
    timeZone: "America/New_York",
    selectedSlotUtc: slots[0].start.toISOString(),
    now,
  });
  assert.equal(accepted.slot.start.toISOString(), slots[0].start.toISOString());

  const rejected = resolveBookDemoSlot({
    timeZone: "Asia/Tokyo",
    selectedSlotUtc: slots[0].start.toISOString(),
    now,
  });
  assert.equal(rejected.error.status, 422);
});

test("timezone label includes the IANA id", () => {
  assert.match(timezoneLabel("America/New_York", "en-US"), /America\/New_York/);
});

test("selectedSlotUtc is the meeting instant even when the wall clock disagrees", () => {
  const parsed = getBookDemoMeetingAt({
    fields: {
      selectedDateISO: "2026-11-02",
      selectedTime: "9:00 AM",
      timezone: "America/New_York",
    },
  });
  assert.equal(parsed.toISOString(), "2026-11-02T14:00:00.000Z");

  const preferred = getBookDemoMeetingAt({
    meetingAt: new Date("2026-11-02T14:00:00.000Z"),
    fields: {
      selectedSlotUtc: "2026-11-02T18:00:00.000Z",
      selectedDateISO: "2026-11-02",
      selectedTime: "9:00 AM",
      timezone: "America/New_York",
    },
  });
  assert.equal(preferred.toISOString(), "2026-11-02T18:00:00.000Z");
});
