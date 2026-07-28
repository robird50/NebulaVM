export const BUG_TYPES = [
  "Startup or boot problem",
  "ISO upload or staging",
  "VM display or controls",
  "Slow or unresponsive emulator",
  "Android emulator",
  "EMUSTAR or Hyper-V",
  "QEMU emulator",
  "Mobile or tablet",
  "Stored images",
  "Other",
];

export const PROFANITY_WORDS = Object.freeze([
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "crap",
  "damn",
  "dammit",
  "dick",
  "douche",
  "douchebag",
  "dumbass",
  "freaking",
  "frick",
  "fuck",
  "fucker",
  "fucking",
  "hell",
  "jackass",
  "jerk",
  "piss",
  "pissed",
  "prick",
  "shit",
  "shitty",
  "slut",
  "suck",
  "sucks",
  "whore",
  "wtf",
  "stfu",
  "fml",
]);

export const STRONG_PROFANITY_WORDS = Object.freeze([
  "ass",
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "dick",
  "douche",
  "douchebag",
  "dumbass",
  "fuck",
  "fucker",
  "fucking",
  "jackass",
  "prick",
  "shit",
  "shitty",
  "slut",
  "whore",
  "wtf",
  "stfu",
  "fml",
]);

export const PROFANITY_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;

const cleanText = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const profanityPattern = new RegExp(`\\b(?:${PROFANITY_WORDS.join("|")})\\b`, "i");
const strongProfanityPattern = new RegExp(
  `\\b(?:${STRONG_PROFANITY_WORDS.join("|")})\\b`,
  "i",
);
const strongProfanityRedactionPattern = new RegExp(
  `\\b(?:${STRONG_PROFANITY_WORDS.join("|")})\\b`,
  "gi",
);

export const containsProfanity = (value) => profanityPattern.test(cleanText(value));
export const containsStrongProfanity = (value) =>
  strongProfanityPattern.test(cleanText(value));
export const redactStrongProfanity = (value) =>
  cleanText(value).replace(strongProfanityRedactionPattern, "[redacted]");

export const nextProfanityConsequence = (record = {}, now = Date.now()) => {
  const previousStartedAt = Number(record.profanityStrikeStartedAt || 0);
  const previousStrikes =
    now - previousStartedAt < PROFANITY_STRIKE_WINDOW_MS
      ? Number(record.profanityStrikes || 0)
      : 0;
  const strikes = previousStrikes + 1;
  return {
    strikes,
    strikeStartedAt: previousStrikes ? previousStartedAt : now,
    cooldownMinutes: strikes === 1 ? 0 : strikes === 2 ? 5 : 20,
  };
};

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const validateProblemReport = (body = {}) => {
  if (cleanText(body.website)) {
    const error = new Error("This report could not be accepted.");
    error.statusCode = 400;
    throw error;
  }

  const bugType = cleanText(body.bugType);
  const description = cleanText(body.description);
  const email = cleanText(body.email).toLowerCase();
  if (!BUG_TYPES.includes(bugType)) {
    const error = new Error("Choose a valid bug type.");
    error.statusCode = 400;
    throw error;
  }
  if (description.length < 20 || description.length > 5000) {
    const error = new Error("The description must contain 20–5000 characters.");
    error.statusCode = 400;
    throw error;
  }
  if (email.length > 254 || !emailPattern.test(email)) {
    const error = new Error("Enter a valid email address.");
    error.statusCode = 400;
    throw error;
  }

  return {
    bugType,
    description,
    email,
    page: cleanText(body.page).slice(0, 500),
    commit: cleanText(body.commit).slice(0, 40),
    userAgent: cleanText(body.userAgent).slice(0, 500),
    submittedAt: new Date().toISOString(),
  };
};

