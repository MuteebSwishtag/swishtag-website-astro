import { buildZoomAgenda, demoServiceName, demoTitle } from "../demo-title.js";
import { BOOK_DEMO_DURATION_MINUTES } from "../meeting-slots.js";
import { formatMeetingDate, getBookDemoMeetingAt } from "./meeting-time.js";

const ZOOM_API_BASE_URL = "https://api.zoom.us/v2";
const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";

let tokenCache = {
  accessToken: "",
  expiresAt: 0,
};

let hostUserCache = {
  accessToken: "",
  userId: "",
};

function clean(value) {
  return String(value ?? "").trim();
}

function envValue(key, fallback = "") {
  return clean(process.env[key] || fallback);
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function splitEmails(value) {
  return clean(value)
    .split(",")
    .map(email => clean(email))
    .filter(email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function uniqueEmails(emails) {
  return [...new Set(emails.map(email => email.toLowerCase()))];
}

function getByPath(source, path) {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

function renderTemplate(template, context) {
  return clean(template).replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (_, key) => clean(getByPath(context, key)));
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatZoomStartTime(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
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
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  } catch {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

function getZoomConfig() {
  return {
    enabled: isTruthy(envValue("ZOOM_ENABLED")),
    registrationEnabled: isTruthy(envValue("ZOOM_REGISTRATION_ENABLED", "true")),
    accountId: envValue("ZOOM_ACCOUNT_ID"),
    clientId: envValue("ZOOM_CLIENT_ID"),
    clientSecret: envValue("ZOOM_CLIENT_SECRET"),
    durationMinutes: Number(envValue("ZOOM_MEETING_DURATION_MINUTES", "30")),
    contactName: envValue("ZOOM_CONTACT_NAME", envValue("MAIL_FROM_NAME", "Swishtag")),
    contactEmail: envValue("ZOOM_CONTACT_EMAIL", envValue("MAIL_FROM_ADDRESS", "")),
    inviteeEmails: splitEmails(envValue("ZOOM_INVITEE_EMAILS", envValue("MAIL_TO", ""))),
    topicTemplate: envValue("ZOOM_MEETING_TOPIC_TEMPLATE", "General Enquiry Demo"),
    agendaTemplate: envValue("ZOOM_MEETING_AGENDA_TEMPLATE", ""),
  };
}

function validateZoomConfig(config) {
  if (!config.enabled) {
    throw new Error("ZOOM_ENABLED is not true.");
  }

  for (const key of ["accountId", "clientId", "clientSecret"]) {
    if (!config[key]) {
      throw new Error(`Missing ${key} Zoom configuration.`);
    }
  }

  if (!Number.isFinite(config.durationMinutes) || config.durationMinutes <= 0) {
    throw new Error("ZOOM_MEETING_DURATION_MINUTES is invalid.");
  }
}

export function isZoomSchedulerEnabled() {
  return getZoomConfig().enabled;
}

export function getZoomSchedulerDebugInfo() {
  const config = getZoomConfig();
  return {
    enabled: config.enabled,
    registrationEnabled: config.registrationEnabled,
    hasAccountId: Boolean(config.accountId),
    hasClientId: Boolean(config.clientId),
    hasClientSecret: Boolean(config.clientSecret),
    hostUser: "auto",
    durationMinutes: config.durationMinutes,
    contactEmail: config.contactEmail,
    inviteeCount: config.inviteeEmails.length,
  };
}

async function readZoomResponse(response) {
  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const message = payload?.message || payload?.reason || response.statusText || "Zoom request failed.";
    throw new Error(`Zoom API ${response.status}: ${message}`);
  }

  return payload;
}

async function getZoomAccessToken(config) {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt - 60000 > now) {
    return tokenCache.accessToken;
  }

  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");
  const url = new URL(ZOOM_TOKEN_URL);
  url.searchParams.set("grant_type", "account_credentials");
  url.searchParams.set("account_id", config.accountId);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const payload = await readZoomResponse(response);

  tokenCache = {
    accessToken: clean(payload.access_token),
    expiresAt: now + Number(payload.expires_in || 3600) * 1000,
  };

  if (!tokenCache.accessToken) {
    throw new Error("Zoom did not return an access token.");
  }

  return tokenCache.accessToken;
}

async function getAuthenticatedZoomUserId(accessToken) {
  if (hostUserCache.accessToken === accessToken && hostUserCache.userId) {
    return hostUserCache.userId;
  }

  const response = await fetch(`${ZOOM_API_BASE_URL}/users/me`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const user = await readZoomResponse(response);
  const userId = clean(user.id || user.email);

  if (!userId) {
    throw new Error("Zoom did not return an authenticated user id.");
  }

  hostUserCache = {
    accessToken,
    userId,
  };

  return userId;
}

function createZoomPayload(config, input) {
  const startTime = normalizeDate(input.startTime);
  if (!startTime) {
    throw new Error("A valid startTime is required to create a Zoom meeting.");
  }

  const timeZone = clean(input.timeZone || "UTC");
  const customerEmail = clean(input.customerEmail);
  const inviteeEmails = uniqueEmails([
    ...config.inviteeEmails,
    ...splitEmails(input.inviteeEmails || ""),
    ...(customerEmail ? [customerEmail] : []),
  ]);
  const context = {
    ...input,
    startTime,
    timeZone,
  };

  return {
    topic: renderTemplate(input.topic || config.topicTemplate, context).slice(0, 200) || "General Enquiry Demo",
    type: 2,
    start_time: formatZoomStartTime(startTime, timeZone),
    duration: Number(input.durationMinutes || config.durationMinutes),
    timezone: timeZone,
    agenda: renderTemplate(input.agenda || config.agendaTemplate, context).slice(0, 2000),
    settings: {
      host_video: true,
      participant_video: true,
      join_before_host: false,
      mute_upon_entry: true,
      waiting_room: true,
      approval_type: config.registrationEnabled ? 0 : 2,
      email_notification: true,
      registrants_confirmation_email: true,
      registrants_email_notification: true,
      calendar_type: 1,
      contact_name: clean(input.contactName || config.contactName),
      contact_email: clean(input.contactEmail || config.contactEmail),
      meeting_invitees: inviteeEmails.map(email => ({ email })),
    },
  };
}

export function zoomRegistrantNames(input = {}) {
  const fields = input.fields || {};
  const firstName = clean(input.firstName || fields.firstName);
  const lastName = clean(input.lastName || fields.lastName);
  if (!firstName || !lastName) return null;
  return { firstName, lastName };
}

function toPortableRegistrant(registrant) {
  if (!registrant) return null;

  return {
    registrantId: String(registrant.registrant_id || registrant.id || ""),
    meetingId: String(registrant.id || ""),
    joinUrl: String(registrant.join_url || ""),
    startTime: String(registrant.start_time || ""),
    topic: String(registrant.topic || ""),
    participantPinCode: registrant.participant_pin_code || "",
  };
}

function zoomErrorDetails(error) {
  return {
    name: error?.name || "",
    message: error?.message || "Zoom registrant request failed.",
  };
}

async function addMeetingRegistrant(accessToken, meetingId, input) {
  const email = clean(input.customerEmail);
  if (!email) return null;

  const names = zoomRegistrantNames(input);
  if (!names) {
    throw new Error("A first name and last name are required for the Zoom registrant.");
  }
  const { firstName, lastName } = names;
  const response = await fetch(`${ZOOM_API_BASE_URL}/meetings/${encodeURIComponent(meetingId)}/registrants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      first_name: firstName,
      last_name: lastName,
      org: clean(input.companyName).slice(0, 128),
      comments: clean(input.fields?.notes).slice(0, 500),
      language: envValue("ZOOM_REGISTRANT_LANGUAGE", "en-US"),
    }),
  });

  return readZoomResponse(response);
}

function toPortableMeeting(meeting, registrant = null) {
  const portableRegistrant = toPortableRegistrant(registrant);

  return {
    id: String(meeting.id || ""),
    uuid: String(meeting.uuid || ""),
    hostId: String(meeting.host_id || ""),
    hostEmail: String(meeting.host_email || ""),
    topic: String(meeting.topic || ""),
    type: meeting.type,
    status: String(meeting.status || ""),
    startTime: String(meeting.start_time || ""),
    duration: meeting.duration,
    timezone: String(meeting.timezone || ""),
    joinUrl: String(portableRegistrant?.joinUrl || meeting.join_url || ""),
    hostJoinUrl: String(meeting.join_url || ""),
    startUrl: String(meeting.start_url || ""),
    password: String(meeting.password || ""),
    createdAt: String(meeting.created_at || ""),
    registrant: portableRegistrant,
  };
}

export async function createScheduledZoomMeeting(input) {
  const config = getZoomConfig();
  validateZoomConfig(config);

  const accessToken = await getZoomAccessToken(config);
  const userId = encodeURIComponent(await getAuthenticatedZoomUserId(accessToken));
  const payload = createZoomPayload(config, input);
  const response = await fetch(`${ZOOM_API_BASE_URL}/users/${userId}/meetings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const meeting = await readZoomResponse(response);
  let registrant = null;
  let registrantError = null;

  if (config.registrationEnabled) {
    try {
      registrant = await addMeetingRegistrant(accessToken, meeting.id, input);
    } catch (error) {
      registrantError = zoomErrorDetails(error);
    }
  }

  return {
    raw: meeting,
    meeting: toPortableMeeting(meeting, registrant),
    registrant: toPortableRegistrant(registrant),
    registrantError,
    invitees: payload.settings.meeting_invitees.map(invitee => invitee.email),
  };
}

function visitorMeetingTime(startTime, timeZone) {
  if (!startTime) return "";
  return formatMeetingDate(startTime, timeZone).replace(/[\u202F\u00A0]/g, " ");
}

export function bookDemoZoomDetails(submission, meetingAt) {
  const fields = submission?.fields || {};
  const startTime = normalizeDate(meetingAt || submission?.meetingAt || submission?.meetingAtISO)
    || getBookDemoMeetingAt(submission);
  const timeZone = clean(fields.timezone || "UTC");
  const serviceName = demoServiceName(fields.solutionInterest, fields.service);

  return {
    topic: (fields.demoTitle || demoTitle(fields.solutionInterest, fields.service)).slice(0, 200),
    agenda: buildZoomAgenda({
      serviceName,
      notes: fields.notes,
      meetingTime: visitorMeetingTime(startTime, timeZone),
    }),
    timeZone,
    startTime,
  };
}

export async function createZoomMeetingForSubmission(submission, meetingAt) {
  const fields = submission?.fields || {};
  const details = bookDemoZoomDetails(submission, meetingAt);

  return createScheduledZoomMeeting({
    topic: details.topic,
    agenda: details.agenda,
    // All bookings from /book-demo/ are 15 minutes, regardless of the general Zoom default.
    durationMinutes: submission?.source === "book-demo" || submission?.formType === "book-demo"
      ? BOOK_DEMO_DURATION_MINUTES
      : undefined,
    startTime: details.startTime,
    timeZone: details.timeZone,
    firstName: fields.firstName || "",
    lastName: fields.lastName || "",
    customerName: submission?.displayName || fields.fullName || fields.name || "",
    customerEmail: submission?.email || fields.workEmail || "",
    companyName: submission?.companyName || fields.companyName || "",
    displayName: submission?.displayName || fields.fullName || "",
    fields,
    page: submission?.page || "",
  });
}
