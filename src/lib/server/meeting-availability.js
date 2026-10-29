import { formTypes } from "./form-submissions.js";
import { getSubmissionCollection } from "./db.js";
import { getBookDemoMeetingAt } from "./meeting-time.js";
import {
  BOOK_DEMO_DURATION_MINUTES,
  BOOK_DEMO_LOOKAHEAD_DAYS,
  rangesOverlap,
} from "../meeting-slots.js";

const DURATION_MS = BOOK_DEMO_DURATION_MINUTES * 60 * 1000;

function idString(value) {
  if (value == null) return "";
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return String(value);
}

function createdMillis(document) {
  const value = document?.createdAt;
  const date = value instanceof Date ? value : new Date(value || document?.createdAtISO || 0);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareBookingOrder(left, right) {
  const created = createdMillis(left) - createdMillis(right);
  if (created) return created;

  const leftId = idString(left?._id);
  const rightId = idString(right?._id);
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
    const leftNumber = BigInt(leftId);
    const rightNumber = BigInt(rightId);
    if (leftNumber < rightNumber) return -1;
    if (leftNumber > rightNumber) return 1;
    return 0;
  }

  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function normalizedWindow(submission, durationMs = DURATION_MS) {
  const start = getBookDemoMeetingAt(submission);
  if (!start) return null;
  return {
    start,
    end: new Date(start.getTime() + durationMs),
  };
}

export function busyRangesFromSubmissions(submissions, now = new Date(), durationMs = DURATION_MS) {
  const windowStart = new Date(now.getTime() - durationMs);
  const windowEnd = new Date(now.getTime() + (BOOK_DEMO_LOOKAHEAD_DAYS + 6) * 24 * 60 * 60 * 1000);
  const ranges = [];
  const seen = new Set();

  for (const submission of submissions || []) {
    const formType = submission?.formType || submission?.source || "";
    if (formType !== formTypes.bookDemo) continue;
    const window = normalizedWindow(submission, durationMs);
    if (!window) continue;
    if (window.end <= windowStart || window.start >= windowEnd) continue;

    const start = window.start.toISOString();
    const end = window.end.toISOString();
    const key = `${start}|${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ start, end });
  }

  ranges.sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));
  return ranges;
}

async function readCursor(cursor, limit) {
  const limited = typeof cursor.limit === "function" ? cursor.limit(limit) : cursor;
  return limited.toArray();
}

async function loadCandidates(collection, rangeStart, rangeEnd) {
  const dated = await readCursor(collection.find({
    formType: formTypes.bookDemo,
    meetingAt: {
      $gt: rangeStart,
      $lt: rangeEnd,
    },
  }), 5000);
  const undated = await readCursor(collection.find({
    formType: formTypes.bookDemo,
    $or: [
      { meetingAt: null },
      { meetingAt: { $exists: false } },
    ],
  }), 2000);

  const byId = new Map();
  [...dated, ...undated].forEach((document, index) => {
    const key = idString(document?._id) || `missing-${index}-${document?.meetingAtISO || ""}`;
    if (!byId.has(key)) byId.set(key, document);
  });
  return [...byId.values()];
}

async function overlappingDocuments(collection, slotStart, slotEnd) {
  const rangeStart = new Date(slotStart.getTime() - DURATION_MS);
  const candidates = await loadCandidates(collection, rangeStart, slotEnd);
  return candidates.filter(document => {
    const window = normalizedWindow(document);
    return window ? rangesOverlap(slotStart, slotEnd, window.start, window.end) : false;
  });
}

export async function listBusyRanges(now = new Date()) {
  const collection = await getSubmissionCollection();
  const windowStart = new Date(now.getTime() - DURATION_MS);
  const windowEnd = new Date(now.getTime() + (BOOK_DEMO_LOOKAHEAD_DAYS + 6) * 24 * 60 * 60 * 1000);
  const candidates = await loadCandidates(collection, windowStart, windowEnd);
  return busyRangesFromSubmissions(candidates, now);
}

export async function reserveBookDemoSubmission(collection, document) {
  const slotStart = document?.meetingAt instanceof Date
    ? document.meetingAt
    : new Date(document?.meetingAt || document?.meetingAtISO || document?.fields?.selectedSlotUtc || "");

  if (Number.isNaN(slotStart.getTime())) {
    return {
      conflict: false,
      error: {
        status: 422,
        message: "Please choose a valid demo time.",
      },
    };
  }

  const slotEnd = new Date(slotStart.getTime() + DURATION_MS);
  const existing = await overlappingDocuments(collection, slotStart, slotEnd);
  if (existing.length) {
    return { conflict: true };
  }

  const inserted = await collection.insertOne(document);
  document._id = inserted.insertedId;

  let contenders = await overlappingDocuments(collection, slotStart, slotEnd);
  if (!contenders.some(item => idString(item?._id) === idString(document._id))) {
    contenders = contenders.concat(document);
  }
  contenders.sort(compareBookingOrder);

  if (idString(contenders[0]?._id) !== idString(document._id)) {
    await collection.deleteOne({ _id: document._id });
    return { conflict: true };
  }

  return {
    conflict: false,
    insertedId: document._id,
  };
}
