import { zonedDateTimeToUtc } from "../meeting-slots.js";

function clean(value) {
  return String(value ?? "").trim();
}

function parseDateParts(value) {
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function parseTimeParts(value) {
  const match = clean(value).toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] || "0");
  const meridiem = match[3] || "";

  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (meridiem === "pm") hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
}

function normalizeStoredDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getBookDemoMeetingAt(submission) {
  const fields = submission?.fields || submission || {};
  const explicit = normalizeStoredDate(fields.selectedSlotUtc);
  if (explicit) return explicit;

  const storedMeetingAt = normalizeStoredDate(submission?.meetingAt || submission?.meetingAtISO);
  const dateParts = parseDateParts(fields.selectedDateISO || fields.selectedDate);
  const timeParts = parseTimeParts(fields.selectedTime);
  const timeZone = clean(fields.timezone);

  if (!dateParts || !timeParts || !timeZone) return storedMeetingAt;

  return zonedDateTimeToUtc({
    ...dateParts,
    ...timeParts,
    timeZone,
  }) || storedMeetingAt;
}

export function formatMeetingDate(meetingAt, timeZone) {
  const zone = clean(timeZone) || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h12",
    }).formatToParts(meetingAt);
    const part = type => parts.find(item => item.type === type)?.value || "";
    const dayPeriod = part("dayPeriod").replace(/[\u202F\u00A0.]/g, "").toUpperCase();
    return `${part("weekday")}, ${part("month")} ${part("day")}, ${part("year")} at ${part("hour")}:${part("minute")} ${dayPeriod} (${zone})`
      .replace(/[\u202F\u00A0]/g, " ");
  } catch {
    return meetingAt.toISOString();
  }
}
