/**
 * One run of Weave.
 *
 * A and B get the identical question, concurrently. The judge then does EXTRACT
 * (once per model) and CLASSIFY (once, over both claim lists). Every prompt
 * carries a fresh per-run nonce so a repeated experiment can never be served
 * from a response cache, and the nonces are hashed and checked for reuse.
 */
import {
  DEFAULT_CONFIG,
  MIN_MAX_TOKENS,
  getPreset,
  type SlotConfig,
  type SlotId,
  type WeaveConfig,
} from '../shared/providers';
import type { EdgeSource, ModelRun, ProgressEvent, WeaveResult } from '../shared/types';
import { ProviderError, callChat, sha256 } from './providers';
import { ANSWER_SYSTEM, classifyPairs, extractClaims, makeNonce } from './judge';
import { buildGraph } from './graph';

export interface RunOptions {
  question: string;
  config: WeaveConfig;
  onProgress?: (event: ProgressEvent) => void;
}

class ConfigError extends Error {
  detail?: string;
  hint?: string;
  slot?: SlotId;
  constructor(message: string, opts: { detail?: string; hint?: string; slot?: SlotId } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.detail = opts.detail;
    this.hint = opts.hint;
    this.slot = opts.slot;
  }
}

export function validateSlot(slotId: SlotId, slot: SlotConfig): void {
  const preset = getPreset(slot.provider);
  const label = slotId === 'judge' ? 'the Judge slot' : slotId === 'a' ? 'Model A' : 'Model B';
  if (!slot.baseUrl.trim()) {
    throw new ConfigError(`${preset.label} has no base URL in ${label}`, {
      hint: 'Paste an OpenAI-compatible base URL, for example https://api.openai.com/v1',
      slot: slotId,
    });
  }
  if (!/^https?:\/\//i.test(slot.baseUrl.trim())) {
    throw new ConfigError(`The base URL in ${label} must start with http:// or https://`, {
      detail: `Got: ${slot.baseUrl.trim()}`,
      slot: slotId,
    });
  }
  if (!slot.model.trim()) {
    throw new ConfigError(`${label} has no model name`, {
      hint: preset.local ? `Pick a model from the list, or type one by hand.` : 'Type a model name, or load the list from the provider.',
      slot: slotId,
    });
  }
  if (preset.keyRequired && !slot.apiKey.trim()) {
    throw new ConfigError(`${preset.label} needs an API key in ${label}`, {
      hint: 'Keys are typed into the UI and kept in your browser only — nothing is read from a .env file.',
      slot: slotId,
    });
  }
}

function assertNoPromptReuse(hashes: string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const hash of hashes) {
    if (seen.has(hash)) duplicates += 1;
    seen.add(hash);
  }
  return duplicates;
}

