import { reserveBookDemoSubmission } from "../../../lib/server/meeting-availability.js";
import { createSubmissionDocument, getSubmissionCollection } from "../../../lib/server/form-submissions.js";
import { getDatabaseDebugInfo } from "../../../lib/server/db.js";
import { getMailDebugInfo, sendMeetingScheduledEmail, sendSubmissionEmail } from "../../../lib/server/mail.js";
import {
  createZoomMeetingForSubmission,
  getZoomSchedulerDebugInfo,
  isZoomSchedulerEnabled,
} from "../../../lib/server/zoom-scheduler.js";
import { randomUUID } from "node:crypto";

function errorDetails(error) {
  return {
    name: error?.name,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    hostname: error?.hostname,
    message: error?.message,
    stack: error?.stack,
  };
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function readPayload(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const payload = await request.json().catch(() => null);
    return payload && typeof payload === "object" ? payload : {};
  }

  const formData = await request.formData();
  return Object.fromEntries(formData.entries());
}

function recordSubmissionUpdate(collection, submissionId, update, requestId, label) {
  return Promise.resolve()
    .then(() => collection.updateOne({ _id: submissionId }, update))
    .catch(updateError => {
      console.error(`[Swishtag form] could not update ${label}`, {
        requestId,
        updateError: errorDetails(updateError),
      });
    });
}

export function OPTIONS() {
  return new Response(null, { status: 204 });
}

export function GET() {
  return json({
    ok: false,
    message: "This endpoint is available and only accepts POST form submissions.",
  }, 405);
}

