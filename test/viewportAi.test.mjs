import assert from "node:assert/strict";
import test from "node:test";
import { analyzeViewport } from "../lib/viewportAi.mjs";

const image = `data:image/jpeg;base64,${Buffer.from("viewport").toString("base64")}`;

test("requires a backend API key", async () => {
  await assert.rejects(
    analyzeViewport({ apiKey: "", body: { image } }),
    /not configured/,
  );
});

test("returns a concise viewport description", async () => {
  let requestBody;
  const result = await analyzeViewport({
    apiKey: "test-key",
    body: { image, context: "Android 16 device", previous: [] },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: "Android Settings splash screen is still loading",
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  assert.equal(result.summary, "Android Settings splash screen is still loading");
  assert.equal(result.repeated, false);
  assert.equal(requestBody.model, "gpt-5.6-luna");
  assert.equal(requestBody.input[0].content[1].type, "input_image");
});

test("marks an unchanged description as repeated", async () => {
  const summary = "Windows installer is copying files now";
  const result = await analyzeViewport({
    apiKey: "test-key",
    body: { image, previous: [summary] },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          output: [{ content: [{ type: "output_text", text: summary }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });

  assert.equal(result.repeated, true);
});
