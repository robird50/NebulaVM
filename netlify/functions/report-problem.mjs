import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";
import { buildProblemReportEmail, validateProblemReport } from "../../lib/problemReport.mjs";

const STORE_NAME = "nebulavm-problem-report-limits";
const MAX_REPORTS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

const json = (status, payload) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });

const clientIp = (request, context) =>
  String(
    context?.ip ||
      request.headers.get("x-nf-client-connection-ip") ||
      request.headers.get("x-forwarded-for") ||
      "unknown",
  )
    .split(",")[0]
    .trim();

const rateLimitKey = (request, context) =>
  `ip-${createHash("sha256").update(clientIp(request, context)).digest("hex")}`;

const checkRateLimit = async (store, key) => {
  const now = Date.now();
  const saved = (await store.get(key, { type: "json" }).catch(() => null)) || {
    startedAt: now,
    count: 0,
  };
  const current = now - Number(saved.startedAt || 0) < HOUR_MS
    ? saved
    : { startedAt: now, count: 0 };
  if (Number(current.count || 0) >= MAX_REPORTS_PER_HOUR) {
    const error = new Error("Too many reports were sent. Please try again later.");
    error.statusCode = 429;
    throw error;
  }
  return current;
};

export default async (request, context = {}) => {
  if (request.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: "Cross-origin reports are not allowed." });
  }

  try {
    const gmailUser = String(process.env.NEBULAVM_REPORT_GMAIL_USER || "").trim();
    const gmailAppPassword = String(process.env.NEBULAVM_REPORT_GMAIL_APP_PASSWORD || "")
      .replace(/\s+/g, "");
    const destination = String(
      process.env.NEBULAVM_REPORT_TO || "nebulavmsupport@gmail.com",
    ).trim();
    if (!gmailUser || !gmailAppPassword) {
      const error = new Error("Problem reporting is not configured yet.");
      error.statusCode = 503;
      throw error;
    }

    const report = validateProblemReport(await request.json());
    const store = getStore(STORE_NAME);
    const key = rateLimitKey(request, context);
    const limit = await checkRateLimit(store, key);
    const message = buildProblemReportEmail(report);
    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
    });
    await transport.sendMail({
      from: `"NebulaVM Problem Reports" <${gmailUser}>`,
      to: destination,
      replyTo: report.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    await store.setJSON(key, {
      startedAt: limit.startedAt,
      count: Number(limit.count || 0) + 1,
    });
    return json(200, { ok: true, message: "Your report was sent. Thank you." });
  } catch (error) {
    return json(Number(error.statusCode) || 500, {
      ok: false,
      error: error.statusCode
        ? error.message
        : "The report could not be sent. Please try again later.",
    });
  }
};
