import { isAdminAuthenticated } from "../../../lib/server/admin-auth.js";
import {
  formTypes,
  getSubmissionCollection,
  serializeSubmission,
} from "../../../lib/server/form-submissions.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function GET({ request, cookies }) {
  if (!isAdminAuthenticated(cookies)) {
    return json({ ok: false, message: "Unauthorized." }, 401);
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "";
  const query = {};

  if ([formTypes.bookDemo, formTypes.discussIdea, formTypes.contact].includes(type)) {
    query.formType = type;
  }

  try {
    const collection = await getSubmissionCollection();
    const total = await collection.countDocuments(query);
    const submissions = await collection
      .find(query)
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray();

    return json({
      ok: true,
      total,
      submissions: submissions.map(serializeSubmission),
    });
  } catch (error) {
    console.error("Swishtag admin submissions error:", error);
    return json({
      ok: false,
      message: "Could not load submissions.",
    }, 500);
  }
}
