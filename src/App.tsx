import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MIN_MAX_TOKENS,
  QUESTION_PRESETS,
  SLOT_META,
  getPreset,
  supportsThinkingFlag,
  type SlotConfig,
  type SlotId,
  type WeaveConfig,
} from '../shared/providers';
import type { ModelListResponse, Stage, WeaveResult } from '../shared/types';
import { loadConfig, resetConfig, saveConfig } from './lib/config';
import { WeaveError, fetchModels, streamWeave } from './lib/api';
import { GraphPanel } from './components/GraphPanel';
import { SlotCard, type ReasoningReading } from './components/SlotCard';
import { copyText, downloadShareCardPng, slug, type PanelSnapshot } from './lib/export';

const STAGE_COPY: Record<Stage, { label: string; detail: string }> = {
  idle: { label: 'Ready', detail: 'Pick a question and run the weave.' },
  asking: { label: 'Asking both models', detail: 'Model A and Model B got the identical question, in parallel.' },
  extracting: { label: 'Extracting claims', detail: 'The judge is splitting both answers into atomic claims.' },
  classifying: { label: 'Classifying edges', detail: 'The judge is marking each related cross-model pair agree or contradict.' },
  simulating: { label: 'Weaving the graph', detail: 'Force layout running on real claims.' },
  settled: { label: 'Settled', detail: 'Force layout settled.' },
  error: { label: 'Run failed', detail: 'The provider said why. Nothing was invented to fill the gap.' },
};

const WORKING: Stage[] = ['asking', 'extracting', 'classifying', 'simulating'];

function useCountUp(value: number, duration = 900): number {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(value);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const from = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - t) ** 3;
      setShown(from + (value - from) * eased);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return shown;
}