export const buildProblemReportEmail = (report) => {
  const safeType = escapeHtml(report.bugType);
  const safeEmail = escapeHtml(report.email);
  const safeDescription = escapeHtml(report.description).replaceAll("\n", "<br />");
  const safePage = escapeHtml(report.page || "Not supplied");
  const safeCommit = escapeHtml(report.commit || "Unknown");
  const safeAgent = escapeHtml(report.userAgent || "Not supplied");
  const safeTime = escapeHtml(report.submittedAt);

  return {
    subject: `[NebulaVM bug] ${report.bugType}`,
    text: [
      "NEBULAVM PROBLEM REPORT",
      "",
      `Bug type: ${report.bugType}`,
      `Reply email: ${report.email}`,
      `Submitted: ${report.submittedAt}`,
      `Commit: ${report.commit || "Unknown"}`,
      `Page: ${report.page || "Not supplied"}`,
      "",
      report.description,
      "",
      `Browser: ${report.userAgent || "Not supplied"}`,
    ].join("\n"),
    html: `<!doctype html>
      <html lang="en">
        <body style="margin:0;background:#080d12;color:#eaf7ff;font-family:Arial,sans-serif">
          <div style="padding:32px 14px">
            <div style="max-width:680px;margin:0 auto;border:1px solid #24647a;border-top:4px solid #ff4d57;background:#0d1620">
              <header style="padding:24px;border-bottom:1px solid #203847;background:#0a1119">
                <div style="color:#63dcff;font-size:12px;font-weight:800;letter-spacing:1.4px">NEBULAVM</div>
                <h1 style="margin:7px 0 0;color:#ff5c65;font-size:26px">Problem report received</h1>
              </header>
              <main style="padding:24px">
                <div style="display:inline-block;padding:7px 10px;border:1px solid #7d6d19;background:#221f0d;color:#ffe45e;font-weight:700">${safeType}</div>
                <h2 style="margin:24px 0 8px;color:#f8fbff;font-size:17px">What happened</h2>
                <div style="padding:16px;border-left:3px solid #63dcff;background:#101e29;color:#dcecf5;line-height:1.65">${safeDescription}</div>
                <table role="presentation" style="width:100%;margin-top:22px;border-collapse:collapse;color:#b9c9d5;font-size:13px">
                  <tr><td style="padding:8px;border-bottom:1px solid #20313d;font-weight:700">Reply email</td><td style="padding:8px;border-bottom:1px solid #20313d"><a style="color:#63dcff" href="mailto:${safeEmail}">${safeEmail}</a></td></tr>
                  <tr><td style="padding:8px;border-bottom:1px solid #20313d;font-weight:700">Commit</td><td style="padding:8px;border-bottom:1px solid #20313d">${safeCommit}</td></tr>
                  <tr><td style="padding:8px;border-bottom:1px solid #20313d;font-weight:700">Page</td><td style="padding:8px;border-bottom:1px solid #20313d">${safePage}</td></tr>
                  <tr><td style="padding:8px;border-bottom:1px solid #20313d;font-weight:700">Submitted</td><td style="padding:8px;border-bottom:1px solid #20313d">${safeTime}</td></tr>
                </table>
                <p style="margin:22px 0 6px;color:#7f95a5;font-size:12px">Browser details</p>
                <p style="margin:0;color:#92a7b5;font-size:12px;line-height:1.5">${safeAgent}</p>
              </main>
              <footer style="padding:16px 24px;border-top:1px solid #203847;color:#6f8493;font-size:11px">RoBird Studios 2026</footer>
            </div>
          </div>
        </body>
      </html>`,
  };
};

export const buildProfanityModerationEmail = ({ cooldownMinutes = 20 } = {}) => ({
  subject: "[NebulaVM] Report moderation notice",
  text: [
    "Hello,",
    "",
    "The report you submitted to NebulaVM contained profanity and inappropriate language.",
    "",
    "Reports are intended to help us identify bugs, abuse, and technical issues. Using offensive language makes reports harder to review and may result in future submissions being ignored or restricted.",
    "",
    "Please resubmit your report using clear, respectful language and include only information relevant to the issue.",
    "",
    `Your reporting privileges have been suspended for ${cooldownMinutes} minutes.`,
    "",
    "This is an automated message. Do not reply to this email.",
    "",
    "\u2014 NebulaVM Automated Moderation",
  ].join("\n"),
  html: `<!doctype html>
    <html lang="en">
      <body style="margin:0;background:#080d12;color:#eaf7ff;font-family:Arial,sans-serif">
        <div style="padding:32px 14px">
          <div style="max-width:680px;margin:0 auto;border:1px solid #24647a;border-top:4px solid #ff4d57;background:#0d1620">
            <header style="padding:24px;border-bottom:1px solid #203847;background:#0a1119">
              <div style="color:#63dcff;font-size:12px;font-weight:800;letter-spacing:1.4px">NEBULAVM</div>
              <h1 style="margin:7px 0 0;color:#ff5c65;font-size:26px">Automated moderation</h1>
            </header>
            <main style="padding:24px;color:#dcecf5;font-size:15px;line-height:1.65">
              <p style="margin-top:0">Hello,</p>
              <p>The report you submitted to NebulaVM contained profanity and inappropriate language.</p>
              <p>Reports are intended to help us identify bugs, abuse, and technical issues. Using offensive language makes reports harder to review and may result in future submissions being ignored or restricted.</p>
              <p>Please resubmit your report using clear, respectful language and include only information relevant to the issue.</p>
              <p style="padding:12px;border-left:3px solid #ff4d57;background:#221317;color:#ff9ba1"><strong>Your reporting privileges have been suspended for ${cooldownMinutes} minutes.</strong></p>
              <p style="margin-bottom:0;color:#92a7b5">This is an automated message. Do not reply to this email.</p>
            </main>
            <footer style="padding:16px 24px;border-top:1px solid #203847;color:#63dcff;font-size:12px">&mdash; NebulaVM Automated Moderation</footer>
          </div>
        </div>
      </body>
    </html>`,
});
