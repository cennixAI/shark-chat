import Anthropic from "@anthropic-ai/sdk";

export interface Message {
  role: "user" | "assistant";
  text: string;
  /** File names attached to a user message. */
  attachments?: string[];
  /** Text of attached files, sent to the model along with the message. */
  files?: { name: string; text: string }[];
}

export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "Most capable for coding" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "Fast and capable" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "Quickest, lightest" },
  { id: "claude-fable-5-1", label: "Fable 5.1", note: "Deepest reasoning, slowest" },
] as const;

export type Effort = "low" | "medium" | "high";

export interface ModelSettings {
  apiKey: string;
  model: string;
  effort: Effort;
  system: string;
}

export const DEFAULT_SYSTEM =
  "You are a calm, unhurried coding companion. Answer clearly and concisely, " +
  "favour the simplest approach that works, and keep a gentle, steady tone.";

const SETTINGS_KEY = "shark-chat.model";

export function loadSettings(): ModelSettings {
  const settings: ModelSettings = { apiKey: "", model: MODELS[0].id, effort: "medium", system: DEFAULT_SYSTEM };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    if (typeof saved.apiKey === "string") settings.apiKey = saved.apiKey;
    if (MODELS.some((m) => m.id === saved.model)) settings.model = saved.model;
    if (["low", "medium", "high"].includes(saved.effort)) settings.effort = saved.effort;
    if (typeof saved.system === "string") settings.system = saved.system;
  } catch {
    // Unreadable settings: start from the defaults.
  }
  return settings;
}

export function saveSettings(settings: ModelSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Unsaved: the settings still apply for this visit.
  }
}

const PLACEHOLDER =
  "No model is connected yet, so this is a placeholder reply. " +
  "Add your Anthropic API key from the model button in the composer to get real answers.";

/**
 * Stream a reply: yields text as it arrives, and the thread renders each chunk.
 * `history` is the whole conversation so far, ending with the newest user message.
 */
export async function* respond(history: Message[], settings: ModelSettings, signal: AbortSignal): AsyncGenerator<string> {
  if (!settings.apiKey) {
    yield* placeholder(signal);
    return;
  }

  // The key lives in this browser and goes straight to Anthropic; there's no server in between.
  const client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  const messages: Anthropic.Beta.BetaMessageParam[] = history.map((m) => ({
    role: m.role,
    content: m.role === "user" ? withFiles(m) : m.text,
  }));

  const stream = client.beta.messages.stream(
    {
      model: settings.model,
      max_tokens: 64000,
      system: settings.system || undefined,
      messages,
      output_config: { effort: settings.effort },
      // If a safety classifier declines, retry on Anthropic's recommended model for that kind of
      // request instead of stopping. Haiku has no server-side fallback, so it goes without.
      ...(settings.model === "claude-haiku-5-5"
        ? {}
        : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    },
    { signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "fallback") {
      // A mid-reply handover keeps what came before; set the rest apart.
      yield "\n\n";
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") yield "\n\n(The model declined to answer this one.)";
  else if (final.stop_reason === "max_tokens") yield "\n\n(The reply hit its length limit.)";
}

/** A user message with any attached files' text set out ahead of it. */
function withFiles(m: Message): string {
  if (!m.files?.length) return m.text;
  const files = m.files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`).join("\n\n");
  return m.text ? `${files}\n\n${m.text}` : files;
}

/** Explain an API failure in a sentence the thread can show. */
export function describeError(err: unknown) {
  if (err instanceof Anthropic.AuthenticationError) return "That API key wasn't accepted. Check it in the model settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This key doesn't have access to that model.";
  if (err instanceof Anthropic.NotFoundError) return "That model isn't available to this key.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited for a moment. Try again shortly.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection.";
  if (err instanceof Anthropic.APIError) return `The API returned an error (${err.status}): ${err.message}`;
  return "Something went wrong. Try again.";
}

async function* placeholder(signal: AbortSignal) {
  // About as long as a real model takes to start answering, so the scene gets to react.
  await sleep(2000, signal);
  for (const word of PLACEHOLDER.split(/(?<= )/)) {
    await sleep(28 + Math.random() * 40, signal);
    yield word;
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Whether a failure was just the reply being stopped. */
export function isAbort(err: unknown) {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof DOMException && err.name === "AbortError");
}
