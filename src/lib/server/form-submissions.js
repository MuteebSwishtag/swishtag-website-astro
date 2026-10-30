import { demoTitle } from "../demo-title.js";
import { describeSlot, resolveBookDemoSlot } from "../meeting-slots.js";
import { formatPakistanTime } from "../pakistan-time.js";
import { getSubmissionCollection as getDatabaseSubmissionCollection } from "./db.js";
import { resolveLocation } from "./locations.js";

const COLLECTION_NAME = process.env.FORM_SUBMISSIONS_COLLECTION || "form_submissions";

const bookDemoLabels = {
  firstName: "First name",
  lastName: "Last name",
  fullName: "Full name",
  workEmail: "Work email",
  companyName: "Company",
  website: "Website",
  country: "Country",
  countryCode: "Country code",
  city: "City",
  solutionInterest: "Solution interest",
  service: "Service",
  intent: "Intent",
  storeCount: "Store count",
  selectedDate: "Selected date",
  selectedDateISO: "Selected date ISO",
  selectedTime: "Selected time",
  selectedTime24: "Selected time (24-hour)",
  selectedSlotUtc: "Selected slot (UTC)",
  timezone: "Timezone",
  notes: "Notes",
};

const discussIdeaLabels = {
  name: "Name",
  email: "Work email",
  project_type: "Project type",
  stage: "Stage",
  problem: "Problem",
  integrations: "Integrations",
  budget: "Estimated investment",
};

const contactLabels = {
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  workEmail: "Work email",
  companyName: "Company",
  role: "Role",
  topic: "Topic",
  message: "Message",
};

export const formTypes = {
  bookDemo: "book-demo",
  discussIdea: "discuss-idea",
  contact: "contact",
};

export function cleanString(value, max = 2000) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
  return text.replace(/\r|\0/g, "").trim().slice(0, max);
}

export function normalizeWebsiteUrl(value) {
  const trimmed = cleanString(value, 300);
  if (!trimmed) return "";
  if (/\s/.test(trimmed)) return "";

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (!url.hostname || !url.hostname.includes(".")) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function getSubmissionCollection() {
  return getDatabaseSubmissionCollection(COLLECTION_NAME);
}

function missingRequiredFields(data, fields) {
  return fields.filter(field => cleanString(data[field] ?? "") === "");
}

export function createSubmissionDocument(data, request) {
  const source = cleanString(data.form_source ?? data.source ?? "", 80);
  const honeypot = cleanString(data.nickname ?? data._gotcha ?? "", 120);

  if (honeypot) {
    return { skipped: true };
  }

  if (source !== "book-demo" && source !== "custom-software" && source !== "contact") {
    return {
      error: {
        status: 400,
        message: "This form could not be verified. Please refresh and try again.",
      },
    };
  }

  const isBookDemo = source === "book-demo";
  const isContact = source === "contact";
  const required = isBookDemo
    ? ["firstName", "lastName", "workEmail", "companyName", "country", "city", "solutionInterest", "selectedDate", "selectedTime", "timezone", "selectedSlotUtc"]
    : isContact
      ? ["fullName", "firstName", "lastName", "workEmail", "companyName", "role", "topic", "message"]
      : ["name", "email", "project_type", "stage", "problem"];
  const missing = missingRequiredFields(data, required);

  if (missing.length) {
    const message = isBookDemo && missing.includes("firstName")
      ? "Please enter your first name."
      : isBookDemo && missing.includes("lastName")
        ? "Please enter your last name."
        : "Please complete all required fields before submitting.";
    return {
      error: {
        status: 422,
        message,
      },
    };
  }

  const email = cleanString(isBookDemo || isContact ? data.workEmail : data.email, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      error: {
        status: 422,
        message: "Please enter a valid work email address.",
      },
    };
  }

  const labels = isBookDemo ? bookDemoLabels : isContact ? contactLabels : discussIdeaLabels;
  const fields = {};

  for (const [key] of Object.entries(labels)) {
    if (key === "website") {
      const rawWebsite = cleanString(data.website ?? "", 300);
      const website = normalizeWebsiteUrl(rawWebsite);
      if (rawWebsite && !website) {
        return {
          error: {
            status: 422,
            message: "Please enter a valid website like google.com or www.google.com.",
          },
        };
      }
      fields.website = website;
      continue;
    }

    fields[key] = cleanString(data[key] ?? "", key === "problem" || key === "notes" || key === "message" ? 3000 : 300);
  }

  let bookDemoMeetingAt = null;
  if (isBookDemo) {
    const location = resolveLocation({
      country: fields.country,
      city: fields.city,
      countryCode: data.countryCode,
      timeZone: fields.timezone,
    });
    if (!location.ok) {
      return {
        error: {
          status: 422,
          message: location.message,
        },
      };
    }

    if (!location.timezone || fields.timezone !== location.timezone) {
      return {
        error: {
          status: 422,
          message: "Please choose a demo time in the selected city's timezone.",
        },
      };
    }

    fields.country = location.country;
    fields.countryCode = location.countryCode;
    fields.city = location.city;
    fields.timezone = location.timezone;

    const resolvedSlot = resolveBookDemoSlot({
      timeZone: fields.timezone,
      selectedSlotUtc: fields.selectedSlotUtc,
    });
    if (resolvedSlot.error) return { error: resolvedSlot.error };

    Object.assign(fields, describeSlot(resolvedSlot.slot, fields.timezone));
    const combinedName = `${fields.firstName} ${fields.lastName}`.trim();
    fields.fullName = combinedName;
    fields.name = combinedName;
    fields.demoTitle = demoTitle(fields.solutionInterest, fields.service);
    fields.meetingTimePkt = formatPakistanTime(resolvedSlot.slot.start);
    bookDemoMeetingAt = resolvedSlot.slot.start;
  }

  const now = new Date();
  const headers = request.headers;

  const document = {
    source,
    formType: isBookDemo ? formTypes.bookDemo : isContact ? formTypes.contact : formTypes.discussIdea,
    title: isBookDemo ? "Book Demo" : isContact ? "Contact" : "Discuss Idea",
    email,
    displayName: cleanString(
      isBookDemo
        ? `${cleanString(data.firstName, 80)} ${cleanString(data.lastName, 80)}`
        : isContact
          ? (data.fullName || data.name || `${data.firstName || ""} ${data.lastName || ""}`)
          : (data.name || data.fullName),
      160,
    ),
    companyName: cleanString(data.companyName ?? "", 160),
    fields,
    page: cleanString(data.page ?? headers.get("referer") ?? "", 500),
    formLoadedAt: cleanString(data.form_loaded_at ?? "", 80),
    ipAddress: cleanString(
      headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "",
      80,
    ),
    userAgent: cleanString(headers.get("user-agent") ?? "", 500),
    emailStatus: "pending",
    emailSentAt: null,
    emailError: "",
    reminderStatus: isBookDemo ? "pending" : "not_applicable",
    reminderSentAt: null,
    reminderError: "",
    zoomStatus: isBookDemo ? "pending" : "not_applicable",
    zoomError: "",
    zoomMeeting: null,
    zoomRegistrant: null,
    zoomRegistrantError: null,
    meetingConfirmationStatus: isBookDemo ? "pending" : "not_applicable",
    meetingConfirmationSentAt: null,
    meetingConfirmationError: "",
    createdAt: now,
    createdAtISO: now.toISOString(),
  };

  if (isBookDemo) {
    document.meetingAt = bookDemoMeetingAt;
    document.meetingAtISO = bookDemoMeetingAt?.toISOString() || "";
  }

  return {
    document,
  };
}

