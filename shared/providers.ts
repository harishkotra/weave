/**
 * Provider presets. Shared by the browser (dropdown) and the server (validation,
 * error copy). Nothing here is a secret: API keys are entered in the UI and
 * live in localStorage only.
 */

export type ProviderId = 'particle' | 'ollama' | 'lmstudio' | 'openrouter' | 'custom';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** Default base URL. `custom` starts empty on purpose. */
  baseUrl: string;
  /** Whether the provider rejects requests without a key. */
  keyRequired: boolean;
  keyHint: string;
  /** Suggestions only. The live GET {baseUrl}/models list is merged on top. */
  presetModels: string[];
  /** Local servers get "is X running?" error copy. */
  local: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'particle',
    label: 'Particle.ai',
    baseUrl: 'https://api.particle.ai/v1',
    keyRequired: true,
    keyHint: 'Paste your Particle.ai key',
    // deepseek-v4-flash-0731 is deliberately listed: it does not appear in
    // Particle.ai's /models response and still responds, so the model field
    // must always stay typeable.
    presetModels: ['deepseek-v4.1-flash', 'deepseek-v4-flash-0731', 'glm5.3flash'],
    local: false,
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyRequired: false,
    keyHint: 'No key needed',
    presetModels: [],
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    keyHint: 'No key needed',
    presetModels: [],
    local: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    keyHint: 'sk-or-...',
    presetModels: [],
    local: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    baseUrl: '',
    keyRequired: false,
    keyHint: 'Any OpenAI-compatible endpoint',
    presetModels: [],
    local: false,
  },
];

export function getPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

export type SlotId = 'a' | 'b' | 'judge';

export interface SlotConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Per slot, because capability is per slot: the flag is only ever sent to
   * Particle.ai on a deepseek-* model, and the toggle is hidden everywhere else.
   * Defaults: off for A and B (you want their natural answers), on for the judge
   * (a judge that spends its whole budget on hidden reasoning returns no JSON).
   */
  disableReasoning: boolean;
}

export interface WeaveConfig {
  slots: Record<SlotId, SlotConfig>;
  temperature: number;
  maxTokens: number;
}

export const SLOT_META: Record<SlotId, { title: string; role: string; accent: string }> = {
  a: { title: 'Model A', role: 'the older model', accent: 'var(--thread-a)' },
  b: { title: 'Model B', role: 'the newer model', accent: 'var(--thread-b)' },
  judge: { title: 'Judge', role: 'splits answers into claims, then classifies the edges', accent: 'var(--thread-core)' },
};

export const DEFAULT_CONFIG: WeaveConfig = {
  slots: {
    a: { provider: 'particle', baseUrl: 'https://api.particle.ai/v1', apiKey: '', model: 'deepseek-v4-flash-0731', disableReasoning: false },
    b: { provider: 'particle', baseUrl: 'https://api.particle.ai/v1', apiKey: '', model: 'deepseek-v4.1-flash', disableReasoning: false },
    // The judge may be a different provider from A and B — e.g. a local model
    // judging two cloud models. Default: same as B, with reasoning off so its
    // budget goes to JSON instead of hidden chain-of-thought.
    judge: { provider: 'particle', baseUrl: 'https://api.particle.ai/v1', apiKey: '', model: 'deepseek-v4.1-flash', disableReasoning: true },
  },
  temperature: 0.7,
  maxTokens: 1600,
};

/**
 * Capability rule, never an assumption: `chat_template_kwargs` is only ever sent
 * when the slot's provider is Particle.ai AND the model name starts with
 * "deepseek-". Every other provider ignores or rejects unknown fields.
 */
export function supportsThinkingFlag(slot: SlotConfig): boolean {
  return slot.provider === 'particle' && slot.model.trim().toLowerCase().startsWith('deepseek-');
}

export function shouldSendThinkingFlag(slot: SlotConfig, disableReasoning: boolean): boolean {
  return disableReasoning && supportsThinkingFlag(slot);
}

/** Reasoning models need a real budget. 900 is the floor, 1600 the default. */
export const MIN_MAX_TOKENS = 900;
export const JUDGE_MAX_TOKENS = 2000;
export const EMPTY_CONTENT_RETRY_CAP = 4000;
export const MAX_CLAIMS = 12;
export const MAX_PAIRS = 30;

export const QUESTION_PRESETS = [
  'Should companies ban AI-generated code from production?',
  'Is remote work better for junior engineers?',
  'Will AI agents replace SaaS?',
  'Should you learn Rust in 2026?',
];