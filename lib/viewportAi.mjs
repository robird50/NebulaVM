const DEFAULT_MODEL = "gpt-5.6-luna";
const MAX_IMAGE_LENGTH = 700_000;
const MAX_CONTEXT_LENGTH = 1_500;
const MAX_HISTORY_ITEMS = 5;

const extractOutputText = (payload) => {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join(" ");
};

const cleanSummary = (value) => {
  const words = String(value || "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length < 5) return "";
  return words.slice(0, 10).join(" ").replace(/[.,;:!?]+$/g, "");
};

const normalizedHistory = (history) =>
  (Array.isArray(history) ? history : [])
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-MAX_HISTORY_ITEMS);

export const analyzeViewport = async ({
  apiKey,
  body = {},
  model = DEFAULT_MODEL,
  fetchImpl = fetch,
}) => {
  const key = String(apiKey || "").trim();
  if (!key) {
    const error = new Error("AI screen analysis is not configured on the backend.");
    error.statusCode = 503;
    throw error;
  }

  const image = String(body.image || "");
  if (
    !/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=\r\n]+$/i.test(image) ||
    image.length > MAX_IMAGE_LENGTH
  ) {
    const error = new Error("A valid viewport image is required.");
    error.statusCode = 400;
    throw error;
  }

  const history = normalizedHistory(body.previous);
  const context = String(body.context || "").replace(/\s+/g, " ").trim().slice(0, MAX_CONTEXT_LENGTH);
  const previousText = history.length ? history.map((item) => `- ${item}`).join("\n") : "- None";
  const instructions = [
    "Inspect the supplied virtual-machine screenshot itself.",
    "Return one concrete 5-10 word status phrase and nothing else.",
    "Name the visible app, dialog, boot stage, error, progress, or home screen when identifiable.",
    "Never claim something that is not visibly supported.",
    "Avoid generic phrases such as display active, screen visible, VM running, or please wait.",
    "Do not repeat a previous phrase unless the visible state truly has not changed.",
    `Interface context: ${context || "No extra interface context."}`,
    `Recent phrases to avoid repeating:\n${previousText}`,
  ].join("\n");

  const response = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: String(model || DEFAULT_MODEL),
      store: false,
      reasoning: { effort: "none" },
      max_output_tokens: 40,
      text: { verbosity: "low" },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: instructions },
            { type: "input_image", image_url: image, detail: "low" },
          ],
        },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      response.status === 429
        ? "AI screen analysis is busy. It will retry shortly."
        : "AI screen analysis is temporarily unavailable.",
    );
    error.statusCode = response.status === 429 ? 429 : 502;
    throw error;
  }

  const summary = cleanSummary(extractOutputText(payload));
  if (!summary) {
    const error = new Error("AI screen analysis returned an unusable description.");
    error.statusCode = 502;
    throw error;
  }

  const normalized = summary.toLowerCase();
  const repeated = history.some((item) => item.toLowerCase() === normalized);
  return { summary, repeated, model: String(model || DEFAULT_MODEL) };
};

