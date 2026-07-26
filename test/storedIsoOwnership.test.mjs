import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStoredIsoOwnerId, storedIsosForOwner } from "../lib/storedIsoOwnership.mjs";

test("accepts only durable opaque stored ISO owner identifiers", () => {
  assert.equal(normalizeStoredIsoOwnerId("device-1234567890abcdef"), "device-1234567890abcdef");
  assert.equal(normalizeStoredIsoOwnerId("short"), "");
  assert.equal(normalizeStoredIsoOwnerId("../another-device"), "");
});

test("stored ISO listings include only the requesting device", () => {
  const firstDevice = "device-1111111111111111";
  const secondDevice = "device-2222222222222222";
  const items = [
    { id: "one", ownerId: firstDevice },
    { id: "two", ownerId: secondDevice },
    { id: "legacy" },
  ];

  assert.deepEqual(storedIsosForOwner(items, firstDevice).map((item) => item.id), ["one"]);
  assert.deepEqual(storedIsosForOwner(items, secondDevice).map((item) => item.id), ["two"]);
  assert.deepEqual(storedIsosForOwner(items, "invalid"), []);
});