export function serializeSubmission(submission) {
  return {
    id: submission._id?.toString() ?? "",
    source: submission.source ?? "",
    formType: submission.formType ?? "",
    title: submission.title ?? "",
    email: submission.email ?? "",
    displayName: submission.displayName ?? "",
    companyName: submission.companyName ?? "",
    fields: submission.fields ?? {},
    page: submission.page ?? "",
    ipAddress: submission.ipAddress ?? "",
    userAgent: submission.userAgent ?? "",
    emailStatus: submission.emailStatus ?? "",
    emailSentAt: submission.emailSentAt instanceof Date
      ? submission.emailSentAt.toISOString()
      : submission.emailSentAt ?? "",
    emailError: submission.emailError ?? "",
    reminderStatus: submission.reminderStatus ?? "",
    reminderSentAt: submission.reminderSentAt instanceof Date
      ? submission.reminderSentAt.toISOString()
      : submission.reminderSentAt ?? "",
    reminderError: submission.reminderError ?? "",
    zoomStatus: submission.zoomStatus ?? "",
    zoomError: submission.zoomError ?? "",
    zoomMeeting: submission.zoomMeeting ?? null,
    zoomRegistrant: submission.zoomRegistrant ?? null,
    zoomRegistrantError: submission.zoomRegistrantError ?? null,
    meetingConfirmationStatus: submission.meetingConfirmationStatus ?? "",
    meetingConfirmationSentAt: submission.meetingConfirmationSentAt instanceof Date
      ? submission.meetingConfirmationSentAt.toISOString()
      : submission.meetingConfirmationSentAt ?? "",
    meetingConfirmationError: submission.meetingConfirmationError ?? "",
    meetingAt: submission.meetingAt instanceof Date
      ? submission.meetingAt.toISOString()
      : submission.meetingAtISO ?? "",
    createdAt: submission.createdAt instanceof Date
      ? submission.createdAt.toISOString()
      : submission.createdAtISO ?? "",
  };
}
