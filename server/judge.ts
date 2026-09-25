/**
 * The judge: one slot, its own provider, doing two jobs.
 *
 *   (1) EXTRACT  — split each model's answer into atomic claims (max 12).
 *   (2) CLASSIFY — for each related cross-model pair, agree | contradict + strength.
 *
 * Judge temperature is 0. Output must be JSON; if it is not, retry once, then
 * fall back to lexical Jaccard similarity and label the view "fallback: lexical"
 * so nobody mistakes a lexical edge for a semantic one.
 */
import { JUDGE_MAX_TOKENS, MAX_CLAIMS, MAX_PAIRS } from '../shared/providers';
import type { JudgeExtractRun, JudgeClassifyRun, Relation } from '../shared/types';
import { ProviderError, callChat, sha256, type ChatMessage, type ChatOutcome } from './providers';
import { parseJsonLoose, pickArray } from './json';
import type { SlotConfig } from '../shared/providers';

export const ANSWER_SYSTEM = "You are a precise assistant. Answer the user's request directly.";
export const JUDGE_SYSTEM = 'You are a strict JSON API. Output only valid JSON.';

export interface RawPair {
  a: number;
  b: number;
  relation: Relation;
  strength: number;
}

export interface ExtractionOutcome {
  claims: string[];
  parsed: boolean;
  retried: boolean;
  run: JudgeExtractRun;
  prompt: string;
  promptHash: string;
  /** Set when the judge call itself failed (unreachable, empty content, HTTP error). */
  failure?: { message: string; detail?: string; hint?: string };
}

/** Fresh random nonce per run. Response caches silently fake determinism. */
export function makeNonce(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function nonceTag(nonce: string): string {
  return `\n\n[run-nonce: ${nonce}]`;
}

export function buildExtractPrompt(answer: string, modelLabel: 'A' | 'B', nonce: string): string {
  return [
    'Split the following answer into atomic claims. Return JSON array of strings, max 12 items. No commentary.',
    '',
    `ANSWER FROM MODEL ${modelLabel}:`,
    '"""',
    answer,
    '"""',
  ].join('\n') + nonceTag(nonce);
}

export function buildClassifyPrompt(claimsA: string[], claimsB: string[], nonce: string): string {
  const list = (claims: string[]) => claims.map((claim, index) => `${index}. ${claim}`).join('\n');
  return [
    'Two models answered the same question. Below are their atomic claims, indexed.',
    '',
    'MODEL A CLAIMS:',
    list(claimsA),
    '',
    'MODEL B CLAIMS:',
    list(claimsB),
    '',
    'For every cross-model pair of claims that is related, output an entry. Return JSON of exactly this shape:',
    '{"pairs":[{"a":<index in MODEL A>,"b":<index in MODEL B>,"relation":"agree"|"contradict","strength":<0..1>}]}',
    'Only include pairs that are genuinely related. Cap the pairs at 30. If there are no relations, return {"pairs":[]}. No commentary.',
  ].join('\n') + nonceTag(nonce);
}

function cleanClaim(value: unknown): string {
  if (typeof value !== 'string') {
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['claim', 'text', 'statement', 'content', 'sentence']) {
        if (typeof record[key] === 'string') return cleanClaim(record[key]);
      }
    }
    return '';
  }
  return value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function coerceClaims(value: unknown): string[] {
  const array = pickArray(value, ['claims', 'items', 'list', 'data', 'results', 'sentences']);
  if (!array) return [];
  const seen = new Set<string>();
  const claims: string[] = [];
  for (const entry of array) {
    const claim = cleanClaim(entry);
    if (claim.length < 3) continue;
    const key = claim.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(claim);
    if (claims.length >= MAX_CLAIMS) break;
  }
  return claims;
}

function normalizeRelation(value: unknown): Relation | null {
  if (typeof value !== 'string') return null;
  const text = value.toLowerCase().trim();
  if (/(contradict|conflict|oppos|disagree|refut|deny|denies|against|tension)/.test(text)) return 'contradict';
  if (/(agree|agreement|support|consistent|same|align|match|reinforce|corroborat|entail)/.test(text)) return 'agree';
  return null;
}

function normalizeStrength(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1 && value <= 100) return Math.min(1, value / 100);
    if (value > 100) return null;
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace('%', ''));
    if (Number.isFinite(parsed)) return normalizeStrength(parsed);
  }
  return null;
}

function indexOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[^\d-]/g, ''), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

