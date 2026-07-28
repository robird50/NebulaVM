import { getCommitHistory } from "../../lib/commitHistory.mjs";

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control":
        "public, durable, s-maxage=300, stale-while-revalidate=86400",
    },
  });

export default async (request) => {
  if (request.method !== "GET") {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  try {
    const commits = await getCommitHistory();
    return json(200, {
      ok: true,
      commits,
      total: commits.length,
      generatedAt: new Date().toISOString(),
    });
  } catch {
    return json(502, {
      ok: false,
      error: "Commit history could not be loaded. Please try again.",
    });
  }
};