export async function runWeave(options: RunOptions): Promise<WeaveResult> {
  const config: WeaveConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
    slots: { ...DEFAULT_CONFIG.slots, ...options.config?.slots },
  };
  const question = (options.question ?? '').trim();
  if (question.length < 8) {
    throw new ConfigError('Ask a real question first', {
      hint: 'At least 8 characters. Pick one of the presets if you want to start fast.',
    });
  }

  const progress = (stage: ProgressEvent['stage'], detail?: string) =>
    options.onProgress?.({ stage, detail, at: new Date().toISOString() });

  (['a', 'b', 'judge'] as SlotId[]).forEach((slotId) => validateSlot(slotId, config.slots[slotId]));

  const warnings: string[] = [];
  const nonce = makeNonce();
  const runId = crypto.randomUUID();
  const startedAt = new Date();
  const started = Date.now();
  const temperature = Number.isFinite(config.temperature) ? Math.max(0, Math.min(2, config.temperature)) : 0.7;
  let maxTokens = Number.isFinite(config.maxTokens) ? Math.round(config.maxTokens) : DEFAULT_CONFIG.maxTokens;
  if (maxTokens < MIN_MAX_TOKENS) {
    warnings.push(`Max tokens raised from ${maxTokens} to ${MIN_MAX_TOKENS}: reasoning models need a real budget.`);
    maxTokens = MIN_MAX_TOKENS;
  }

  // The question bytes sent to A and B are identical. The nonce is per run, not
  // per model, so the comparison stays fair while repeated runs cannot be cached.
  const questionPrompt = `${question}\n\n[run-nonce: ${nonce}]`;

  progress('asking', 'Model A and Model B answering the same question in parallel');
  const answer = async (slotId: 'a' | 'b'): Promise<{ run: ModelRun; promptHash: string }> => {
    const slot = config.slots[slotId];
    const preset = getPreset(slot.provider);
    const label = slotId === 'a' ? 'Model A' : 'Model B';
    const outcome = await callChat({
      slot,
      messages: [
        { role: 'system', content: ANSWER_SYSTEM },
        { role: 'user', content: questionPrompt },
      ],
      temperature,
      maxTokens,
      disableReasoning: slot.disableReasoning,
      label,
    });
    warnings.push(...outcome.warnings);
    return {
      // Role-prefixed so the deliberately identical question bytes sent to A and
      // B are not miscounted as prompt reuse.
      promptHash: await sha256(`${slotId.toUpperCase()}|${outcome.prompt}`),
      run: {
        slot: slotId,
        provider: slot.provider,
        providerLabel: preset.label,
        baseUrl: slot.baseUrl,
        model: slot.model,
        answer: outcome.content,
        claims: [],
        latencyMs: outcome.latencyMs,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        reasoningTokens: outcome.reasoningTokens,
        reasoningReported: outcome.reasoningReported,
        maxTokensUsed: outcome.maxTokensUsed,
        retriedForEmptyContent: outcome.retriedForEmptyContent,
        finishReason: outcome.finishReason,
        sha256: await sha256(outcome.content),
      },
    };
  };

  const [answeredA, answeredB] = await Promise.all([answer('a'), answer('b')]);
  const runA = answeredA.run;
  const runB = answeredB.run;

  progress('extracting', 'Judge splitting both answers into atomic claims');
  const [extractA, extractB] = await Promise.all([
    extractClaims({ slot: config.slots.judge, answer: runA.answer, modelLabel: 'A', nonce }),
    extractClaims({ slot: config.slots.judge, answer: runB.answer, modelLabel: 'B', nonce }),
  ]);
  runA.claims = extractA.claims;
  runB.claims = extractB.claims;

  const claimsFallback = !extractA.parsed || !extractB.parsed;
  if (claimsFallback) {
    const which = [!extractA.parsed ? 'A' : null, !extractB.parsed ? 'B' : null].filter(Boolean).join(' and ');
    const why = [extractA.failure, extractB.failure].find(Boolean);
    warnings.push(
      `Judge claim extraction did not return JSON for ${which} — claims were split by sentence instead. Labelled fallback: lexical.` +
        (why ? ` Judge said: ${why.message}${why.detail ? ` (${why.detail})` : ''}` : ''),
    );
  }

  progress('classifying', 'Judge classifying agree / contradict across both claim lists');
  const classified = await classifyPairs({
    slot: config.slots.judge,
    claimsA: runA.claims,
    claimsB: runB.claims,
    nonce,
    claimsFallback,
  });
  if (classified.usedFallback) {
    warnings.push(
      'Judge classification did not return JSON — edges are lexical Jaccard similarity, not semantic. Labelled fallback: lexical.' +
        (classified.failure
          ? ` Judge said: ${classified.failure.message}${classified.failure.detail ? ` (${classified.failure.detail})` : ''}`
          : ''),
    );
  }

  const sourceKind: EdgeSource = classified.usedFallback ? 'lexical' : 'judge';
  const graph = buildGraph({
    claimsA: runA.claims,
    claimsB: runB.claims,
    pairs: classified.pairs,
    sourceKind,
  });

  const judgePreset = getPreset(config.slots.judge.provider);
  const parseMode: WeaveResult['judge']['parseMode'] =
    classified.usedFallback || claimsFallback ? 'fallback-lexical' : classified.retried || extractA.retried || extractB.retried ? 'json-retry' : 'json';

  // Prompt-reuse check: five prompts went out this run; all five must be distinct.
  // A and B share question bytes on purpose, so their hashes are role-prefixed.
  const hashes = [answeredA.promptHash, answeredB.promptHash, extractA.promptHash, extractB.promptHash, classified.promptHash];
  const duplicates = assertNoPromptReuse(hashes);
  if (duplicates > 0) {
    warnings.push(
      `Prompt reuse detected (${duplicates} duplicate prompt hash${duplicates === 1 ? '' : 'es'}). Results may be served from a cache.`,
    );
  }

  const finishedAt = new Date();
  const result: WeaveResult = {
    runId,
    nonce,
    question,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalMs: Date.now() - started,
    config: {
      temperature,
      maxTokens,
      slots: {
        a: { ...config.slots.a, apiKey: config.slots.a.apiKey.trim() ? 'provided' : 'none' },
        b: { ...config.slots.b, apiKey: config.slots.b.apiKey.trim() ? 'provided' : 'none' },
        judge: { ...config.slots.judge, apiKey: config.slots.judge.apiKey.trim() ? 'provided' : 'none' },
      },
    },
    models: { a: runA, b: runB },
    judge: {
      providerLabel: judgePreset.label,
      provider: config.slots.judge.provider,
      baseUrl: config.slots.judge.baseUrl,
      model: config.slots.judge.model,
      parseMode,
      extract: { a: extractA.run, b: extractB.run },
      classify: classified.run,
      // Raw judge output, before the merged overlap view absorbs matched pairs.
      pairs: classified.pairs.map((pair) => ({ ...pair, source_kind: sourceKind })),
    },
    panels: graph.panels,
    consensus: graph.consensus,
    prompts: {
      extractA: extractA.prompt,
      extractB: extractB.prompt,
      classify: classified.prompt,
    },
    promptReuse: {
      promptsSent: hashes.length,
      uniquePrompts: new Set(hashes).size,
      duplicates,
      nonce,
      questionBytesIdentical: true,
      hashes: hashes.map((hash) => hash.slice(0, 16)),
    },
    warnings,
  };

  return result;
}

export { ConfigError, ProviderError };