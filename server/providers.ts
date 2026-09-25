/**
 * All model calls go through here, on the server. Plain `fetch` to an
 * OpenAI-compatible /chat/completions — no SDK.
 *
 * Two rules this file exists to enforce:
 *   1. Capability detection, never assumptions. If the response does not carry
 *      usage.completion_tokens_details.reasoning_tokens, the answer is `null`
 *      (rendered "n/a"), never 0.
 *   2. reasoning_content (the hidden CoT) is stripped at the edge and never
 *      logged, stored, returned to the client, or persisted. Only its token
 *      COUNT ever leaves this function.
 */
import {
  EMPTY_CONTENT_RETRY_CAP,
  getPreset,
  shouldSendThinkingFlag,
  type SlotConfig,
} from '../shared/providers';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ChatOutcome {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  reasoningReported: boolean;
  latencyMs: number;
  finishReason: string | null;
  maxTokensUsed: number;
  retriedForEmptyContent: boolean;
  warnings: string[];
  /** sha256 of the exact prompt bytes we sent. Used for the prompt-reuse check. */
  promptHash: string;
  prompt: string;
}

export class ProviderError extends Error {
  detail?: string;
  hint?: string;
  status?: number;
  constructor(message: string, opts: { detail?: string; hint?: string; status?: number } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.detail = opts.detail;
    this.hint = opts.hint;
    this.status = opts.status;
  }
}

/** Fields that carry hidden chain-of-thought. Deleted before anything else looks at the message. */
const REASONING_KEYS = [
  'reasoning_content',
  'reasoning',
  'reasoning_details',
  'thinking',
  'chain_of_thought',
  'analysis',
  'thoughts',
];

