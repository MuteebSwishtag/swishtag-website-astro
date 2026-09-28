import { randomUUID } from "node:crypto";
import { runDailyMeetingReminders } from "../../../lib/server/meeting-reminders.js";
import { getMailDebugInfo } from "../../../lib/server/mail.js";
import { getDatabaseDebugInfo } from "../../../lib/server/db.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function errorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    stack: error?.stack,
  };
}

function getProvidedSecret(request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return new URL(request.url).searchParams.get("secret") || "";
}

function getWindowHours(request) {
  const value = Number(
    new URL(request.url).searchParams.get("hours")
      || process.env.MEETING_REMINDER_WINDOW_HOURS
      || "24",
  );
  return Number.isFinite(value) && value > 0 && value <= 72 ? value : 24;
}

function getSafeUrl(value) {
  const url = new URL(value);
  if (url.searchParams.has("secret")) {
    url.searchParams.set("secret", "[redacted]");
  }
  return `${url.pathname}${url.search}`;
}

async function handleReminderCron(request) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  const providedSecret = getProvidedSecret(request);

  console.info("[Swishtag reminders] cron request received", {
    requestId,
    method: request.method,
    url: getSafeUrl(request.url),
    hasCronSecret: Boolean(cronSecret),
    hasProvidedSecret: Boolean(providedSecret),
    database: getDatabaseDebugInfo(),
    mail: getMailDebugInfo(),
  });

  if (!cronSecret) {
    console.error("[Swishtag reminders] CRON_SECRET is missing", { requestId });
    return json({
      ok: false,
      message: "CRON_SECRET is not configured.",
      requestId,
    }, 500);
  }

  if (providedSecret !== cronSecret) {
    console.warn("[Swishtag reminders] cron request forbidden", { requestId });
    return json({
      ok: false,
      message: "Forbidden.",
      requestId,
    }, 403);
  }

  try {
    const windowHours = getWindowHours(request);
    const result = await runDailyMeetingReminders({
      windowHours,
    });

    console.info("[Swishtag reminders] cron completed", {
      requestId,
      durationMs: Date.now() - startedAt,
      windowHours,
      checked: result.checked,
      sent: result.sent,
      failed: result.failed,
      skipped: result.skipped,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
    });

    return json({
      ...result,
      requestId,
    }, result.failed ? 500 : 200);
  } catch (error) {
    console.error("[Swishtag reminders] cron failed", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: errorDetails(error),
      database: getDatabaseDebugInfo(),
      mail: getMailDebugInfo(),
    });

    return json({
      ok: false,
      message: "Daily reminder job failed.",
      requestId,
    }, 500);
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}

export async function GET({ request }) {
  return handleReminderCron(request);
}

export async function POST({ request }) {
  return handleReminderCron(request);
}
