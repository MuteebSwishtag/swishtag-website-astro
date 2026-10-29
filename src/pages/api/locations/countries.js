import { listCountries, locationSource } from "../../../lib/server/locations.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export function GET() {
  return json({
    ok: true,
    source: locationSource,
    countries: listCountries(),
  });
}
