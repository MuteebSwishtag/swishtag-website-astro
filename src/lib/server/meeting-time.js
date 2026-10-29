function clean(value) {
  return String(value ?? "").trim();
}

// /book-demo/ business hours: Mon-Fri, 9:30 AM-5:30 PM America/New_York, all year.
// Keep in sync with the constants in src/pages/book-demo/index.astro.
export const BOOKING_TIME_ZONE = "America/New_York";
export const BOOKING_DAY_START_MINUTES = 9 * 60 + 30; // 9:30 AM
export const BOOKING_DAY_END_MINUTES = 17 * 60 + 30; // 5:30 PM (meeting must end by then)
export const BOOKING_MEETING_MINUTES = 15;

export function isValidTimeZone(value) {
  const timeZone = clean(value);
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getBusinessTimeZone() {
  return BOOKING_TIME_ZONE;
}

// True when a meeting starting at `date` is a bookable slot: Mon-Fri, on the
// 15-minute grid, starting at or after 9:30 AM and ending by 5:30 PM New York time.
export function isWithinBookingHours(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: BOOKING_TIME_ZONE,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date).map(part => [part.type, part.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return date.getUTCSeconds() === 0
    && date.getUTCMilliseconds() === 0
    && (minutes - BOOKING_DAY_START_MINUTES) % BOOKING_MEETING_MINUTES === 0
    && minutes >= BOOKING_DAY_START_MINUTES
    && minutes + BOOKING_MEETING_MINUTES <= BOOKING_DAY_END_MINUTES;
}

// Absolute meeting time sent by the booking page as an ISO 8601 UTC string.
export function parseSelectedSlotUtc(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
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

function getTimeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToUtc({ year, month, day, hour, minute, timeZone }) {
  try {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    const offset = getTimeZoneOffsetMs(utcGuess, timeZone);
    let utcDate = new Date(utcGuess.getTime() - offset);
    const correctedOffset = getTimeZoneOffsetMs(utcDate, timeZone);

    if (offset !== correctedOffset) {
      utcDate = new Date(utcGuess.getTime() - correctedOffset);
    }

    return Number.isNaN(utcDate.getTime()) ? null : utcDate;
  } catch {
    return null;
  }
}

function normalizeStoredDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getBookDemoMeetingAt(submission) {
  const fields = submission?.fields || submission || {};
  const storedMeetingAt = normalizeStoredDate(submission?.meetingAt || submission?.meetingAtISO);
  const selectedSlotUtc = parseSelectedSlotUtc(fields.selectedSlotUTC);

  // Newer bookings carry the exact UTC instant; it is unambiguous across DST and locales.
  if (selectedSlotUtc) return selectedSlotUtc;
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
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: clean(timeZone) || "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(meetingAt);
  } catch {
    return meetingAt.toISOString();
  }
}

// Example: "Monday, November 2, 2026 at 9:00 AM EST (America/New_York)"
export function formatMeetingDateWithZone(meetingAt, timeZone) {
  const zone = clean(timeZone) || "UTC";
  const formatted = formatMeetingDate(meetingAt, zone);
  return isValidTimeZone(zone) ? `${formatted} (${zone})` : formatted;
}
