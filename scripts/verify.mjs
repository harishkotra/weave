#!/usr/bin/env node
/**
 * Weave verification. Runs the app's own HTTP API and checks the data, not the UI.
 *
 *   node scripts/verify.mjs control   # A and B on the SAME model  -> overlap should be high
 *   node scripts/verify.mjs cross     # A older, B newer           -> overlap should drop
 *   node scripts/verify.mjs all
 *
 * Override the models for your own providers:
 *   WEAVE_BASE=http://127.0.0.1:1234/v1 WEAVE_A_MODEL=... WEAVE_B_MODEL=... WEAVE_JUDGE_MODEL=... node scripts/verify.mjs all
 *   WEAVE_PROVIDER=particle WEAVE_API_KEY=... WEAVE_BASE=https://api.particle.ai/v1 ...
 *
 * No key is stored here. The key only ever travels from this process to the
 * local Weave backend, which is the only thing that talks to a provider.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.WEAVE_API ?? 'http://127.0.0.1:3001';
const PROVIDER = process.env.WEAVE_PROVIDER ?? 'lmstudio';
const BASE = process.env.WEAVE_BASE ?? 'http://127.0.0.1:1234/v1';
const API_KEY = process.env.WEAVE_API_KEY ?? '';
const QUESTION = process.env.WEAVE_QUESTION ?? 'Should companies ban AI-generated code from production?';
const A_MODEL = process.env.WEAVE_A_MODEL ?? 'openai/gpt-oss-20b';
const B_MODEL = process.env.WEAVE_B_MODEL ?? 'google/gemma-4-e4b';
const JUDGE_MODEL = process.env.WEAVE_JUDGE_MODEL ?? 'openai/gpt-oss-20b';
const OUT_DIR = 'verify-output';

const slot = (model, disableReasoning = false) => ({ provider: PROVIDER, baseUrl: BASE, apiKey: API_KEY, model, disableReasoning });

function configFor(kind) {
  const temperature = kind === 'control0' ? 0 : 0.7;
  const shared = { temperature, maxTokens: 1600 };
  // control0: same model in both slots at temperature 0 — the deterministic control.
  // control:  same model in both slots, sampled — the same model twice, not once.
  // cross:    A older, B newer.
  if (kind === 'control' || kind === 'control0') {
    return { ...shared, slots: { a: slot(A_MODEL), b: slot(A_MODEL), judge: slot(JUDGE_MODEL) } };
  }
  return { ...shared, slots: { a: slot(A_MODEL), b: slot(B_MODEL), judge: slot(JUDGE_MODEL) } };
}

async function weave(kind) {
  const started = Date.now();
  const response = await fetch(`${API}/api/weave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ question: QUESTION, config: configFor(kind) }),
  });
  if (!response.ok || !response.body) throw new Error(`backend returned HTTP ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  const stages = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim();
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === 'progress') {
        const stamp = `${((Date.now() - started) / 1000).toFixed(1)}s`;
        stages.push(`${payload.stage} (${stamp})`);
        console.log(`    [${stamp}] ${payload.stage}${payload.detail ? ` — ${payload.detail}` : ''}`);
      }
      if (event === 'result') result = payload;
      if (event === 'error') throw new Error(`${payload.message}${payload.detail ? ` | ${payload.detail}` : ''}`);
    }
  }
  if (!result) throw new Error('no result event');
  return { result, stages, wallMs: Date.now() - started };
}

/** Every key in the payload that could carry hidden chain-of-thought text. */
function findReasoningLeaks(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findReasoningLeaks(entry, `${path}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (/reasoning_content|reasoning_details|chain_of_thought|thinking|thoughts/i.test(key)) found.push(`${path}.${key}`);
      // reasoningTokens / reasoningReported are counts and capability flags, allowed.
      if (key === 'reasoning' && typeof entry === 'string') found.push(`${path}.${key} (string)`);
      findReasoningLeaks(entry, `${path}.${key}`, found);
    }
  }
  return found;
}

function check(result) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const claimsA = result.models.a.claims.length;
  const claimsB = result.models.b.claims.length;
  const nodesA = result.panels.a.nodes.length;
  const nodesB = result.panels.b.nodes.length;
  add('panel A nodes == judge claims for A', nodesA === claimsA, `${nodesA} nodes / ${claimsA} claims`);
  add('panel B nodes == judge claims for B', nodesB === claimsB, `${nodesB} nodes / ${claimsB} claims`);

  const expectedBoth = result.consensus.sharedPairs + result.consensus.aOnly + result.consensus.bOnly;
  add('Both panel nodes == shared + A-only + B-only', result.panels.both.nodes.length === expectedBoth, `${result.panels.both.nodes.length} / ${expectedBoth}`);

  const recomputed =
    expectedBoth === 0 ? 0 : Number(((result.consensus.sharedPairs / expectedBoth) * 100).toFixed(1));
  add(
    'consensus % recomputes from node overlap',
    Math.abs(recomputed - result.consensus.consensusByNodes) < 0.11,
    `reported ${result.consensus.consensusByNodes} / recomputed ${recomputed}`,
  );

  const allEdges = [...result.panels.both.edges];
  const nodeIds = new Set(result.panels.both.nodes.map((node) => node.id));
  add(
    'every edge endpoint exists as a node',
    allEdges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    `${allEdges.length} edges over ${nodeIds.size} nodes`,
  );
  add(
    'every edge carries a source label',
    allEdges.every((edge) => edge.source_kind === 'judge' || edge.source_kind === 'lexical'),
    [...new Set(allEdges.map((edge) => edge.source_kind))].join(', ') || 'no edges',
  );

  const leaks = findReasoningLeaks(result);
  add('no reasoning text anywhere in the payload', leaks.length === 0, leaks.length ? leaks.join(', ') : 'clean');

  add(
    'prompt nonces: zero reuse',
    result.promptReuse.duplicates === 0 && result.promptReuse.uniquePrompts === result.promptReuse.promptsSent,
    `${result.promptReuse.uniquePrompts}/${result.promptReuse.promptsSent} unique, ${result.promptReuse.duplicates} duplicates, nonce ${result.promptReuse.nonce}`,
  );

  add(
    'reasoning tokens read from usage or n/a',
    [result.models.a, result.models.b].every((run) => run.reasoningTokens === null || Number.isFinite(run.reasoningTokens)),
    `A ${result.models.a.reasoningReported ? result.models.a.reasoningTokens : 'n/a'} · B ${result.models.b.reasoningReported ? result.models.b.reasoningTokens : 'n/a'}`,
  );

  add(
    'no API key in the payload',
    !JSON.stringify(result).includes(API_KEY || '\u0000never'),
    'apiKey fields report provided/none only',
  );

  add(
    'judge output parsed',
    result.judge.parseMode !== 'fallback-lexical',
    `parseMode ${result.judge.parseMode}`,
  );

  return checks;
}

function line(label, value) {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

function report(kind, run, checks) {
  const { result, wallMs, stages } = run;
  console.log(`\n=== ${kind.toUpperCase()} RUN — ${result.models.a.model} vs ${result.models.b.model} (judge ${result.judge.model})`);
  line('temperature', String(result.config.temperature));
  line('wall time', `${(wallMs / 1000).toFixed(1)}s`);
  line('stages', stages.join(' -> '));
  line('claims', `A ${result.models.a.claims.length} · B ${result.models.b.claims.length}`);
  line('shared / A-only / B-only', `${result.consensus.sharedPairs} / ${result.consensus.aOnly} / ${result.consensus.bOnly}`);
  line('consensus (nodes)', `${result.consensus.consensusByNodes}% (${result.consensus.sharedPairs}/${result.consensus.totalNodes} claim-nodes)`);
  line('claims linked across', `${result.consensus.participationByNodes}% (${result.consensus.linkedClaims} claims)`);
  line('consensus (text)', `${result.consensus.consensusByText}%`);
  line('judge pairs', `${result.consensus.agreeCount} agree · ${result.consensus.contradictionCount} contradict · mean contradiction ${result.consensus.meanContradictionStrength}`);
  line('edges drawn / absorbed', `${result.consensus.drawnEdges} drawn · ${result.consensus.absorbedIntoCore} agree pairs became the core`);
  line('parse mode', result.judge.parseMode);
  line('reasoning tokens', `A ${result.models.a.reasoningReported ? result.models.a.reasoningTokens : 'n/a'} · B ${result.models.b.reasoningReported ? result.models.b.reasoningTokens : 'n/a'}`);
  line('answer sha256', `A ${result.models.a.sha256.slice(0, 12)} · B ${result.models.b.sha256.slice(0, 12)}`);
  line('nonce', `${result.promptReuse.nonce} (${result.promptReuse.uniquePrompts} unique prompts, ${result.promptReuse.duplicates} duplicates)`);
  for (const check of checks) console.log(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name} — ${check.detail}`);
  if (result.warnings.length) {
    console.log('  warnings:');
    for (const warning of result.warnings) console.log(`    - ${warning}`);
  }
  return checks.every((check) => check.ok);
}

