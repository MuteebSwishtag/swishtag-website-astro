export const BOOK_DEMO_DURATION_MINUTES = 15;
export const BOOK_DEMO_BUSINESS_DAY_COUNT = 10;
export const BOOK_DEMO_LOOKAHEAD_DAYS = 19;
export const BOOK_DEMO_SLOT_START_MINUTES = 9 * 60;
export const BOOK_DEMO_SLOT_END_MINUTES = 15 * 60;
export const BOOK_DEMO_SLOT_STEP_MINUTES = 15;

const WEEKDAYS = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function timeValue(value) {
  if (value instanceof Date) return value.getTime();
  const date = new Date(value || "");
  return date.getTime();
}

export function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string" || timeZone.length > 120) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function rangesOverlap(startA, endA, startB, endB) {
  const a0 = timeValue(startA);
  const a1 = timeValue(endA);
  const b0 = timeValue(startB);
  const b1 = timeValue(endB);
  if ([a0, a1, b0, b1].some(value => Number.isNaN(value))) return false;
  return a0 < b1 && b0 < a1;
}

export function slotIsBusy(slot, busyRanges = []) {
  return busyRanges.some(range => rangesOverlap(slot.start, slot.end, range.start, range.end));
}

export function wallClockFromUtc(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  let hour = Number(parts.hour);
  let day = Number(parts.day);
  let month = Number(parts.month);
  let year = Number(parts.year);
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }

  return {
    year,
    month,
    day,
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? -1,
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const wall = wallClockFromUtc(date, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - date.getTime();
}

export function zonedDateTimeToUtc({ year, month, day, hour, minute, timeZone }) {
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

export function civilDateFromUtc(date, timeZone) {
  const wall = wallClockFromUtc(date, timeZone);
  return { year: wall.year, month: wall.month, day: wall.day };
}

export function addCivilDays(parts, days) {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

export function formatDateISO(parts) {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function weekdayIndex(parts, timeZone) {
  const noon = zonedDateTimeToUtc({ ...parts, hour: 12, minute: 0, timeZone });
  if (!noon) return -1;
  return wallClockFromUtc(noon, timeZone).weekday;
}

function matchesWallClock(start, parts, hour, minute, timeZone) {
  const wall = wallClockFromUtc(start, timeZone);
  return wall.year === parts.year
    && wall.month === parts.month
    && wall.day === parts.day
    && wall.hour === hour
    && wall.minute === minute;
}

export function buildOfferedSlots(timeZone, now = new Date()) {
  if (!isValidTimeZone(timeZone)) return [];

  const today = civilDateFromUtc(now, timeZone);
  const slots = [];
  let businessDays = 0;

  for (let offset = 1; businessDays < BOOK_DEMO_BUSINESS_DAY_COUNT && offset <= BOOK_DEMO_LOOKAHEAD_DAYS; offset += 1) {
    const date = addCivilDays(today, offset);
    const weekday = weekdayIndex(date, timeZone);
    if (weekday === 0 || weekday === 6) continue;
    businessDays += 1;

    const dateISO = formatDateISO(date);
    for (
      let minutes = BOOK_DEMO_SLOT_START_MINUTES;
      minutes <= BOOK_DEMO_SLOT_END_MINUTES;
      minutes += BOOK_DEMO_SLOT_STEP_MINUTES
    ) {
      const hour = Math.floor(minutes / 60);
      const minute = minutes % 60;
      const start = zonedDateTimeToUtc({ ...date, hour, minute, timeZone });
      if (!start || !matchesWallClock(start, date, hour, minute, timeZone)) continue;

      slots.push({
        dateISO,
        time24: `${pad(hour)}:${pad(minute)}`,
        start,
        end: new Date(start.getTime() + BOOK_DEMO_DURATION_MINUTES * 60 * 1000),
      });
    }
  }

  return slots;
}

export function groupSlotsByDate(slots) {
  const groups = [];
  const index = new Map();

  for (const slot of slots) {
    let group = index.get(slot.dateISO);
    if (!group) {
      group = { dateISO: slot.dateISO, start: slot.start, slots: [] };
      index.set(slot.dateISO, group);
      groups.push(group);
    }
    group.slots.push(slot);
  }

  return groups;
}

export function resolveBookDemoSlot({ timeZone, selectedSlotUtc, now = new Date() } = {}) {
  if (!isValidTimeZone(timeZone)) {
    return {
      error: {
        status: 422,
        message: "We couldn't read a valid timezone. Please refresh the page and try again.",
      },
    };
  }

  const start = new Date(selectedSlotUtc || "");
  if (Number.isNaN(start.getTime())) {
    return {
      error: {
        status: 422,
        message: "Please choose a valid demo time.",
      },
    };
  }

  const match = buildOfferedSlots(timeZone, now).find(slot => slot.start.getTime() === start.getTime());
  if (!match) {
    return {
      error: {
        status: 422,
        message: "Please choose one of the available demo times.",
      },
    };
  }

  return { slot: match };
}

export function describeSlot(slot, timeZone) {
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(slot.start);
  const timeLabel = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(slot.start);

  return {
    selectedDate: dateLabel,
    selectedDateISO: slot.dateISO,
    selectedTime: timeLabel,
    selectedTime24: slot.time24,
    selectedSlotUtc: slot.start.toISOString(),
    timezone: timeZone,
  };
}

export function timezoneLabel(timeZone, locale) {
  if (!isValidTimeZone(timeZone)) return String(timeZone || "");

  for (const timeZoneName of ["longGeneric", "long", "short"]) {
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName }).formatToParts(new Date());
      const name = parts.find(part => part.type === "timeZoneName")?.value || "";
      if (name && name !== timeZone) return `${name} (${timeZone})`;
    } catch {
      // longGeneric is not available in every Intl build.
    }
  }

  return timeZone;
}
