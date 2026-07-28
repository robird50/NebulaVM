import assert from "node:assert/strict";
import test from "node:test";
import {
  BUG_TYPES,
  buildProblemReportEmail,
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
