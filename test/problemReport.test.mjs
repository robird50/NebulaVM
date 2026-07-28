import assert from "node:assert/strict";
import test from "node:test";
import {
  BUG_TYPES,
  PROFANITY_WORDS,
  buildProblemReportEmail,
  buildProfanityModerationEmail,
  containsProfanity,
  containsStrongProfanity,
  nextProfanityConsequence,
  redactStrongProfanity,
  validateProblemReport,
} from "../lib/problemReport.mjs";

test("accepts a complete problem report", () => {
  const report = validateProblemReport({
    bugType: BUG_TYPES[0],
    description: "Windows setup remains on a black screen after booting.",
    email: "person@example.com",
    page: "https://nebulavm.online/",
    commit: "abcdef0",
  });

  assert.equal(report.bugType, BUG_TYPES[0]);
  assert.equal(report.email, "person@example.com");
});

test("detects listed profanity as whole words", () => {
  for (const word of PROFANITY_WORDS) {
    assert.equal(containsProfanity(`The report contains ${word}.`), true, word);
  }
  assert.equal(containsProfanity("This fucking screen is stuck."), true);
  assert.equal(containsProfanity("WTF happened to the viewport?"), true);
  assert.equal(containsProfanity("The class assignment will not boot."), false);
  assert.equal(containsProfanity("Please assist with this display issue."), false);
  assert.equal(containsProfanity("Hello, the emulator is still loading."), false);
});

test("allows mild frustration and redacts stronger language", () => {
  assert.equal(containsProfanity("The damn emulator is stuck."), true);
  assert.equal(containsStrongProfanity("The damn emulator is stuck."), false);
  assert.equal(containsStrongProfanity("The fucking emulator is stuck."), true);
  assert.equal(
    redactStrongProfanity("The fucking emulator is still shit."),
    "The [redacted] emulator is still [redacted].",
  );
});

test("uses progressive profanity cooldowns within 24 hours", () => {
  const now = Date.now();
  const first = nextProfanityConsequence({}, now);
  const second = nextProfanityConsequence(
    {
      profanityStrikeStartedAt: first.strikeStartedAt,
      profanityStrikes: first.strikes,
    },
    now + 1000,
  );
  const third = nextProfanityConsequence(
    {
      profanityStrikeStartedAt: second.strikeStartedAt,
      profanityStrikes: second.strikes,
    },
    now + 2000,
  );

  assert.equal(first.cooldownMinutes, 0);
  assert.equal(second.cooldownMinutes, 5);
  assert.equal(third.cooldownMinutes, 20);
  assert.equal(
    nextProfanityConsequence(
      { profanityStrikeStartedAt: now, profanityStrikes: 3 },
      now + 25 * 60 * 60 * 1000,
    ).cooldownMinutes,
    0,
  );
});

test("builds the automated moderation email", () => {
  const message = buildProfanityModerationEmail({ cooldownMinutes: 5 });

  assert.match(message.subject, /moderation notice/i);
  assert.match(message.text, /contained profanity and inappropriate language/);
  assert.match(message.text, /suspended for 5 minutes/);
  assert.match(message.text, /Do not reply/);
  assert.match(message.html, /NebulaVM Automated Moderation/);
});

test("rejects invalid and suspicious submissions", () => {
  assert.throws(
    () =>
      validateProblemReport({
        bugType: "Invented category",
        description: "This description is definitely long enough to submit.",
        email: "person@example.com",
      }),
    /valid bug type/,
  );
  assert.throws(
    () =>
      validateProblemReport({
        bugType: BUG_TYPES[0],
        description: "Too short",
        email: "person@example.com",
      }),
    /20/,
  );
  assert.throws(
    () =>
      validateProblemReport({
        bugType: BUG_TYPES[0],
        description: "This description is definitely long enough to submit.",
        email: "person@example.com",
        website: "bot-filled-field",
      }),
    /could not be accepted/,
  );
});

test("builds a themed email and escapes user content", () => {
  const report = validateProblemReport({
    bugType: "Other",
    description: "The viewport shows <script>alert('no')</script> after boot.",
    email: "person@example.com",
  });
  const message = buildProblemReportEmail(report);

  assert.match(message.subject, /NebulaVM bug/);
  assert.match(message.html, /#ff4d57/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /&lt;script&gt;/);
});
