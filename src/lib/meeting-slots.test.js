import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOK_DEMO_SLOT_TIME_ZONE,
  buildOfferedSlots,
  describeSlot,
  rangesOverlap,
  resolveBookDemoSlot,
  slotIsBusy,
  timezoneLabel,
  wallClockFromUtc,
  zonedDateTimeToUtc,
} from "./meeting-slots.js";
import { formatPakistanTime } from "./pakistan-time.js";
import { getBookDemoMeetingAt } from "./server/meeting-time.js";

const now = new Date("2026-10-29T15:00:00.000Z");

function slotOnNewYorkDay(slots, dateISO, time24) {
  return slots.find(slot => {
    const wall = wallClockFromUtc(slot.start, BOOK_DEMO_SLOT_TIME_ZONE);
    const iso = `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
    const clock = `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
    return iso === dateISO && clock === time24;
  });
}

test("offers New York business hours and labels them in the selected timezone", () => {
  const slots = buildOfferedSlots("America/New_York", now);
  const dates = [...new Set(slots.map(slot => slot.dateISO))];
  const opening = slotOnNewYorkDay(slots, "2026-10-30", "10:00");
  const closing = slotOnNewYorkDay(slots, "2026-10-30", "17:45");
  const monday = slotOnNewYorkDay(slots, "2026-11-02", "10:00");

  assert.equal(dates.length, 10);
  assert.equal(opening.start.toISOString(), "2026-10-30T14:00:00.000Z");
  assert.equal(opening.end.toISOString(), "2026-10-30T14:15:00.000Z");
  assert.equal(opening.time24, "10:00");
  assert.equal(closing.start.toISOString(), "2026-10-30T21:45:00.000Z");
  assert.equal(closing.end.toISOString(), "2026-10-30T22:00:00.000Z");
  assert.equal(slotOnNewYorkDay(slots, "2026-10-30", "09:00"), undefined);
  assert.equal(slotOnNewYorkDay(slots, "2026-10-30", "18:00"), undefined);
  assert.equal(monday.start.toISOString(), "2026-11-02T15:00:00.000Z");
  assert.equal(slots.filter(slot => slot.dateISO === "2026-10-30").length, 32);

  for (const slot of slots) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: BOOK_DEMO_SLOT_TIME_ZONE,
      weekday: "short",
    }).format(slot.start);
    assert.notEqual(weekday, "Sat");
    assert.notEqual(weekday, "Sun");
    assert.equal(slot.end.getTime() - slot.start.getTime(), 15 * 60 * 1000);
  }
});

test("shows the same New York instants in Karachi, Phoenix, and Sydney", () => {
  const newYork = buildOfferedSlots("America/New_York", now);
  const karachi = buildOfferedSlots("Asia/Karachi", now);
  const phoenix = buildOfferedSlots("America/Phoenix", now);
  const sydney = buildOfferedSlots("Australia/Sydney", now);
  const opening = "2026-10-30T14:00:00.000Z";

  assert.deepEqual(karachi.map(slot => slot.start.toISOString()), newYork.map(slot => slot.start.toISOString()));
  assert.deepEqual(phoenix.map(slot => slot.start.toISOString()), newYork.map(slot => slot.start.toISOString()));
  assert.deepEqual(sydney.map(slot => slot.start.toISOString()), newYork.map(slot => slot.start.toISOString()));

  const karachiOpening = karachi.find(slot => slot.start.toISOString() === opening);
  const phoenixOpening = phoenix.find(slot => slot.start.toISOString() === opening);
  const sydneyOpening = sydney.find(slot => slot.start.toISOString() === opening);

  assert.equal(karachiOpening.dateISO, "2026-10-30");
  assert.equal(karachiOpening.time24, "19:00");
  assert.equal(describeSlot(karachiOpening, "Asia/Karachi").selectedDate, "Friday, October 30");
  assert.match(describeSlot(karachiOpening, "Asia/Karachi").selectedTime, /7:00\s*PM/);

  assert.equal(phoenixOpening.dateISO, "2026-10-30");
  assert.equal(phoenixOpening.time24, "07:00");
  assert.match(describeSlot(phoenixOpening, "America/Phoenix").selectedTime, /7:00\s*AM/);

  assert.equal(sydneyOpening.dateISO, "2026-10-31");
  assert.equal(sydneyOpening.time24, "01:00");
  assert.equal(describeSlot(sydneyOpening, "Australia/Sydney").selectedDate, "Saturday, October 31");
  assert.match(describeSlot(sydneyOpening, "Australia/Sydney").selectedTime, /1:00\s*AM/);
});

test("shifts the New York window with daylight saving time", () => {
  const beforeDst = buildOfferedSlots("America/New_York", new Date("2026-03-05T15:00:00.000Z"));
  const afterDst = buildOfferedSlots("America/New_York", new Date("2026-03-12T15:00:00.000Z"));
  const winter = buildOfferedSlots("America/New_York", new Date("2026-11-05T15:00:00.000Z"));

  assert.equal(slotOnNewYorkDay(beforeDst, "2026-03-06", "10:00").start.toISOString(), "2026-03-06T15:00:00.000Z");
  assert.equal(slotOnNewYorkDay(afterDst, "2026-03-13", "10:00").start.toISOString(), "2026-03-13T14:00:00.000Z");
  assert.equal(slotOnNewYorkDay(winter, "2026-11-06", "10:00").start.toISOString(), "2026-11-06T15:00:00.000Z");

  const sydneyWinter = buildOfferedSlots("Australia/Sydney", new Date("2026-11-05T15:00:00.000Z"));
  const sydneyOpening = sydneyWinter.find(slot => slot.start.toISOString() === "2026-11-06T15:00:00.000Z");
  assert.equal(sydneyOpening.dateISO, "2026-11-07");
  assert.equal(sydneyOpening.time24, "02:00");
});

test("converts fixed-offset zones without shifting the instant", () => {
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

test("rejects a slot outside the New York 10:00 AM to 6:00 PM window", () => {
  const slots = buildOfferedSlots("Asia/Karachi", now);
  const accepted = resolveBookDemoSlot({
    timeZone: "Asia/Karachi",
    selectedSlotUtc: "2026-10-30T14:00:00.000Z",
    now,
  });
  assert.equal(accepted.slot.start.toISOString(), slots[0].start.toISOString());
  assert.equal(accepted.slot.time24, "19:00");

  const oldMorning = resolveBookDemoSlot({
    timeZone: "America/New_York",
    selectedSlotUtc: "2026-10-30T13:00:00.000Z",
    now,
  });
  const sixPm = resolveBookDemoSlot({
    timeZone: "America/Phoenix",
    selectedSlotUtc: "2026-10-30T22:00:00.000Z",
    now,
  });
  assert.equal(oldMorning.error.status, 422);
  assert.equal(sixPm.error.status, 422);
});

test("formats Pakistan time from the UTC instant, including a date that crosses midnight", () => {
  assert.equal(
    formatPakistanTime("2026-10-30T19:30:00.000Z"),
    "Saturday, October 31, 2026 at 12:30 AM PKT",
  );
  assert.equal(
    formatPakistanTime("2026-10-30T09:00:00.000Z"),
    "Friday, October 30, 2026 at 2:00 PM PKT",
  );
  assert.equal(formatPakistanTime("not-a-date"), "");
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
