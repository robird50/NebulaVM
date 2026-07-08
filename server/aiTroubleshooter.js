const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.5";

const SYSTEM_PROMPT = `
You are AI Troubleshooter inside NebulaVM, a browser-based virtual machine platform.
Help users debug VM, emulator, ISO, QEMU, Netlify, local bridge, Windows, Ubuntu, boot order, and install errors.
Use the provided app context, activity logs, user message, and optional screenshot.
Be practical and specific. Prefer short numbered steps. Do not invent files or commands.
If a secret/API key issue appears, remind the user not to paste keys into chat or browser code.
`.trim();

const sanitizeText = (value, maxLength = 6000) => String(value || "").trim().slice(0, maxLength);

const isImageDataUrl = (value) => /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(String(value || ""));

const extractOutputText = (data) => {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
      if (typeof content.output_text === "string") parts.push(content.output_text);
    }
  }

  return parts.join("\n").trim();
};

const buildUserText = ({ message, imageSummary, context }) => {
  const safeContext = context || {};
  return [
    `User problem: ${sanitizeText(message) || "The user attached a screenshot and wants troubleshooting."}`,
    imageSummary ? `Local screenshot summary: ${sanitizeText(imageSummary, 1000)}` : "",
    "",
    "NebulaVM context:",
    `- Emulator: ${sanitizeText(safeContext.emulator, 200)}`,
    `- Processor: ${sanitizeText(safeContext.processor, 200)}`,
    `- Boot order: ${sanitizeText(safeContext.bootOrder, 200)}`,
    `- Memory: ${sanitizeText(safeContext.memory, 200)}`,
    `- ISO path: ${sanitizeText(safeContext.isoPath, 500)}`,
    `- Native status: ${sanitizeText(safeContext.nativeStatus, 500)}`,
    `- Viewport summary: ${sanitizeText(safeContext.viewport, 300)}`,
    "",
    "Recent Activity log:",
    sanitizeText(safeContext.activity, 2500) || "No recent activity log lines.",
  ]
    .filter(Boolean)
    .join("\n");
};

export const callAiTroubleshooter = async (body, env = process.env) => {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "OPENAI_API_KEY is not configured on the backend.",
    };
  }

  const model = env.OPENAI_MODEL || DEFAULT_MODEL;
  const content = [
    {
      type: "input_text",
      text: buildUserText(body || {}),
    },
  ];

  if (isImageDataUrl(body?.imageDataUrl)) {
    content.push({
      type: "input_image",
      image_url: body.imageDataUrl,
    });
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: SYSTEM_PROMPT,
      input: [
        {
          role: "user",
          content,
        },
      ],
      reasoning: {
        effort: "low",
      },
      text: {
        verbosity: "low",
      },
      max_output_tokens: 900,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data?.error?.message || `OpenAI request failed with status ${response.status}.`,
    };
  }

  return {
    ok: true,
    status: 200,
    model,
    text: extractOutputText(data) || "I could not read a useful response from the AI service.",
  };
};