export async function POST({ request }, overrides = {}) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const loadCollection = overrides.getSubmissionCollection || getSubmissionCollection;
  const zoomEnabled = overrides.isZoomSchedulerEnabled || isZoomSchedulerEnabled;
  const createZoom = overrides.createZoomMeetingForSubmission || createZoomMeetingForSubmission;
  const notify = overrides.sendSubmissionEmail || sendSubmissionEmail;
  const confirmMeeting = overrides.sendMeetingScheduledEmail || sendMeetingScheduledEmail;

  console.info("[Swishtag form] submit received", {
    requestId,
    method: request.method,
    url: request.url,
    contentType: request.headers.get("content-type") || "",
    database: getDatabaseDebugInfo(),
    mail: getMailDebugInfo(),
    zoom: getZoomSchedulerDebugInfo(),
  });

  try {
    const data = await readPayload(request);
    const result = createSubmissionDocument(data, request);

    console.info("[Swishtag form] payload parsed", {
      requestId,
      source: data?.form_source || data?.source || "",
      fieldKeys: Object.keys(data || {}),
      skipped: Boolean(result.skipped),
      hasValidationError: Boolean(result.error),
    });

    if (result.skipped) {
      console.info("[Swishtag form] honeypot submission skipped", { requestId });
      return json({ ok: true, message: "Thanks. Your request has been received.", requestId });
    }

    if (result.error) {
      console.warn("[Swishtag form] validation failed", {
        requestId,
        status: result.error.status,
        message: result.error.message,
      });
      return json({ ok: false, message: result.error.message, requestId }, result.error.status);
    }

    const databaseInfo = getDatabaseDebugInfo();

    console.info("[Swishtag form] connecting to collection", {
      requestId,
      formType: result.document.formType,
      collection: databaseInfo.collection || databaseInfo.table,
    });

    const collection = await loadCollection();
    if (result.document.formType === "book-demo") {
      const reserved = await reserveBookDemoSubmission(collection, result.document);
      if (reserved.error) {
        return json({ ok: false, message: reserved.error.message, requestId }, reserved.error.status);
      }
      if (reserved.conflict) {
        console.info("[Swishtag form] slot already booked", {
          requestId,
          slot: result.document.meetingAtISO || "",
        });
        return json({
          ok: false,
          code: "slot_taken",
          message: "That time was just booked. Please choose another slot.",
          requestId,
        }, 409);
      }
    } else {
      result.document._id = (await collection.insertOne(result.document)).insertedId;
    }

    const submissionId = result.document._id;

    console.info("[Swishtag form] submission saved", {
      requestId,
      insertedId: submissionId?.toString(),
      formType: result.document.formType,
      durationMs: Date.now() - startedAt,
    });

    const followUpProblems = [];

    if (result.document.formType === "book-demo") {
      if (zoomEnabled()) {
        try {
          console.info("[Swishtag form] creating Zoom meeting", {
            requestId,
            insertedId: submissionId?.toString(),
            zoom: getZoomSchedulerDebugInfo(),
          });

          await recordSubmissionUpdate(collection, submissionId, {
            $set: {
              zoomStatus: "creating",
              zoomStartedAt: new Date(),
            },
            $unset: {
              zoomError: "",
            },
          }, requestId, "Zoom start status");

          const zoomResult = await createZoom(result.document);
          result.document.zoomMeeting = zoomResult.meeting;
          result.document.zoomStatus = zoomResult.registrantError ? "created_registrant_failed" : "created";

          await recordSubmissionUpdate(collection, submissionId, {
            $set: {
              zoomStatus: result.document.zoomStatus,
              zoomCreatedAt: new Date(),
              zoomMeeting: zoomResult.meeting,
              zoomRegistrant: zoomResult.registrant,
              zoomRegistrantError: zoomResult.registrantError,
              zoomInvitees: zoomResult.invitees,
              zoomError: zoomResult.registrantError?.message || "",
            },
          }, requestId, "Zoom created status");

          console.info("[Swishtag form] Zoom meeting created", {
            requestId,
            insertedId: submissionId?.toString(),
            meetingId: zoomResult.meeting.id,
            invitees: zoomResult.invitees,
            registrantCreated: Boolean(zoomResult.registrant),
            registrantError: zoomResult.registrantError,
          });
        } catch (zoomError) {
          result.document.zoomStatus = "failed";
          result.document.zoomMeeting = null;
          followUpProblems.push("zoom");

          await recordSubmissionUpdate(collection, submissionId, {
            $set: {
              zoomStatus: "failed",
              zoomError: zoomError?.message || "Zoom meeting creation failed.",
            },
          }, requestId, "Zoom failure status");

          console.error("[Swishtag form] Zoom meeting creation failed", {
            requestId,
            insertedId: submissionId?.toString(),
            error: errorDetails(zoomError),
            zoom: getZoomSchedulerDebugInfo(),
          });
        }
      } else {
        result.document.zoomStatus = "disabled";
        await recordSubmissionUpdate(collection, submissionId, {
          $set: {
            zoomStatus: "disabled",
            zoomError: "",
          },
        }, requestId, "Zoom disabled status");
      }
    }

    try {
      console.info("[Swishtag form] sending email notification", {
        requestId,
        insertedId: submissionId?.toString(),
        mail: getMailDebugInfo(),
      });

      const mailResult = await notify(result.document);
      const emailSentAt = new Date();

      await recordSubmissionUpdate(collection, submissionId, {
        $set: {
          emailStatus: "sent",
          emailSentAt,
          emailError: "",
        },
      }, requestId, "email sent status");

      console.info("[Swishtag form] email notification sent", {
        requestId,
        insertedId: submissionId?.toString(),
        recipients: mailResult.recipients,
        subject: mailResult.subject,
        durationMs: Date.now() - startedAt,
      });
    } catch (mailError) {
      followUpProblems.push("email");
      await recordSubmissionUpdate(collection, submissionId, {
        $set: {
          emailStatus: "failed",
          emailError: mailError?.message || "Email failed.",
        },
      }, requestId, "email failure status");

      console.error("[Swishtag form] email notification failed", {
        requestId,
        insertedId: submissionId?.toString(),
        error: errorDetails(mailError),
        mail: getMailDebugInfo(),
      });
    }

    if (result.document.formType === "book-demo") {
      try {
        console.info("[Swishtag form] sending meeting confirmation", {
          requestId,
          insertedId: submissionId?.toString(),
          mail: getMailDebugInfo(),
        });

        const confirmationResult = await confirmMeeting(result.document, result.document.meetingAt);
        const meetingConfirmationSentAt = new Date();

        await recordSubmissionUpdate(collection, submissionId, {
          $set: {
            meetingConfirmationStatus: "sent",
            meetingConfirmationSentAt,
            meetingConfirmationError: "",
            meetingConfirmationRecipients: confirmationResult.recipients,
            meetingConfirmationSubject: confirmationResult.subject,
          },
        }, requestId, "meeting confirmation status");

        console.info("[Swishtag form] meeting confirmation sent", {
          requestId,
          insertedId: submissionId?.toString(),
          recipients: confirmationResult.recipients,
          durationMs: Date.now() - startedAt,
        });
      } catch (confirmationError) {
        followUpProblems.push("confirmation");
        await recordSubmissionUpdate(collection, submissionId, {
          $set: {
            meetingConfirmationStatus: "failed",
            meetingConfirmationError: confirmationError?.message || "Meeting confirmation email failed.",
          },
        }, requestId, "meeting confirmation failure status");

        console.error("[Swishtag form] meeting confirmation failed", {
          requestId,
          insertedId: submissionId?.toString(),
          error: errorDetails(confirmationError),
          mail: getMailDebugInfo(),
        });
      }
    }

    const payload = {
      ok: true,
      message: "Thanks. Your request has been saved and sent to Swishtag.",
      requestId,
    };
    if (followUpProblems.length) {
      payload.warning = "Your request was saved. Some follow-up messages could not be sent.";
    }
    return json(payload);
  } catch (error) {
    console.error("[Swishtag form] submit failed", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: errorDetails(error),
      database: getDatabaseDebugInfo(),
    });

    const missingDatabase = /Missing MONGODB_|Missing MySQL configuration/i.test(error?.message || "");
    return json({
      ok: false,
      message: missingDatabase
        ? "We could not save your request right now because the form database is not configured. Please email hello@swishtag.com directly."
        : "We could not save your request right now. Please try again or email hello@swishtag.com directly.",
      requestId,
    }, 500);
  }
}
