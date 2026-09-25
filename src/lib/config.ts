import {
  DEFAULT_CONFIG,
  PROVIDER_PRESETS,
  getPreset,
  type SlotConfig,
  type SlotId,
  type WeaveConfig,
} from '../../shared/providers';

const STORAGE_KEY = 'weave.config.v1';

function isSlotId(value: string): value is SlotId {
  return value === 'a' || value === 'b' || value === 'judge';
}

function normalizeSlot(raw: unknown, fallback: SlotConfig): SlotConfig {
  const record = (raw ?? {}) as Partial<SlotConfig>;
  const provider = PROVIDER_PRESETS.some((preset) => preset.id === record.provider)
    ? (record.provider as SlotConfig['provider'])
    : fallback.provider;
  return {
    provider,
    baseUrl: typeof record.baseUrl === 'string' && record.baseUrl.length > 0 ? record.baseUrl : getPreset(provider).baseUrl || fallback.baseUrl,
    // API keys are typed here and stay in this browser. No key ever ships in the repo.
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    model: typeof record.model === 'string' && record.model.length > 0 ? record.model : fallback.model,
    disableReasoning:
      typeof record.disableReasoning === 'boolean' ? record.disableReasoning : fallback.disableReasoning,
  };
}

export function loadConfig(): WeaveConfig {
  if (typeof localStorage === 'undefined') return DEFAULT_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<WeaveConfig> & { slots?: Record<string, unknown> };
    return {
      temperature: typeof parsed.temperature === 'number' ? parsed.temperature : DEFAULT_CONFIG.temperature,
      maxTokens: typeof parsed.maxTokens === 'number' ? parsed.maxTokens : DEFAULT_CONFIG.maxTokens,
      slots: {
        a: normalizeSlot(parsed.slots?.a, DEFAULT_CONFIG.slots.a),
        b: normalizeSlot(parsed.slots?.b, DEFAULT_CONFIG.slots.b),
        judge: normalizeSlot(parsed.slots?.judge, DEFAULT_CONFIG.slots.judge),
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: WeaveConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private mode, quota — the app still runs, it just will not remember */
  }
}

export function resetConfig(): WeaveConfig {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG;
}

export { isSlotId };