function stripReasoning(message: Record<string, unknown>): string {
  // Read content first, then destroy the CoT fields. Nothing downstream can
  // accidentally see them because they no longer exist on this object.
  const raw = message.content;
  let content = '';
  if (typeof raw === 'string') {
    content = raw;
  } else if (Array.isArray(raw)) {
    content = raw
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  for (const key of REASONING_KEYS) delete message[key];
  return content;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads reasoning token count from usage. Present -> the number. Absent -> null,
 * which the UI renders as "n/a" and which hides the thinking toggle for that slot.
 */
function readReasoningTokens(usage: Record<string, unknown> | undefined): {
  tokens: number | null;
  reported: boolean;
} {
  if (!usage) return { tokens: null, reported: false };
  const details = usage.completion_tokens_details;
  if (details && typeof details === 'object') {
    const value = num((details as Record<string, unknown>).reasoning_tokens);
    if (value !== null) return { tokens: value, reported: true };
  }
  // Some OpenAI-compatible servers put it at the top level of usage instead.
  const flat = num(usage.reasoning_tokens);
  if (flat !== null) return { tokens: flat, reported: true };
  return { tokens: null, reported: false };
}

function truncate(text: string, max = 700): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function authHeaders(slot: SlotConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = slot.apiKey.trim();
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function unreachable(slot: SlotConfig, error: unknown): ProviderError {
  const preset = getPreset(slot.provider);
  const base = slot.baseUrl.replace(/\/+$/, '');
  // Local servers read better as their root: "Cannot reach http://127.0.0.1:11434
  // — is Ollama running?" The exact URL we tried is in `detail`.
  const display = preset.local ? base.replace(/\/v1$/, '') : base;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const real = cause?.message ?? (error as Error).message ?? String(error);
  const code = cause?.code ? ` (${cause.code})` : '';
  const hint = preset.local
    ? `Start ${preset.label}, then press Run again. No API key is needed for ${preset.label}.`
    : `Check the base URL for ${preset.label} and that this machine can reach it.`;
  return new ProviderError(`Cannot reach ${display} — is ${preset.label} running?`, {
    detail: `${real}${code} · tried ${joinUrl(base, '/chat/completions')}`,
    hint,
  });
}

async function readErrorBody(response: Response): Promise<{ message: string; detail: string }> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  let message = '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (parsed && typeof parsed.error === 'object' && parsed.error?.message) message = parsed.error.message;
    else if (parsed && typeof parsed.error === 'string') message = parsed.error;
    else if (parsed?.message) message = parsed.message;
  } catch {
    /* not JSON — use the raw text */
  }
  return { message: message || `HTTP ${response.status} ${response.statusText}`.trim(), detail: truncate(body) };
}

export interface CallOptions {
  slot: SlotConfig;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  disableReasoning: boolean;
  label: string;
  timeoutMs?: number;
}

/**
 * One chat completion with capability handling, empty-content retry, and CoT
 * stripping. Retries once with a doubled budget on HTTP 200 + empty content:
 * that is the hidden CoT eating the budget, not a refusal.
 */
export async function callChat(options: CallOptions): Promise<ChatOutcome> {
  const { slot, messages, temperature, disableReasoning, label } = options;
  const preset = getPreset(slot.provider);
  const warnings: string[] = [];
  const timeoutMs = options.timeoutMs ?? (preset.local ? 300_000 : 180_000);
  const sendThinkingFlag = shouldSendThinkingFlag(slot, disableReasoning);
  if (disableReasoning && !sendThinkingFlag) {
    warnings.push(
      `"Disable reasoning" was ignored for ${label}: chat_template_kwargs is only sent to Particle.ai for deepseek-* models.`,
    );
  }

  let attempt = 0;
  let maxTokensUsed = Math.max(options.maxTokens, 900);
  let retriedForEmptyContent = false;
  const started = Date.now();

  for (;;) {
    attempt += 1;
    const body: Record<string, unknown> = {
      model: slot.model,
      messages,
      temperature,
      max_tokens: maxTokensUsed,
      stream: false,
    };
    if (sendThinkingFlag) body.chat_template_kwargs = { enable_thinking: false };

    let response: Response;
    try {
      response = await fetch(joinUrl(slot.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: authHeaders(slot),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError(
          `${preset.label} did not answer within ${Math.round(timeoutMs / 1000)}s — ${label}`,
          { detail: `Timed out waiting on ${joinUrl(slot.baseUrl, '/chat/completions')}`, hint: 'Local models can be slow to load. Try again once the model is resident.' },
        );
      }
      throw unreachable(slot, error);
    }

    if (!response.ok) {
      const { message, detail } = await readErrorBody(response);
      const hint =
        response.status === 401 || response.status === 403
          ? `${preset.label} rejected the key for ${label}. Paste a valid key in the ${label} slot — keys stay in your browser.`
          : response.status === 404
            ? `The model "${slot.model}" was not found at ${slot.baseUrl}. Type a model name by hand if the picker does not list it.`
            : /unloaded/i.test(message)
              ? `Load "${slot.model}" in ${preset.label} first, or turn on just-in-time model loading. A model that is not resident cannot be called concurrently.`
              : undefined;
      throw new ProviderError(`${preset.label} returned HTTP ${response.status} — ${message}`, {
        detail,
        hint,
        status: response.status,
      });
    }

    let payload: Record<string, unknown>;
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(`${preset.label} returned a body that is not JSON — ${label}`, {
        detail: truncate((error as Error).message),
      });
    }

    const choices = Array.isArray(payload.choices) ? (payload.choices as Record<string, unknown>[]) : [];
    const first = choices[0];
    const message = (first?.message ?? {}) as Record<string, unknown>;
    const content = stripReasoning(message);
    const usage = (payload.usage ?? undefined) as Record<string, unknown> | undefined;
    const { tokens: reasoningTokens, reported: reasoningReported } = readReasoningTokens(usage);
    const finishReason = typeof first?.finish_reason === 'string' ? (first.finish_reason as string) : null;

    if (content.trim() === '') {
      if (attempt === 1) {
        const doubled = Math.min(maxTokensUsed * 2, EMPTY_CONTENT_RETRY_CAP);
        warnings.push(
          `Empty content with HTTP 200 on ${label} (finish_reason=${finishReason ?? 'null'}) — retrying once with max_tokens ${maxTokensUsed} → ${doubled}. Hidden reasoning ate the budget.`,
        );
        retriedForEmptyContent = true;
        maxTokensUsed = doubled;
        continue;
      }
      throw new ProviderError(
        `${preset.label} returned HTTP 200 with empty content twice — ${label}`,
        {
          detail: `finish_reason=${finishReason ?? 'null'}, max_tokens=${maxTokensUsed}${reasoningReported ? `, reasoning_tokens=${reasoningTokens}` : ''}. The model spent its whole budget on hidden reasoning.`,
          hint: 'Raise Max Tokens, or tick "Disable reasoning" if this slot is Particle.ai + a deepseek-* model.',
        },
      );
    }

    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    return {
      content: content.trim(),
      promptTokens: num(usage?.prompt_tokens),
      completionTokens: num(usage?.completion_tokens),
      reasoningTokens,
      reasoningReported,
      latencyMs: Date.now() - started,
      finishReason,
      maxTokensUsed,
      retriedForEmptyContent,
      warnings,
      promptHash: await sha256(prompt),
      prompt,
    };
  }
}

/** GET {baseUrl}/models. Never gated: a failure here must not block a run. */
export async function listModels(slot: SlotConfig): Promise<{
  ok: boolean;
  models: string[];
  error?: string;
  detail?: string;
  hint?: string;
  ms: number;
}> {
  const preset = getPreset(slot.provider);
  const started = Date.now();
  try {
    const response = await fetch(joinUrl(slot.baseUrl, '/models'), {
      headers: authHeaders(slot),
      signal: AbortSignal.timeout(preset.local ? 6000 : 20_000),
    });
    if (!response.ok) {
      const { message, detail } = await readErrorBody(response);
      return {
        ok: false,
        models: [],
        error: `${preset.label} returned HTTP ${response.status} — ${message}`,
        detail,
        hint: response.status === 401 ? `Paste a ${preset.label} key, or type a model name by hand.` : undefined,
        ms: Date.now() - started,
      };
    }
    const payload = (await response.json()) as { data?: unknown; models?: unknown };
    const raw = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    const models = raw
      .map((entry) =>
        typeof entry === 'string'
          ? entry
          : typeof (entry as { id?: unknown })?.id === 'string'
            ? ((entry as { id: string }).id)
            : typeof (entry as { name?: unknown })?.name === 'string'
              ? ((entry as { name: string }).name)
              : '',
      )
      .filter((id) => id.length > 0);
    return { ok: true, models, ms: Date.now() - started };
  } catch (error) {
    const failure = unreachable(slot, error);
    return { ok: false, models: [], error: failure.message, detail: failure.detail, hint: failure.hint, ms: Date.now() - started };
  }
}

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}