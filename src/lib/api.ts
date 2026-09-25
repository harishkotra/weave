import type { ModelListResponse, ProgressEvent, WeaveResult } from '../../shared/types';
import type { SlotConfig, WeaveConfig } from '../../shared/providers';

/** GET {baseUrl}/models through the backend. Never gates a run. */
export async function fetchModels(slot: SlotConfig): Promise<ModelListResponse> {
  try {
    const response = await fetch('/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
    return (await response.json()) as ModelListResponse;
  } catch (error) {
    return {
      ok: false,
      baseUrl: slot.baseUrl,
      models: [],
      error: `Cannot reach the Weave backend on 3001 — is the server running?`,
      detail: (error as Error).message,
      hint: 'Start it with npm run dev, which runs both the backend and this page.',
    };
  }
}

export interface StreamOptions {
  question: string;
  config: WeaveConfig;
  onProgress: (event: ProgressEvent) => void;
  signal?: AbortSignal;
}

export class WeaveError extends Error {
  detail?: string;
  hint?: string;
  slot?: string;
  constructor(payload: { message: string; detail?: string; hint?: string; slot?: string }) {
    super(payload.message);
    this.name = 'WeaveError';
    this.detail = payload.detail;
    this.hint = payload.hint;
    this.slot = payload.slot;
  }
}

/**
 * Runs the weave over Server-Sent Events, so "asking", "extracting claims" and
 * "classifying" on screen are the real stages, in the order they happen.
 */
export async function streamWeave(options: StreamOptions): Promise<WeaveResult> {
  const response = await fetch('/api/weave', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ question: options.question, config: options.config }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      /* keep the status line */
    }
    throw new WeaveError({ message: `The Weave backend refused the run — ${detail}` });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: WeaveResult | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const lines = frame.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event:'));
      const dataLine = lines.find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const event = eventLine ? eventLine.slice(6).trim() : 'message';
      let payload: unknown;
      try {
        payload = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event === 'progress') options.onProgress(payload as ProgressEvent);
      else if (event === 'result') result = payload as WeaveResult;
      else if (event === 'error') throw new WeaveError(payload as { message: string });
    }
  }

  if (!result) {
    throw new WeaveError({
      message: 'The run ended without a result.',
      hint: 'Check the backend log. If a provider dropped the connection mid-answer, run it again.',
    });
  }
  return result;
}