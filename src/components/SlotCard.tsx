import { useEffect, useRef, useState } from 'react';
import {
  PROVIDER_PRESETS,
  getPreset,
  supportsThinkingFlag,
  type ProviderId,
  type SlotConfig,
  type SlotId,
} from '../../shared/providers';
import type { ModelListResponse } from '../../shared/types';

export interface ReasoningReading {
  tokens: number | null;
  reported: boolean;
  model: string;
}

export interface SlotCardProps {
  slotId: SlotId;
  config: SlotConfig;
  reasoning: ReasoningReading | null;
  models: ModelListResponse | null;
  onLoadModels: (slotId: SlotId, slot?: SlotConfig) => void;
  onChange: (slotId: SlotId, patch: Partial<SlotConfig>) => void;
  disabled: boolean;
}

export function SlotCard({ slotId, config, reasoning, models, onLoadModels, onChange, disabled }: SlotCardProps) {
  const preset = getPreset(config.provider);
  const [open, setOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const options = Array.from(new Set([...(models?.models ?? []), ...preset.presetModels]));
  const thinking = supportsThinkingFlag(config);
  // Hide the thinking toggle where it cannot be sent: only Particle.ai + deepseek-*.
  const reasoningUnavailable = reasoning !== null && !reasoning.reported;

  const setProvider = (provider: ProviderId) => {
    const next = getPreset(provider);
    const updated: SlotConfig = { ...config, provider, baseUrl: next.baseUrl || config.baseUrl };
    onChange(slotId, { provider: updated.provider, baseUrl: updated.baseUrl });
    // Ask the new provider for its live model list. A failure changes nothing:
    // the model field stays typeable.
    if (updated.baseUrl) onLoadModels(slotId, updated);
  };

  return (
    <article className="slot" data-slot={slotId}>
      <header className="slot-head">
        <h3>
          {slotId === 'a' ? 'Model A' : slotId === 'b' ? 'Model B' : 'Judge'}
          <span className="slot-dot" aria-hidden="true" />
        </h3>
        <p>{slotId === 'judge' ? 'splits answers into claims, classifies the edges' : slotId === 'a' ? 'the older model' : 'the newer model'}</p>
      </header>

      <div className="field">
        <label htmlFor={`provider-${slotId}`}>Provider</label>
        <select id={`provider-${slotId}`} value={config.provider} onChange={(event) => setProvider(event.target.value as ProviderId)} disabled={disabled}>
          {PROVIDER_PRESETS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.keyRequired ? '' : ' · no key'}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`base-${slotId}`}>Base URL</label>
        <input
          id={`base-${slotId}`}
          type="text"
          spellCheck={false}
          autoComplete="off"
          value={config.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(event) => onChange(slotId, { baseUrl: event.target.value })}
          disabled={disabled}
        />
      </div>

      <div className="field">
        <label htmlFor={`key-${slotId}`}>
          API key
          {preset.keyRequired ? <span className="req">required</span> : <span className="opt">no key needed</span>}
        </label>
        <div className="key-row">
          <input
            id={`key-${slotId}`}
            type={reveal ? 'text' : 'password'}
            spellCheck={false}
            autoComplete="off"
            value={config.apiKey}
            placeholder={preset.keyHint}
            onChange={(event) => onChange(slotId, { apiKey: event.target.value })}
            disabled={disabled || !preset.keyRequired}
          />
          <button type="button" className="ghost tiny" onClick={() => setReveal((value) => !value)} disabled={!preset.keyRequired}>
            {reveal ? 'hide' : 'show'}
          </button>
        </div>
        <p className="hint">Kept in this browser's localStorage. No key is ever read from a file or shipped in the repo.</p>
      </div>

      <div className="field">
        <label htmlFor={`model-${slotId}`}>Model</label>
        <div className="model-row" ref={listRef}>
          <input
            id={`model-${slotId}`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={config.model}
            placeholder="type any model name"
            onChange={(event) => onChange(slotId, { model: event.target.value })}
            disabled={disabled}
          />
          <button
            type="button"
            className="ghost tiny"
            aria-expanded={open}
            onClick={() => {
              setOpen((value) => !value);
              if (!models) onLoadModels(slotId);
            }}
            disabled={disabled}
          >
            {options.length > 0 ? `▾ ${options.length}` : '▾ load'}
          </button>
          {open && (
            <div className="model-menu" role="listbox">
              {options.length === 0 && <p className="hint">Nothing listed yet. Type a name — a model can answer without appearing in /models.</p>}
              {options.map((model) => (
                <button
                  key={model}
                  type="button"
                  role="option"
                  aria-selected={model === config.model}
                  onClick={() => {
                    onChange(slotId, { model });
                    setOpen(false);
                  }}
                >
                  {model}
                </button>
              ))}
              {models && !models.ok && <p className="menu-error">{models.error}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="slot-status">
        <button type="button" className="ghost tiny" onClick={() => onLoadModels(slotId)} disabled={disabled}>
          Load models from provider
        </button>
        {models && (
          <p className={models.ok ? 'hint' : 'error-text'}>
            {models.ok ? `${models.models.length} models from ${models.baseUrl} (${models.ms}ms)` : models.error}
          </p>
        )}
        {models && !models.ok && models.detail && <p className="detail-text">{models.detail}</p>}
        {models && !models.ok && models.hint && <p className="hint">{models.hint}</p>}
        {!models?.ok && models && <p className="hint">Typing a model name by hand always works — a run is never gated on this list.</p>}
      </div>

      <div className="slot-capability mono">
        {reasoningUnavailable ? (
          <span>
            reasoning n/a — {reasoning?.model} reported no reasoning tokens, thinking toggle hidden
          </span>
        ) : (
          <span>
            reasoning{' '}
            {reasoning === null ? (
              <em>not measured yet</em>
            ) : reasoning.tokens === null ? (
              'n/a'
            ) : (
              `${reasoning.tokens} tokens`
            )}
          </span>
        )}
      </div>

      {thinking && !reasoningUnavailable ? (
        <label className="check">
          <input
            type="checkbox"
            checked={config.disableReasoning}
            onChange={(event) => onChange(slotId, { disableReasoning: event.target.checked })}
            disabled={disabled}
          />
          <span>
            Disable reasoning for this slot
            <em className="hint">Sends chat_template_kwargs {'{'}enable_thinking:false{'}'}. Only this slot gets it.</em>
          </span>
        </label>
      ) : (
        !reasoningUnavailable && (
          <p className="hint">
            No thinking toggle here: chat_template_kwargs is only sent to Particle.ai on a deepseek-* model, and this slot is{' '}
            {preset.label} / {config.model || 'no model yet'}.
          </p>
        )
      )}
    </article>
  );
}