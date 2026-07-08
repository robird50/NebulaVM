import { callAiTroubleshooter } from "../../server/aiTroubleshooter.js";

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Use POST for AI Troubleshooter requests." });
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const result = await callAiTroubleshooter(body);
    return json(result.status || (result.ok ? 200 : 500), result);
  } catch (error) {
    return json(400, { ok: false, error: error.message || "AI Troubleshooter failed." });
  }
};
