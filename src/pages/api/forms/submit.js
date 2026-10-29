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

export function OPTIONS() {
  return new Response(null, { status: 204 });
}

export function GET() {
  return json({
    ok: false,
    message: "This endpoint is available and only accepts POST form submissions.",
  }, 405);
}

export async function POST({ request }) {
  const requestId = randomUUID();
  const startedAt = Date.now();

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

    const collection = await getSubmissionCollection();
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
      const insertResult = await collection.insertOne(result.document);
      result.document._id = insertResult.insertedId;
    }

    console.info("[Swishtag form] submission saved", {
      requestId,
      insertedId: result.document._id?.toString(),
      formType: result.document.formType,
      durationMs: Date.now() - startedAt,
    });

    if (result.document.formType === "book-demo") {
      if (isZoomSchedulerEnabled()) {
        try {
          console.info("[Swishtag form] creating Zoom meeting", {
            requestId,
            insertedId: insertResult.insertedId?.toString(),
            zoom: getZoomSchedulerDebugInfo(),
          });

          await collection.updateOne(
            { _id: insertResult.insertedId },
            {
              $set: {
                zoomStatus: "creating",
                zoomStartedAt: new Date(),
              },
              $unset: {
                zoomError: "",
              },
            },
          );

          const zoomResult = await createZoomMeetingForSubmission(result.document);
          result.document.zoomMeeting = zoomResult.meeting;
          result.document.zoomStatus = zoomResult.registrantError ? "created_registrant_failed" : "created";

          await collection.updateOne(
            { _id: insertResult.insertedId },
            {
              $set: {
                zoomStatus: result.document.zoomStatus,
                zoomCreatedAt: new Date(),
                zoomMeeting: zoomResult.meeting,
                zoomRegistrant: zoomResult.registrant,
                zoomRegistrantError: zoomResult.registrantError,
                zoomInvitees: zoomResult.invitees,
                zoomError: zoomResult.registrantError?.message || "",
              },
            },
          );

          console.info("[Swishtag form] Zoom meeting created", {
            requestId,
            insertedId: insertResult.insertedId?.toString(),
            meetingId: zoomResult.meeting.id,
            invitees: zoomResult.invitees,
            registrantCreated: Boolean(zoomResult.registrant),
            registrantError: zoomResult.registrantError,
          });
        } catch (zoomError) {
          await collection.updateOne(
            { _id: insertResult.insertedId },
            {
              $set: {
                zoomStatus: "failed",
                zoomError: zoomError?.message || "Zoom meeting creation failed.",
              },
            },
          ).catch(updateError => {
            console.error("[Swishtag form] could not update Zoom failure status", {
              requestId,
              updateError: errorDetails(updateError),
            });
          });

          console.error("[Swishtag form] Zoom meeting creation failed", {
            requestId,
            insertedId: insertResult.insertedId?.toString(),
            error: errorDetails(zoomError),
            zoom: getZoomSchedulerDebugInfo(),
          });

          return json({
            ok: false,
            message: "Your request was saved, but we could not create the Zoom meeting. Please email hello@swishtag.com directly.",
            requestId,
          }, 500);
        }
      } else {
        result.document.zoomStatus = "disabled";
        await collection.updateOne(
          { _id: insertResult.insertedId },
          {
            $set: {
              zoomStatus: "disabled",
              zoomError: "",
            },
          },
        );
      }
    }

    try {
      console.info("[Swishtag form] sending email notification", {
        requestId,
        insertedId: insertResult.insertedId?.toString(),
        mail: getMailDebugInfo(),
      });

      const mailResult = await sendSubmissionEmail(result.document);
      const emailSentAt = new Date();

      await collection.updateOne(
        { _id: insertResult.insertedId },
        {
          $set: {
            emailStatus: "sent",
            emailSentAt,
            emailError: "",
          },
        },
      );

      console.info("[Swishtag form] email notification sent", {
        requestId,
        insertedId: insertResult.insertedId?.toString(),
        recipients: mailResult.recipients,
        subject: mailResult.subject,
        durationMs: Date.now() - startedAt,
      });
    } catch (mailError) {
      await collection.updateOne(
        { _id: insertResult.insertedId },
        {
          $set: {
            emailStatus: "failed",
            emailError: mailError?.message || "Email failed.",
          },
        },
      ).catch(updateError => {
        console.error("[Swishtag form] could not update email failure status", {
          requestId,
          updateError: errorDetails(updateError),
        });
      });

      console.error("[Swishtag form] email notification failed", {
        requestId,
        insertedId: insertResult.insertedId?.toString(),
        error: errorDetails(mailError),
        mail: getMailDebugInfo(),
      });

      return json({
        ok: false,
        message: "Your request was saved, but we could not send the email notification. Please email hello@swishtag.com directly.",
        requestId,
      }, 500);
    }

    if (result.document.formType === "book-demo") {
      try {
        console.info("[Swishtag form] sending meeting confirmation", {
          requestId,
          insertedId: insertResult.insertedId?.toString(),
          mail: getMailDebugInfo(),
        });

        const confirmationResult = await sendMeetingScheduledEmail(result.document, result.document.meetingAt);
        const meetingConfirmationSentAt = new Date();

        await collection.updateOne(
          { _id: insertResult.insertedId },
          {
            $set: {
              meetingConfirmationStatus: "sent",
              meetingConfirmationSentAt,
              meetingConfirmationError: "",
              meetingConfirmationRecipients: confirmationResult.recipients,
              meetingConfirmationSubject: confirmationResult.subject,
            },
          },
        );

        console.info("[Swishtag form] meeting confirmation sent", {
          requestId,
          insertedId: insertResult.insertedId?.toString(),
          recipients: confirmationResult.recipients,
          durationMs: Date.now() - startedAt,
        });
      } catch (confirmationError) {
        await collection.updateOne(
          { _id: insertResult.insertedId },
          {
            $set: {
              meetingConfirmationStatus: "failed",
              meetingConfirmationError: confirmationError?.message || "Meeting confirmation email failed.",
            },
          },
        ).catch(updateError => {
          console.error("[Swishtag form] could not update confirmation failure status", {
            requestId,
            updateError: errorDetails(updateError),
          });
        });

        console.error("[Swishtag form] meeting confirmation failed", {
          requestId,
          insertedId: insertResult.insertedId?.toString(),
          error: errorDetails(confirmationError),
          mail: getMailDebugInfo(),
        });

        return json({
          ok: false,
          message: "Your request was saved, but we could not send the meeting confirmation. Please email hello@swishtag.com directly.",
          requestId,
        }, 500);
      }
    }

    return json({
      ok: true,
      message: "Thanks. Your request has been saved and sent to Swishtag.",
      requestId,
    });
  } catch (error) {
    console.error("[Swishtag form] submit failed", {
      requestId,
      durationMs: Date.now() - startedAt,
      error: errorDetails(error),
      database: getDatabaseDebugInfo(),
    });

    return json({
      ok: false,
      message: "We could not save your request right now. Please try again or email hello@swishtag.com directly.",
      requestId,
    }, 500);
  }
}
