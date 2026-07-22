// "视觉反推" (visual reverse-engineering) — trimmed port of TVision's vision.ts.
// Sends an image to a vision-capable chat model on the same o1key gateway via
// the OpenAI-compatible /v1/chat/completions endpoint and returns a structured
// prompt. Server-only.

export const VISION_CHAT_ENDPOINT = "/v1/chat/completions";
export const VISION_MODELS = ["gemini-3.1-pro-preview"];

const VISION_TIMEOUT_MS = 180_000;

const SYSTEM_INSTRUCTION = `Analyze this image as a visual reverse-engineering expert. Extract ALL visually important information and output ONE JSON object (and nothing else) that would let a text-to-image model recreate this image as faithfully as possible.

Use this structure with concrete, specific English values (omit keys that do not apply):
{
  "scene": one-line summary of the image,
  "type": "photo / illustration / 3D render / product shot / ...",
  "main_subject": { identity, clothing, materials, colors, pose, expression, position in frame },
  "secondary_elements": [ ... ],
  "composition": framing, crop, subject placement, negative space, perspective,
  "camera": { angle, shot type, focal length feel, depth of field, lens effects },
  "lighting": { setup, direction, quality, shadows, highlights },
  "color_palette": { dominant colors with approximate hex, accents, overall grade and white balance },
  "materials_textures": notable surface qualities,
  "background": full description,
  "style": aesthetic, era, genre, brand vibe,
  "text_elements": exact visible text with font style, color and placement (empty array if none),
  "mood": atmosphere keywords,
  "quality": resolution and finish descriptors
}

Rules: be exhaustive and precise — name colors with hex estimates, give counts and positions; describe only what is actually visible; write every value in English; output raw JSON only, no markdown fences, no commentary.`;

interface VisionChatBody {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  }>;
  response_format: { type: "json_object" };
  temperature: number;
  reasoning_effort?: "low" | "medium" | "high";
}

function buildVisionBody(imageDataUrl: string, model: string, withReasoning: boolean): VisionChatBody {
  const body: VisionChatBody = {
    model,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTION },
      {
        role: "user",
        content: [
          { type: "text", text: "Analyze this image and produce the JSON described in the system instructions." },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
  };
  if (withReasoning) body.reasoning_effort = "high";
  return body;
}

export class VisionError extends Error {
  detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "VisionError";
    this.detail = detail;
  }
}

async function callVisionOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  imageDataUrl: string,
  withReasoning: boolean,
): Promise<{ status: number; text: string }> {
  const url = `${baseUrl}${VISION_CHAT_ENDPOINT}`;
  const body = buildVisionBody(imageDataUrl, model, withReasoning);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function extractContent(text: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const content = (payload as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
  return typeof content === "string" && content ? content : null;
}

/** Tries VISION_MODELS in order; per model, first with reasoning_effort:"high",
 *  retrying once without it on HTTP 400 (some providers 400 on unknown params). */
export async function reverseEngineerPrompt(
  baseUrl: string,
  apiKey: string,
  imageDataUrl: string,
): Promise<{ content: string; model: string }> {
  let lastMsg = "";
  let lastDetail = "";

  for (const model of VISION_MODELS) {
    let attempt: { status: number; text: string };
    try {
      attempt = await callVisionOnce(baseUrl, apiKey, model, imageDataUrl, true);
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      lastMsg = aborted
        ? `视觉解析超时（超过 ${VISION_TIMEOUT_MS / 1000}s，模型 ${model}）`
        : `网络连接失败：${(e as Error)?.message || e}`;
      lastDetail = String((e as Error)?.stack || e);
      continue;
    }

    if (attempt.status === 400) {
      let retry: { status: number; text: string };
      try {
        retry = await callVisionOnce(baseUrl, apiKey, model, imageDataUrl, false);
      } catch (e) {
        lastMsg = `网络连接失败：${(e as Error)?.message || e}`;
        continue;
      }
      if (retry.status === 200) {
        const content = extractContent(retry.text);
        if (content) return { content, model };
      }
      lastMsg = `视觉解析请求失败 HTTP ${retry.status}（模型 ${model}）`;
      lastDetail = retry.text.slice(0, 2000);
      continue;
    }

    if (attempt.status !== 200) {
      lastMsg = `视觉解析请求失败 HTTP ${attempt.status}（模型 ${model}）`;
      lastDetail = attempt.text.slice(0, 2000);
      continue;
    }

    const content = extractContent(attempt.text);
    if (content) return { content, model };
    lastMsg = `视觉解析响应缺少内容（模型 ${model}）`;
    lastDetail = attempt.text.slice(0, 2000);
  }

  throw new VisionError(lastMsg || "视觉解析失败，所有模型均不可用", lastDetail);
}

/** Pretty-print JSON content; pass raw text through when not valid JSON. */
export function normalizeVisionPrompt(content: string): { text: string; parsed: boolean } {
  try {
    const parsed = JSON.parse(content);
    return { text: JSON.stringify(parsed, null, 2), parsed: true };
  } catch {
    return { text: content.trim(), parsed: false };
  }
}
