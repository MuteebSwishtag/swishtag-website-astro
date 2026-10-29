import { searchCities } from "../../../lib/server/locations.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export function GET({ url }) {
  const result = searchCities({
    country: url.searchParams.get("country") || "",
    query: url.searchParams.get("q") || "",
    limit: url.searchParams.get("limit") || 40,
  });

  return json(result, result.ok ? 200 : 422);
}
