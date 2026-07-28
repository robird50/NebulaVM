import { createHash } from "node:crypto";
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";
import {
  buildProblemReportEmail,
  buildProfanityModerationEmail,
  containsProfanity,
  validateProblemReport,
} from "../../lib/problemReport.mjs";

const STORE_NAME = "nebulavm-problem-report-limits";
const MAX_REPORTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const PROFANITY_LOCK_MS = 20 * 60 * 1000;
const PROFANITY_LOCK_REASON = "profane language";

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

const readRateLimit = async (store, key) => {
  const now = Date.now();
  const saved = (await store.get(key, { type: "json" }).catch(() => null)) || {
    startedAt: now,
    count: 0,
  };
  return now - Number(saved.startedAt || 0) < HOUR_MS
    ? saved
    : { startedAt: now, count: 0 };
};

const checkRateLimit = async (store, key) => {
  const now = Date.now();
  const current = await readRateLimit(store, key);
  if (Number(current.lockedUntil || 0) > now) {
    const error = new Error("Can't report now. Reason: profane language.");
    error.statusCode = 429;
    error.lockoutUntil = new Date(Number(current.lockedUntil)).toISOString();
    error.lockReason = PROFANITY_LOCK_REASON;
    throw error;
  }
  if (Number(current.count || 0) >= MAX_REPORTS_PER_HOUR) {
    const error = new Error("Too many reports were sent. Please try again later.");
    error.statusCode = 429;
    throw error;
  }
  return current;
};

export default async (request, context = {}) => {
  if (!["GET", "POST"].includes(request.method)) {
    return json(405, { ok: false, error: "Method not allowed." });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json(403, { ok: false, error: "Cross-origin reports are not allowed." });
  }

  let moderationLockoutUntil = null;
  try {
    const store = getStore(STORE_NAME);
    const key = rateLimitKey(request, context);
    if (request.method === "GET") {
      const limit = await readRateLimit(store, key);
      const lockoutUntil = Number(limit.lockedUntil || 0);
      const locked = lockoutUntil > Date.now();
      return json(200, {
        ok: true,
        canReport: !locked,
        lockoutUntil: locked ? new Date(lockoutUntil).toISOString() : null,
        reason: locked ? PROFANITY_LOCK_REASON : null,
      });
    }

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
    const limit = await checkRateLimit(store, key);
    const moderated = containsProfanity(report.description);
    const message = moderated
      ? buildProfanityModerationEmail()
      : buildProblemReportEmail(report);
    const transport = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
    });
    if (moderated) {
      moderationLockoutUntil = new Date(Date.now() + PROFANITY_LOCK_MS).toISOString();
      await store.setJSON(key, {
        startedAt: limit.startedAt,
        count: Number(limit.count || 0) + 1,
        lockedUntil: Date.parse(moderationLockoutUntil),
        lockReason: PROFANITY_LOCK_REASON,
      });
    }
    await transport.sendMail({
      from: `"NebulaVM Problem Reports" <${gmailUser}>`,
      to: moderated ? report.email : destination,
      ...(moderated ? {} : { replyTo: report.email }),
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    if (!moderated) {
      await store.setJSON(key, {
        startedAt: limit.startedAt,
        count: Number(limit.count || 0) + 1,
      });
    }
    return json(200, {
      ok: true,
      moderated,
      canReport: !moderated,
      lockoutUntil: moderationLockoutUntil,
      reason: moderated ? PROFANITY_LOCK_REASON : null,
      message: moderated
        ? "Your report was not submitted because it contained inappropriate language. Check your email."
        : "Your report was sent. Thank you.",
    });
  } catch (error) {
    console.error("NebulaVM problem report delivery failed.", {
      code: error?.code || null,
      command: error?.command || null,
      responseCode: error?.responseCode || null,
      message: error?.message || String(error),
    });
    const gmailAuthenticationFailed =
      error?.code === "EAUTH" || Number(error?.responseCode) === 535;
    const lockoutUntil = error?.lockoutUntil || moderationLockoutUntil;
    return json(Number(error.statusCode) || 500, {
      ok: false,
      ...(lockoutUntil
        ? {
            canReport: false,
            lockoutUntil,
            reason: error?.lockReason || PROFANITY_LOCK_REASON,
          }
        : {}),
      error: error.statusCode
        ? error.message
        : gmailAuthenticationFailed
          ? "Gmail rejected the configured sender account or app password."
        : "The report could not be sent. Please try again later.",
    });
  }
};