const which = process.argv[2] ?? 'all';
const kinds = which === 'all' ? ['control0', 'control', 'cross'] : [which];
const REPEAT = Math.max(1, Number(process.env.WEAVE_REPEAT ?? 1));

mkdirSync(OUT_DIR, { recursive: true });
const runs = {};
let allPassed = true;

for (let pass = 1; pass <= REPEAT; pass += 1) {
  for (const kind of kinds) {
    console.log(`\n>>> running ${kind}${REPEAT > 1 ? ` (pass ${pass}/${REPEAT})` : ''} …`);
    try {
      const run = await weave(kind);
      runs[kind] = runs[kind] ?? [];
      runs[kind].push(run.result);
      writeFileSync(join(OUT_DIR, REPEAT > 1 ? `${kind}-${pass}.json` : `${kind}.json`), JSON.stringify(run.result, null, 2));
      const passed = report(kind, run, check(run.result));
      allPassed = allPassed && passed;
    } catch (error) {
      console.error(`  [FAIL] ${kind} run threw: ${error.message}`);
      allPassed = false;
    }
  }
}

const summarise = (kind) => {
  const list = runs[kind];
  if (!list || list.length === 0) return null;
  const nodes = list.map((run) => run.consensus.consensusByNodes);
  const linked = list.map((run) => run.consensus.participationByNodes);
  const unique = list.map((run) => run.consensus.aOnly + run.consensus.bOnly);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    runs: list.length,
    consensus: mean(nodes),
    consensusRange: [Math.min(...nodes), Math.max(...nodes)],
    linked: mean(linked),
    unique: mean(unique),
  };
};

