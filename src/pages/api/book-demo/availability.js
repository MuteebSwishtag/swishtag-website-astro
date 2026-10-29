import { BOOK_DEMO_DURATION_MINUTES } from "../../../lib/meeting-slots.js";
import { listBusyRanges } from "../../../lib/server/meeting-availability.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET() {
  try {
    const busy = await listBusyRanges();
    return json({
      ok: true,
      durationMinutes: BOOK_DEMO_DURATION_MINUTES,
      busy,
    });
  } catch (error) {
    console.error("[Swishtag book-demo] availability failed", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });

    return json({
      ok: true,
      busy: [],
      degraded: true,
    });
  }
}