export default function App() {
  const [config, setConfig] = useState<WeaveConfig>(() => loadConfig());
  const [question, setQuestion] = useState(QUESTION_PRESETS[0]);
  const [stage, setStage] = useState<Stage>('idle');
  const [detail, setDetail] = useState<string>(STAGE_COPY.idle.detail);
  const [result, setResult] = useState<WeaveResult | null>(null);
  const [failure, setFailure] = useState<WeaveError | null>(null);
  const [models, setModels] = useState<Record<SlotId, ModelListResponse | null>>({ a: null, b: null, judge: null });
  const [showConfig, setShowConfig] = useState(true);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const [exportNote, setExportNote] = useState('');

  const snapshots = useRef<Partial<Record<'a' | 'b' | 'both', PanelSnapshot>>>({});
  const settled = useRef<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  // Dev-only hook so browser verification can compare what is on screen with the
  // run that produced it. Not present in a production build.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __weaveResult?: WeaveResult | null }).__weaveResult = result;
  }, [result]);

  const working = WORKING.includes(stage);

  const patchSlot = useCallback((slotId: SlotId, patch: Partial<SlotConfig>) => {
    setConfig((current) => ({ ...current, slots: { ...current.slots, [slotId]: { ...current.slots[slotId], ...patch } } }));
  }, []);

  const loadModels = useCallback(
    async (slotId: SlotId, slot?: SlotConfig) => {
      setModels((current) => ({ ...current, [slotId]: null }));
      const response = await fetchModels(slot ?? config.slots[slotId]);
      setModels((current) => ({ ...current, [slotId]: response }));
    },
    [config.slots],
  );

  // Local providers are usually already running; fetch their list on mount so the
  // picker is populated without a click. A failure here never blocks a run.
  useEffect(() => {
    const initial = loadConfig();
    (['a', 'b', 'judge'] as SlotId[]).forEach((slotId) => {
      const preset = getPreset(initial.slots[slotId].provider);
      if (preset.local) void loadModels(slotId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    snapshots.current = {};
    settled.current = new Set();
    setFailure(null);
    setResult(null);
    setExportNote('');
    setCopied('idle');
    setStage('asking');
    setDetail(STAGE_COPY.asking.detail);
    try {
      const value = await streamWeave({
        question,
        config,
        signal: controller.signal,
        onProgress: (event) => {
          setStage(event.stage);
          setDetail(event.detail ?? STAGE_COPY[event.stage].detail);
        },
      });
      setResult(value);
      setStage('simulating');
      setDetail(STAGE_COPY.simulating.detail);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setFailure(error instanceof WeaveError ? error : new WeaveError({ message: (error as Error).message }));
      setStage('error');
      setDetail(STAGE_COPY.error.detail);
    }
  }, [config, question]);

  const onSettled = useCallback((panelId: 'a' | 'b' | 'both') => {
    settled.current.add(panelId);
    if (settled.current.size >= 3) {
      setStage('settled');
      setDetail(STAGE_COPY.settled.detail);
    }
  }, []);

  const onSnapshot = useCallback((panelId: 'a' | 'b' | 'both', snapshot: PanelSnapshot) => {
    snapshots.current[panelId] = snapshot;
  }, []);

  const reasoningFor = (slotId: SlotId): ReasoningReading | null => {
    if (!result) return null;
    if (slotId === 'a') return { tokens: result.models.a.reasoningTokens, reported: result.models.a.reasoningReported, model: result.models.a.model };
    if (slotId === 'b') return { tokens: result.models.b.reasoningTokens, reported: result.models.b.reasoningReported, model: result.models.b.model };
    return {
      tokens: result.judge.classify.reasoningTokens ?? result.judge.extract.a.reasoningTokens,
      reported: result.judge.classify.reasoningReported || result.judge.extract.a.reasoningReported,
      model: result.judge.model,
    };
  };

  const anyThinking = (['a', 'b', 'judge'] as SlotId[]).some((slotId) => supportsThinkingFlag(config.slots[slotId]));

  const consensusShown = useCountUp(result?.consensus.consensusByNodes ?? 0);
  const consensus = result?.consensus;

  const answerCopy = useMemo(() => (result ? JSON.stringify(result, null, 2) : ''), [result]);

  const stem = result ? slug(result.question, 40) : 'weave';

  const nodeCheck = useMemo(() => {
    if (!result) return null;
    return {
      a: { nodes: result.panels.a.nodes.length, claims: result.models.a.claims.length },
      b: { nodes: result.panels.b.nodes.length, claims: result.models.b.claims.length },
    };
  }, [result]);

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <svg className="loom" viewBox="0 0 28 28" aria-hidden="true">
            <path d="M5 2v24M14 2v24M23 2v24" stroke="var(--thread-a)" strokeWidth="1.3" />
            <path d="M2 5h24M2 14h24M2 23h24" stroke="var(--thread-b)" strokeWidth="1.3" />
            <circle cx="14" cy="14" r="4.2" fill="var(--core)" />
          </svg>
          <span className="wordmark">WEAVE</span>
          <p className="tagline">Ask two models the same question. See what shape the reasoning takes.</p>
        </div>
        <div className="masthead-right">
          <div className={`status status-${stage}`} aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            <span className="status-label">{STAGE_COPY[stage].label}</span>
            <span className="status-detail">{detail}</span>
          </div>
          <div className="run-row">
            <button type="button" className="primary" onClick={run} disabled={working}>
              {working ? 'Weaving…' : result ? 'Run again' : 'Run the weave'}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!result}
              onClick={async () => {
                const ok = await copyText(answerCopy);
                setCopied(ok ? 'ok' : 'failed');
                window.setTimeout(() => setCopied('idle'), 2200);
              }}
            >
              {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy blocked' : 'Copy results as JSON'}
            </button>
          </div>
        </div>
      </header>

      <section className="ask">
        <label htmlFor="question" className="eyebrow">
          The question both models get
        </label>
        <div className="ask-row">
          <input
            id="question"
            type="text"
            value={question}
            placeholder="Ask something with a real disagreement in it"
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !working) void run();
            }}
            disabled={working}
          />
        </div>
        <div className="presets">
          {QUESTION_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`chip-button ${preset === question ? 'is-active' : ''}`}
              onClick={() => setQuestion(preset)}
              disabled={working}
            >
              {preset}
            </button>
          ))}
        </div>
      </section>

      <section className="config">
        <button type="button" className="section-toggle" onClick={() => setShowConfig((value) => !value)} aria-expanded={showConfig}>
          <span className="eyebrow">Model slots</span>
          <span className="mono dim">
            A {config.slots.a.model || '—'} · B {config.slots.b.model || '—'} · judge {config.slots.judge.model || '—'}
          </span>
          <span className="toggle-mark">{showConfig ? '−' : '+'}</span>
        </button>

        {showConfig && (
          <>
            <div className="slots">
              {(['a', 'b', 'judge'] as SlotId[]).map((slotId) => (
                <SlotCard
                  key={slotId}
                  slotId={slotId}
                  config={config.slots[slotId]}
                  reasoning={reasoningFor(slotId)}
                  models={models[slotId]}
                  onLoadModels={loadModels}
                  onChange={patchSlot}
                  disabled={working}
                />
              ))}
            </div>

            <div className="run-settings">
              <div className="field inline">
                <label htmlFor="temperature">Temperature</label>
                <input
                  id="temperature"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={config.temperature}
                  onChange={(event) => setConfig((current) => ({ ...current, temperature: Number(event.target.value) }))}
                  disabled={working}
                />
                <span className="hint">Judge runs at 0 regardless.</span>
              </div>
              <div className="field inline">
                <label htmlFor="max-tokens">Max tokens</label>
                <input
                  id="max-tokens"
                  type="number"
                  min={MIN_MAX_TOKENS}
                  max={8000}
                  step={100}
                  value={config.maxTokens}
                  onChange={(event) => setConfig((current) => ({ ...current, maxTokens: Number(event.target.value) }))}
                  disabled={working}
                />
                <span className="hint">Below {MIN_MAX_TOKENS} is raised automatically: reasoning models need a real budget.</span>
              </div>
              {anyThinking && (
                <p className="hint">
                  Each slot has its own <strong>Disable reasoning</strong> toggle, and it only appears where the flag can actually be
                  sent: Particle.ai on a deepseek-* model.
                </p>
              )}
              <button
                type="button"
                className="ghost tiny"
                onClick={() => {
                  const fresh = resetConfig();
                  setConfig(fresh);
                  setModels({ a: null, b: null, judge: null });
                }}
                disabled={working}
              >
                Reset slots to defaults
              </button>
            </div>
          </>
        )}
      </section>

      {failure && (
        <section className="banner" role="alert">
          <h2>{failure.message}</h2>
          {failure.detail && <p className="mono detail-text">{failure.detail}</p>}
          {failure.hint && <p className="hint">{failure.hint}</p>}
        </section>
      )}

      {result && consensus && (
        <section className="headline">
          <div className="headline-number">
            <span className="eyebrow">Share of the answer both models agreed on</span>
            <p className="big">
              <span className="num">{consensusShown.toFixed(0)}</span>
              <span className="pct">%</span>
            </p>
            <p className="headline-sub">
              {consensus.sharedPairs} shared claim{consensus.sharedPairs === 1 ? '' : 's'} of {consensus.totalNodes} claim-nodes ·{' '}
              {consensus.participationByNodes.toFixed(1)}% of all {consensus.totalNodes + consensus.sharedPairs} claims link across models ·{' '}
              {consensus.consensusByText.toFixed(1)}% by text volume
            </p>
          </div>
          <div className="headline-side">
            <div className="model-pair">
              <div className="pair-slot">
                <span className="eyebrow">Model A</span>
                <strong className="mono">{result.models.a.model}</strong>
                <span className="dim mono">{result.models.a.providerLabel}</span>
              </div>
              <span className="pair-arrow" aria-hidden="true">
                →
              </span>
              <div className="pair-slot">
                <span className="eyebrow">Model B</span>
                <strong className="mono">{result.models.b.model}</strong>
                <span className="dim mono">{result.models.b.providerLabel}</span>
              </div>
            </div>
            <dl className="headline-stats">
              <div>
                <dt>shared</dt>
                <dd className="num">{consensus.sharedPairs}</dd>
              </div>
              <div>
                <dt>A only</dt>
                <dd className="num thread-a">{consensus.aOnly}</dd>
              </div>
              <div>
                <dt>B only</dt>
                <dd className="num thread-b">{consensus.bOnly}</dd>
              </div>
              <div>
                <dt>contradictions</dt>
                <dd className="num contra">
                  {consensus.contradictionCount}
                  {consensus.contradictionCount > 0 && <em className="dim"> · mean {consensus.meanContradictionStrength.toFixed(2)}</em>}
                </dd>
              </div>
              <div>
                <dt>agree relations</dt>
                <dd className="num">
                  {consensus.agreeCount}
                  <em className="dim">
                    {consensus.absorbedIntoCore > 0
                      ? ` · ${consensus.absorbedIntoCore} became the core`
                      : ` · ${consensus.drawnEdges} drawn`}
                  </em>
                </dd>
              </div>
              <div>
                <dt>judge</dt>
                <dd className="num">
                  {result.judge.model}
                  <em className="dim"> · {result.judge.parseMode === 'fallback-lexical' ? 'fallback: lexical' : result.judge.parseMode}</em>
                </dd>
              </div>
              <div>
                <dt>run</dt>
                <dd className="num">{(result.totalMs / 1000).toFixed(1)}s</dd>
              </div>
            </dl>
          </div>
          <div className="consensus-bar" role="img" aria-label={`${consensus.sharedPairs} shared, ${consensus.aOnly} only A, ${consensus.bOnly} only B`}>
            <span
              className="bar-core"
              style={{ width: `${(consensus.sharedPairs / Math.max(1, consensus.totalNodes)) * 100}%` }}
            />
            <span className="bar-a" style={{ width: `${(consensus.aOnly / Math.max(1, consensus.totalNodes)) * 100}%` }} />
            <span className="bar-b" style={{ width: `${(consensus.bOnly / Math.max(1, consensus.totalNodes)) * 100}%` }} />
          </div>
        </section>
      )}

      <section className="panels">
        {result ? (
          <>
            <GraphPanel
              key={`a-${result.runId}`}
              panelId="a"
              eyebrow="Model A · the older model"
              title="A only"
              blurb="Its own claims, with the links the judge found into the other answer."
              data={result.panels.a}
              stage={stage}
              runKey={result.runId}
              height={430}
              fileStem={`${stem}-a-only`}
              caption={[`Weave · Model A only · ${result.models.a.model}`, `${result.panels.a.stats.claimCount} claims · ${result.panels.a.stats.uniqueCount} unique · overlap ${result.panels.a.stats.overlapPct}%`, result.question]}
              onSettled={onSettled}
              onSnapshot={onSnapshot}
              footer={<ModelFooter run={result.models.a} />}
            />
            <GraphPanel
              key={`b-${result.runId}`}
              panelId="b"
              eyebrow="Model B · the newer model"
              title="B only"
              blurb="Same question, same judge, its own set of claims."
              data={result.panels.b}
              stage={stage}
              runKey={result.runId}
              height={430}
              fileStem={`${stem}-b-only`}
              caption={[`Weave · Model B only · ${result.models.b.model}`, `${result.panels.b.stats.claimCount} claims · ${result.panels.b.stats.uniqueCount} unique · overlap ${result.panels.b.stats.overlapPct}%`, result.question]}
              onSettled={onSettled}
              onSnapshot={onSnapshot}
              footer={<ModelFooter run={result.models.b} />}
            />
            <GraphPanel
              key={`both-${result.runId}`}
              panelId="both"
              eyebrow="The overlap"
              title="Both"
              blurb="Shared claims pulled to the core. What only one model said pushed to the rings."
              data={result.panels.both}
              stage={stage}
              runKey={result.runId}
              height={430}
              fileStem={`${stem}-overlap`}
              caption={[
                `Weave · overlap · A ${result.models.a.model} vs B ${result.models.b.model}`,
                `${result.consensus.consensusByNodes}% consensus by node overlap · ${result.consensus.sharedPairs} shared · ${result.consensus.contradictionCount} contradictions`,
                result.question,
              ]}
              onSettled={onSettled}
              onSnapshot={onSnapshot}
              extraActions={
                <button
                  type="button"
                  className="ghost"
                  disabled={working}
                  onClick={async () => {
                    const snapshot = snapshots.current.both;
                    if (!snapshot) {
                      setExportNote('The overlap graph has not been placed yet. Let the layout settle, then export.');
                      return;
                    }
                    try {
                      await downloadShareCardPng(
                        {
                          question: result.question,
                          consensus: result.consensus,
                          both: snapshot,
                          modelA: result.models.a,
                          modelB: result.models.b,
                          judgeLabel: result.judge.providerLabel,
                          judgeModel: result.judge.model,
                          parseMode: result.judge.parseMode,
                        },
                        `${stem}-share-card.png`,
                      );
                      setExportNote('Share card written at 1080×1080.');
                    } catch (error) {
                      setExportNote((error as Error).message);
                    }
                  }}
                >
                  Share card PNG 1080
                </button>
              }
              footer={<OverlapFooter result={result} />}
            />
          </>
        ) : (
          <>
            <PlaceholderPanel title="A only" eyebrow="Model A · the older model" stage={stage} />
            <PlaceholderPanel title="B only" eyebrow="Model B · the newer model" stage={stage} />
            <PlaceholderPanel title="Both" eyebrow="The overlap" stage={stage} />
          </>
        )}
      </section>

      {exportNote && <p className="note mono">{exportNote}</p>}

      {result && (
        <section className="evidence">
          <h2 className="eyebrow">What this run can prove</h2>
          <ul>
            <li>
              Claims are judge output, not written here: {nodeCheck?.a.nodes} nodes on panel A for {nodeCheck?.a.claims} claims, {nodeCheck?.b.nodes} on
              panel B for {nodeCheck?.b.claims} claims.
              {nodeCheck && nodeCheck.a.nodes === nodeCheck.a.claims && nodeCheck.b.nodes === nodeCheck.b.claims
                ? ' Node count equals claim count on both sides.'
                : ' Node count does not match claim count — that is a bug, not a feature.'}
            </li>
            <li>
              Edges: {result.consensus.agreeCount} agree, {result.consensus.contradictionCount} contradict, from{' '}
              {result.judge.parseMode === 'fallback-lexical'
                ? 'the lexical fallback (Jaccard over token sets — not semantic)'
                : `the judge (${result.judge.model}), JSON parsed`}
              . {result.consensus.absorbedIntoCore} agree relation
              {result.consensus.absorbedIntoCore === 1 ? '' : 's'} became consensus nodes in the overlap view, so {result.consensus.drawnEdges}{' '}
              edge{result.consensus.drawnEdges === 1 ? '' : 's'} {result.consensus.drawnEdges === 1 ? 'is' : 'are'} drawn there. Raw pairs are in the
              copied JSON under <span className="mono">judge.pairs</span>.
            </li>
            <li>
              Consensus is measured from node overlap: {result.consensus.sharedPairs} matched pairs over {result.consensus.totalNodes} claim-nodes
              {' '}(strict one-to-one matching), {result.consensus.linkedClaims} claims linked across models
              {' '}({result.consensus.participationByNodes.toFixed(1)}% of all claims), and {result.consensus.consensusByText.toFixed(1)}% measured by
              characters of text.
            </li>
            <li>
              Reasoning tokens: A {result.models.a.reasoningReported ? `${result.models.a.reasoningTokens}` : 'n/a'} · B{' '}
              {result.models.b.reasoningReported ? `${result.models.b.reasoningTokens}` : 'n/a'} · judge{' '}
              {result.judge.classify.reasoningReported || result.judge.extract.a.reasoningReported
                ? `${result.judge.classify.reasoningTokens ?? result.judge.extract.a.reasoningTokens}`
                : 'n/a'}
              . Read from usage, or shown as n/a. Hidden chain-of-thought text is never logged, stored or displayed.
            </li>
            <li>
              Prompts sent {result.promptReuse.promptsSent}, unique {result.promptReuse.uniquePrompts}, duplicates {result.promptReuse.duplicates} — every
              prompt carried the run nonce <span className="mono">{result.promptReuse.nonce}</span>
              {result.promptReuse.questionBytesIdentical ? ', and A and B got byte-identical question text.' : '.'}
            </li>
            <li>
              Answer hashes: A <span className="mono">{result.models.a.sha256.slice(0, 12)}</span> · B{' '}
              <span className="mono">{result.models.b.sha256.slice(0, 12)}</span>. Copy results as JSON for the raw claims, edges and judge prompts.
            </li>
          </ul>
          {result.warnings.length > 0 && (
            <div className="warnings">
              <h3 className="eyebrow">Warnings from this run</h3>
              <ul>
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <footer className="footer">
        <span className="mono dim">
          D3 force layout · SVG · every model call goes through the backend on 3001 · keys live in this browser only
        </span>
      </footer>
    </div>
  );
}

function ModelFooter({ run }: { run: WeaveResult['models']['a'] }) {
  return (
    <p className="mono model-foot">
      <span className="dim">{run.providerLabel}</span> {run.model} · {(run.latencyMs / 1000).toFixed(1)}s ·{' '}
      {run.promptTokens ?? 'n/a'} in / {run.completionTokens ?? 'n/a'} out · reasoning{' '}
      {run.reasoningReported ? run.reasoningTokens : 'n/a'}
      {run.retriedForEmptyContent ? ' · retried for empty content' : ''} · sha256 {run.sha256.slice(0, 12)}
    </p>
  );
}

function OverlapFooter({ result }: { result: WeaveResult }) {
  return (
    <p className="mono model-foot">
      <span className="dim">judge</span> {result.judge.model} ·{' '}
      {result.judge.parseMode === 'fallback-lexical' ? 'fallback: lexical' : result.judge.parseMode} · extract{' '}
      {(result.judge.extract.a.latencyMs / 1000).toFixed(1)}s + {(result.judge.extract.b.latencyMs / 1000).toFixed(1)}s · classify{' '}
      {(result.judge.classify.latencyMs / 1000).toFixed(1)}s · reasoning{' '}
      {result.judge.classify.reasoningReported || result.judge.extract.a.reasoningReported ? result.judge.classify.reasoningTokens ?? 'n/a' : 'n/a'}
    </p>
  );
}

function PlaceholderPanel({ title, eyebrow, stage }: { title: string; eyebrow: string; stage: Stage }) {
  return (
    <section className="panel panel-empty">
      <header className="panel-head">
        <div className="panel-titles">
          <span className="eyebrow">{eyebrow}</span>
          <h3>{title}</h3>
        </div>
      </header>
      <div className="empty">
        {stage === 'idle' ? (
          <>
            <p>Nothing woven yet.</p>
            <p className="hint">Press Run the weave. Both models get the same question at the same moment.</p>
          </>
        ) : (
          <>
            <p className="mono">{STAGE_COPY[stage].label}…</p>
            <p className="hint">{STAGE_COPY[stage].detail}</p>
          </>
        )}
      </div>
    </section>
  );
}

export { SLOT_META };