const baseline = summarise('control0') ?? summarise('control');
const crossSummary = summarise('cross');
if (baseline && crossSummary) {
  console.log(`\n=== CONTROL vs CROSS${REPEAT > 1 ? ` (mean of ${REPEAT} runs each)` : ''}`);
  for (const [label, summary] of [
    ['same model, temp 0', summarise('control0')],
    ['same model, sampled', summarise('control')],
    ['two models', crossSummary],
  ]) {
    if (!summary) continue;
    line(label, `${summary.consensus.toFixed(1)}% consensus (range ${summary.consensusRange.join('–')}) · ${summary.linked.toFixed(1)}% claims linked · ${summary.unique.toFixed(1)} unique`);
  }
  const differs = Math.abs(crossSummary.consensus - baseline.consensus) > 0.05;
  const drops = crossSummary.consensus < baseline.consensus;
  const ringsGrow = crossSummary.unique > baseline.unique;
  // A local judge will not link every claim; what matters is that the same model
  // twice links at least as much as two different models.
  const nearTotal = baseline.linked >= crossSummary.linked;
  console.log(`  [${differs ? 'PASS' : 'FAIL'}] the two conditions differ`);
  console.log(`  [${drops ? 'PASS' : 'WARN'}] two models overlap less than the same model twice`);
  console.log(`  [${ringsGrow ? 'PASS' : 'WARN'}] unique rings are larger with two models`);
  console.log(
    `  [${nearTotal ? 'PASS' : 'WARN'}] the same-model control links at least as many claims as two different models ` +
      `(${baseline.linked.toFixed(1)}% linked vs ${crossSummary.linked.toFixed(1)}%)`,
  );
  if (!differs) allPassed = false;
}

console.log(`\n${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} — raw results in ${OUT_DIR}/`);
process.exit(allPassed ? 0 : 1);