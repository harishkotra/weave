import type { ProviderId, SlotConfig, SlotId } from './providers';

export type Stage = 'idle' | 'asking' | 'extracting' | 'classifying' | 'simulating' | 'settled' | 'error';

export type Relation = 'agree' | 'contradict';

/** Where an edge came from. `lexical` means the judge JSON failed and we fell back. */
export type EdgeSource = 'judge' | 'lexical' | 'projection';

export interface ModelRun {
  slot: Extract<SlotId, 'a' | 'b'>;
  provider: ProviderId;
  providerLabel: string;
  baseUrl: string;
  model: string;
  answer: string;
  claims: string[];
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** null means the provider did not report reasoning tokens at all. Never 0-by-default. */
  reasoningTokens: number | null;
  reasoningReported: boolean;
  maxTokensUsed: number;
  retriedForEmptyContent: boolean;
  finishReason: string | null;
  /** sha256 of the raw answer text. */
  sha256: string;
}

export interface JudgeExtractRun {
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  reasoningReported: boolean;
  claimCount: number;
  parsed: boolean;
  retried: boolean;
}

export interface JudgeClassifyRun extends JudgeExtractRun {
  pairsReturned: number;
  pairsUsed: number;
}

export interface JudgeRun {
  providerLabel: string;
  model: string;
  provider: ProviderId;
  baseUrl: string;
  /** `fallback-lexical` labels the whole view: those edges are not semantic. */
  parseMode: 'json' | 'json-retry' | 'fallback-lexical';
  extract: { a: JudgeExtractRun; b: JudgeExtractRun };
  classify: JudgeClassifyRun;
  /** Exactly what the judge returned, before the merged view absorbs anything. */
  pairs: JudgePair[];
}

export interface JudgePair {
  a: number;
  b: number;
  relation: Relation;
  strength: number;
  source_kind: EdgeSource;
}

export interface GraphNode {
  id: string;
  panel: 'a' | 'b' | 'both';
  model: 'a' | 'b' | 'both';
  index: number;
  text: string;
  /** On the "Both" panel a consensus node carries both phrasings. */
  textOther?: string;
  chars: number;
  radius: number;
  shared: boolean;
  pairId: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: Relation;
  strength: number;
  source_kind: EdgeSource;
}

export interface PanelStats {
  claimCount: number;
  uniqueCount: number;
  sharedCount: number;
  overlapPct: number;
  agreeCount: number;
  contradictCount: number;
  meanContradictionStrength: number;
  edgeCount: number;
}

export interface GraphPanelData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: PanelStats;
}

export interface ConsensusStats {
  sharedPairs: number;
  aOnly: number;
  bOnly: number;
  /** Every claim counted once, matched pairs merged. */
  totalNodes: number;
  /** Headline: share of claim-nodes both models made, matched one-to-one. */
  consensusByNodes: number;
  /** Claims linked to the other answer by at least one agree relation, over all claims. */
  participationByNodes: number;
  /** How many claims the judge linked across models at all. */
  linkedClaims: number;
  /** Same overlap measured in characters of text. */
  consensusByText: number;
  meanContradictionStrength: number;
  /** Judge-level pair counts, before the merged view absorbs anything. */
  contradictionCount: number;
  agreeCount: number;
  /** Agree pairs whose two claims became one consensus node: the core itself. */
  absorbedIntoCore: number;
  /** Edges actually drawn on the Both panel. */
  drawnEdges: number;
}

export interface PromptReuseCheck {
  promptsSent: number;
  uniquePrompts: number;
  duplicates: number;
  nonce: string;
  /** A and B are sent byte-identical question text; only the nonce differs per run. */
  questionBytesIdentical: boolean;
  /** sha256 (first 16 chars) of each prompt sent, in order. */
  hashes: string[];
}

export interface WeaveResult {
  runId: string;
  nonce: string;
  question: string;
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  config: {
    temperature: number;
    maxTokens: number;
    slots: Record<SlotId, Omit<SlotConfig, 'apiKey'> & { apiKey: 'provided' | 'none' }>;
  };
  models: { a: ModelRun; b: ModelRun };
  judge: JudgeRun;
  panels: { a: GraphPanelData; b: GraphPanelData; both: GraphPanelData };
  consensus: ConsensusStats;
  prompts: { extractA: string; extractB: string; classify: string };
  promptReuse: PromptReuseCheck;
  warnings: string[];
}

export interface ProgressEvent {
  stage: Stage;
  detail?: string;
  at?: string;
}

export interface ModelListResponse {
  ok: boolean;
  baseUrl: string;
  models: string[];
  /** Provider's real error text, verbatim. Never "Something went wrong". */
  error?: string;
  detail?: string;
  hint?: string;
  ms?: number;
}

export interface ApiError {
  message: string;
  detail?: string;
  hint?: string;
  slot?: SlotId;
  status?: number;
}