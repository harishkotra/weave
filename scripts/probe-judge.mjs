#!/usr/bin/env node
/**
 * Probe: which local models can actually answer the judge prompts with JSON?
 * This is a capability check on models, not app data — the app never uses
 * anything from this file. Run it before picking a judge slot.
 */
const BASE = process.env.WEAVE_BASE ?? 'http://127.0.0.1:1234/v1';
const MODELS = (process.env.PROBE_MODELS ?? 'zai-org/glm-4.7-flash,openai/gpt-oss-20b,google/gemma-4-e4b,meta/muse-glimmer,ornith-1.0-35b,qwen/qwen3.5-9b').split(',');

const CLASSIFY = `Two models answered the same question. Below are their atomic claims, indexed.

MODEL A CLAIMS:
0. AI code should be reviewed like any other code.
1. Blanket bans are impractical.
2. The real risk is unreviewed code reaching production.
3. Teams should require human sign-off.

MODEL B CLAIMS:
0. Companies should ban unreviewed AI-generated code from production.
1. Human review of AI output is mandatory.
2. Bans are hard to enforce.

For every cross-model pair of claims that is related, output an entry. Return JSON of exactly this shape:
{"pairs":[{"a":<index in MODEL A>,"b":<index in MODEL B>,"relation":"agree"|"contradict","strength":<0..1>}]}
Only include pairs that are genuinely related. Cap the pairs at 30. If there are no relations, return {"pairs":[]}. No commentary.

[run-nonce: probe1]`;

const EXTRACT = `Split the following answer into atomic claims. Return JSON array of strings, max 12 items. No commentary.

ANSWER FROM MODEL A:
"""
AI code should be reviewed like any other code. Blanket bans are impractical because AI assistance is already embedded in IDEs. The real risk is unreviewed code reaching production. Teams should require tests and human sign-off.
"""

[run-nonce: probe2]`;

function looksLikeJson(text) {
  const body = text.replace(/```[a-z]*/gi, '').trim();
  const start = Math.min(...[body.indexOf('['), body.indexOf('{')].filter((index) => index >= 0));
  if (!Number.isFinite(start)) return false;
  try {
    JSON.parse(body.slice(start, Math.max(body.lastIndexOf(']'), body.lastIndexOf('}')) + 1));
    return true;
  } catch {
    return false;
  }
}

async function probe(model, prompt, label) {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a strict JSON API. Output only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0,
        max_tokens: 2000,
        stream: false,
      }),
      signal: AbortSignal.timeout(600_000),
    });
    const payload = await response.json();
    const choice = payload.choices?.[0] ?? {};
    const content = choice.message?.content ?? '';
    const usage = payload.usage ?? {};
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    const ok = content.trim().length > 0 && looksLikeJson(content);
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(9)} ${model.padEnd(24)} ${((Date.now() - started) / 1000).toFixed(0)}s ` +
        `finish=${choice.finish_reason} content=${content.length}ch reasoning=${reasoning ?? 'n/a'} ${ok ? '' : JSON.stringify(content.slice(0, 90))}`,
    );
    return ok;
  } catch (error) {
    console.log(`ERR  ${label.padEnd(9)} ${model.padEnd(24)} ${error.message}`);
    return false;
  }
}

for (const model of MODELS) {
  await probe(model, EXTRACT, 'extract');
  await probe(model, CLASSIFY, 'classify');
}