export function coercePairs(value: unknown, countA: number, countB: number): RawPair[] {
  const array = pickArray(value, ['pairs', 'edges', 'relations', 'links', 'items', 'data', 'results']);
  if (!array) return [];
  const pairs: RawPair[] = [];
  const seen = new Set<string>();
  for (const entry of array) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const a = indexOf(record.a ?? record.a_index ?? record.index_a ?? record.source ?? record.from ?? record.i);
    const b = indexOf(record.b ?? record.b_index ?? record.index_b ?? record.target ?? record.to ?? record.j);
    const relation = normalizeRelation(record.relation ?? record.type ?? record.label ?? record.verdict);
    if (a === null || b === null || relation === null) continue;
    if (a < 0 || b < 0 || a >= countA || b >= countB) continue;
    const key = `${a}:${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ a, b, relation, strength: normalizeStrength(record.strength ?? record.confidence ?? record.score) ?? 0.5 });
  }
  return pairs
    .sort((x, y) => y.strength - x.strength || x.a - y.a || x.b - y.b)
    .slice(0, MAX_PAIRS);
}

/** Sentence split, used only when the judge cannot produce claims at all. */
export function splitSentences(answer: string): string[] {
  return answer
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n(?=[-*•\d])/)
    .map((part) => cleanClaim(part))
    .filter((part) => part.length >= 20)
    .slice(0, MAX_CLAIMS);
}

const STOPWORDS = new Set(
  `a an the and or but if then than that this these those is are was were be been being am do does did doing have has had having i you he she it we they me him her them my your his its our their of to in on at by for with about against between into through during before after above below from up down out off over under again further once here there when where why how all any both each few more most other some such no nor not only own same so too very can will just should now would could may might must shall`.split(
    /\s+/,
  ),
);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .map((token) => token.replace(/^['-]+|['-]+$/g, ''))
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

const NEGATION = /\b(no|not|never|cannot|can't|don't|doesn't|isn't|aren't|won't|shouldn't|without|avoid|avoids|fail|fails|refuse|refuses|ban|bans|prohibit|prohibits|stop|stops|prevent|prevents|harm|harmful|worse|unnecessary|unreliable)\b/;

export interface LexicalResult {
  pairs: RawPair[];
  threshold: number;
}

/**
 * The required fallback: Jaccard similarity over token sets. Edges produced here
 * are labelled `lexical` everywhere they surface, because they are not semantic.
 */
export function lexicalEdges(claimsA: string[], claimsB: string[]): LexicalResult {
  const threshold = 0.32;
  const tokensA = claimsA.map(tokenize);
  const tokensB = claimsB.map(tokenize);
  const pairs: RawPair[] = [];
  for (let a = 0; a < claimsA.length; a += 1) {
    for (let b = 0; b < claimsB.length; b += 1) {
      const similarity = jaccard(tokensA[a], tokensB[b]);
      if (similarity < threshold) continue;
      const negA = NEGATION.test(claimsA[a].toLowerCase());
      const negB = NEGATION.test(claimsB[b].toLowerCase());
      const relation: Relation = negA !== negB && similarity >= 0.45 ? 'contradict' : 'agree';
      pairs.push({ a, b, relation, strength: Number(similarity.toFixed(3)) });
    }
  }
  return {
    pairs: pairs.sort((x, y) => y.strength - x.strength || x.a - y.a || x.b - y.b).slice(0, MAX_PAIRS),
    threshold,
  };
}

function toExtractRun(outcome: ChatOutcome, claimCount: number, parsed: boolean, retried: boolean): JudgeExtractRun {
  return {
    latencyMs: outcome.latencyMs,
    promptTokens: outcome.promptTokens,
    completionTokens: outcome.completionTokens,
    reasoningTokens: outcome.reasoningTokens,
    reasoningReported: outcome.reasoningReported,
    claimCount,
    parsed,
    retried,
  };
}

export interface ExtractOptions {
  slot: SlotConfig;
  answer: string;
  modelLabel: 'A' | 'B';
  nonce: string;
}

/** EXTRACT: judge call #1. Retries once, then falls back to sentence splitting. */
export async function extractClaims(options: ExtractOptions): Promise<ExtractionOutcome> {
  const { slot, answer, modelLabel, nonce } = options;
  const prompt = buildExtractPrompt(answer, modelLabel, nonce);
  const messages: ChatMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: prompt },
  ];

  let last: ChatOutcome | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let outcome: ChatOutcome;
    try {
      outcome = await callChat({
        slot,
        messages,
        temperature: 0,
        maxTokens: JUDGE_MAX_TOKENS,
        disableReasoning: slot.disableReasoning,
        label: `Judge extract (${modelLabel})`,
      });
    } catch (error) {
      // A judge that cannot answer must not kill the run: fall back to sentence
      // splitting and let the view say "fallback: lexical".
      const failure = error as ProviderError;
      const claims = splitSentences(answer);
      return {
        claims,
        parsed: false,
        retried: true,
        run: emptyRun(),
        prompt,
        promptHash: await sha256(prompt),
        failure: { message: failure.message, detail: failure.detail, hint: failure.hint },
      };
    }
    last = outcome;
    const parsed = parseJsonLoose(outcome.content);
    const claims = parsed.value ? coerceClaims(parsed.value) : [];
    if (claims.length > 0) {
      return {
        claims,
        parsed: true,
        retried: attempt === 1,
        run: toExtractRun(outcome, claims.length, true, attempt === 1),
        prompt: outcome.prompt,
        promptHash: outcome.promptHash,
      };
    }
  }

  const claims = splitSentences(answer);
  const outcome = last as ChatOutcome;
  return {
    claims,
    parsed: false,
    retried: true,
    run: toExtractRun(outcome, claims.length, false, true),
    prompt: outcome.prompt,
    promptHash: outcome.promptHash,
  };
}

export interface ClassifyOutcome {
  pairs: RawPair[];
  parsed: boolean;
  retried: boolean;
  usedFallback: boolean;
  pairsReturned: number;
  run: JudgeClassifyRun;
  prompt: string;
  promptHash: string;
  /** Claims from a judge that returned none, or the sentence fallback. */
  claimsFallback: boolean;
  failure?: { message: string; detail?: string; hint?: string };
}

function emptyRun(): JudgeExtractRun {
  return {
    latencyMs: 0,
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    reasoningReported: false,
    claimCount: 0,
    parsed: false,
    retried: true,
  };
}

export interface ClassifyOptions {
  slot: SlotConfig;
  claimsA: string[];
  claimsB: string[];
  nonce: string;
  claimsFallback: boolean;
}

/** CLASSIFY: judge call #2. Retries once, then falls back to lexical Jaccard. */
export async function classifyPairs(options: ClassifyOptions): Promise<ClassifyOutcome> {
  const { slot, claimsA, claimsB, nonce, claimsFallback } = options;
  const prompt = buildClassifyPrompt(claimsA, claimsB, nonce);
  const messages: ChatMessage[] = [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: prompt },
  ];

  let last: ChatOutcome | null = null;
  let pairsReturned = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let outcome: ChatOutcome;
    try {
      outcome = await callChat({
        slot,
        messages,
        temperature: 0,
        maxTokens: JUDGE_MAX_TOKENS,
        disableReasoning: slot.disableReasoning,
        label: 'Judge classify',
      });
    } catch (error) {
      // Same rule as extraction: a judge that fails means lexical edges with the
      // label on them, not a dead run.
      const failure = error as ProviderError;
      const lexical = lexicalEdges(claimsA, claimsB);
      return {
        pairs: lexical.pairs,
        parsed: false,
        retried: true,
        usedFallback: true,
        pairsReturned: lexical.pairs.length,
        run: { ...emptyRun(), pairsReturned: lexical.pairs.length, pairsUsed: lexical.pairs.length },
        prompt,
        promptHash: await sha256(prompt),
        claimsFallback,
        failure: { message: failure.message, detail: failure.detail, hint: failure.hint },
      };
    }
    last = outcome;
    const parsed = parseJsonLoose(outcome.content);
    if (parsed.value !== null) {
      const pairs = coercePairs(parsed.value, claimsA.length, claimsB.length);
      pairsReturned = pairs.length;
      return {
        pairs,
        parsed: true,
        retried: attempt === 1,
        usedFallback: false,
        pairsReturned,
        run: {
          ...toExtractRun(outcome, 0, true, attempt === 1),
          pairsReturned,
          pairsUsed: pairs.length,
        },
        prompt: outcome.prompt,
        promptHash: outcome.promptHash,
        claimsFallback,
      };
    }
  }

  const lexical = lexicalEdges(claimsA, claimsB);
  const outcome = last as ChatOutcome;
  return {
    pairs: lexical.pairs,
    parsed: false,
    retried: true,
    usedFallback: true,
    pairsReturned: lexical.pairs.length,
    run: {
      ...toExtractRun(outcome, 0, false, true),
      pairsReturned: lexical.pairs.length,
      pairsUsed: lexical.pairs.length,
    },
    prompt: outcome.prompt,
    promptHash: outcome.promptHash,
    claimsFallback,
  };
}