import assert from "node:assert/strict";
import test from "node:test";
import { buildCommitHistory } from "../lib/commitHistory.mjs";

const commit = (sha, message, date) => ({
  sha,
  commit: {
    message,
    author: { date },
  },
});

test("maps commits to immutable Netlify deploy permalinks", () => {
  const firstSha = "a".repeat(40);
  const secondSha = "b".repeat(40);
  const history = buildCommitHistory(
    [
      commit(firstSha, "Newest working commit\n\nDetails", "2026-07-28T00:00:00Z"),
      commit(secondSha, "Older commit", "2026-07-27T00:00:00Z"),
    ],
    [
      {
        id: "1234567890abcdef12345678",
        state: "ready",
        commit_ref: firstSha,
      },
      {
        id: "abcdef1234567890abcdef12",
        state: "ready",
        commit_ref: secondSha,
      },
    ],
  );

  assert.equal(history.length, 2);
  assert.equal(history[0].message, "Newest working commit");
  assert.equal(history[0].latestWorking, true);
  assert.equal(
    history[1].deployUrl,
    "https://abcdef1234567890abcdef12--nebulavm.netlify.app/",
  );
});

test("lists commits without a successful deploy as unavailable", () => {
  const sha = "c".repeat(40);
  const history = buildCommitHistory(
    [commit(sha, "Never deployed", "2026-07-26T00:00:00Z")],
    [{ id: "not-safe", state: "ready", commit_ref: sha }],
  );

  assert.equal(history[0].available, false);
  assert.equal(history[0].deployUrl, null);
  assert.equal(history[0].latestWorking, undefined);
});

