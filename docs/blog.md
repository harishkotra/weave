# Weave: turning two models' answers into one claim graph

Ask two models the same open question and you get two walls of prose that are nearly impossible to compare by eye. Weave refuses to compare prose at all. A third model — the judge — decomposes each answer into atomic claims and classifies the relations between the two lists, and the result renders as three force-directed graphs: A, B, and the overlap, where a white consensus core is ringed by the claims only one model made. The interesting engineering is not the visual. It is that every node traces back to a string a model actually returned, that the app degrades *visibly* when the judge misbehaves, and that the headline number recomputes from the raw counts.

## The idea, precisely

- **Input:** one question, three slots (A, B, judge), each with its own provider, base URL, key and model.
- **A and B** answer concurrently, with byte-identical prompts.
- **The judge** does two jobs: EXTRACT (each answer → ≤12 claims) and CLASSIFY (each related cross-model pair → `agree` or `contradict` plus a 0–1 strength).
- **The graph:** one node per claim, radius `sqrt(claim length)`. Solid grey edges for agree, dashed red for contradict, thickness proportional to strength.
- **Three views:** A, B, and the overlap, where matched pairs merge into one node and unmatched claims become outer-ring satellites.

## Architecture

```text
 browser (5173) backend (3001) providers
 ────────────── ────────────── ─────────
 POST /api/weave ────────────▶ runWeave()
 { question, config } ├─ validate 3 slots (key/baseUrl/model)
 SSE over fetch reader ├─ nonce = makeNonce() ← one per run
 ├─ A ∥ B ───────────────────────▶ /chat/completions
 │◀─────────────────────────────── answer, usage, finish_reason
 ├─ EXTRACT A ∥ B ───────────────▶ /chat/completions (judge)
 ├─ CLASSIFY ────────────────────▶ /chat/completions (judge)
 ├─ buildGraph(): match → project → merge
 └─ SSE
 ◀── event: progress (asking → extracting → classifying)
 ◀── event: result (panels, consensus, prompts, hashes, warnings)
```

The browser never talks to a provider: local servers work with no CORS setup, keys stay out of the client bundle, and three vendors' quirks live in one place. SSE runs over `POST`, because `EventSource` cannot send a request body.

| File | Job |
| --- | --- |
| `shared/providers.ts`, `shared/types.ts` | presets, defaults, capability rule, limits, wire contract |
| `server/index.ts` | Express, `/api/health`, `/api/models`, SSE `/api/weave` |
| `server/providers.ts` | the only place `fetch` is called: capability detection, CoT stripping, retries |
| `server/judge.ts`, `server/graph.ts` | judge prompts, coercion, lexical fallback, maximum matching, projection |
| `server/weave.ts` | the run: concurrency, nonce, prompt-reuse check, result assembly |
| `src/App.tsx`, `src/components/GraphPanel.tsx` | stage machine, config panel, headline, d3-force panels |
| `scripts/verify.mjs`, `scripts/shots.py` | data verification and browser verification |

## The pipeline, stage by stage

### 1. Ask: identical bytes, one nonce per run

```ts
// server/weave.ts
  const nonce = makeNonce();
  // The question bytes sent to A and B are identical. The nonce is per run, not
  // per model, so the comparison stays fair while repeated runs cannot be cached.
  const questionPrompt = `${question}\n\n[run-nonce: ${nonce}]`;
  const questionPrompt = `${question}\n\n[run-nonce: ${nonce}]`;
  progress('asking', 'Model A and Model B answering the same question in parallel');
  const [answeredA, answeredB] = await Promise.all([answer('a'), answer('b')]);
```

A per-run nonce defends against a provider-side cache faking determinism. Because A and B share question bytes *on purpose*, their prompt hashes are role-prefixed (`A|…`, `B|…`).

### 2. Extract, and 3. Classify

```ts
// server/judge.ts
    'Split the following answer into atomic claims. Return JSON array of strings, max 12 items. No commentary.',
    `ANSWER FROM MODEL ${modelLabel}:`,
    '"""',
    answer,
    '"""',
```

The `modelLabel` does double duty: it says which answer the judge is reading, and it guarantees the two extract prompts are never byte-identical. Both extractions run concurrently. Classification is one call over both lists, asking for `{"pairs":[{"a":<index in MODEL A>,"b":<index in MODEL B>,"relation":"agree"|"contradict","strength":<0..1>}]}`, capped at 30, with an empty array explicitly allowed — no relations is a result, not a failure.

Judge temperature is 0, `max_tokens` 2000 (A and B get 1600), and the system prompt is the whole contract: `You are a strict JSON API. Output only valid JSON.`

## The judge is a JSON API, not a chatbot

Local models fence their JSON, prefix it with "Sure! Here is the JSON:", use smart quotes, leave trailing commas, and write Python literals. A strict `JSON.parse` throws on all of that, so a good answer can get labelled a fallback. Parsing is a ladder: as-is; a repaired copy (smart quotes, `True/False/None`, trailing commas, full-width punctuation); a single-quote pass — each also tried through `sliceBalanced`, which walks from the first `[` or `{` to its matching close, ignoring brackets inside strings.

Parsed values are *coerced*, not trusted. `coerceClaims` accepts an array or an object keyed by `claims`/`items`/`list`, unwraps `{claim: "..."}` objects, strips bullet markers, dedupes and caps at 12. `coercePairs` accepts `a`/`a_index`/`source`/`from`/`i` as the left index, normalises relations through regexes (so `"contradicts"` and `"disagrees"` both land) and drops out-of-range indices.

The ladder has three rungs: use what parsed; retry once with a fresh sample (`parseMode: "json-retry"`); else fall back to lexical similarity and label it. That fallback is Jaccard over stopword-filtered token sets at threshold 0.32, plus a negation check — two similar claims where only one contains a negation word become `contradict` above 0.45 similarity. A judge call that throws does not kill the run either: `extractClaims` and `classifyPairs` catch `ProviderError` and return the fallback plus a `failure` field. The result carries `parseMode: "fallback-lexical"`, affected edges carry `source_kind: "lexical"`, and the UI says so. A lexical edge never masquerades as a semantic one.

## Consensus is a maximum bipartite matching

One claim can agree with several on the other side, and the naive implementation — sort all `agree` pairs by strength and take them greedily — makes the headline depend on the order the judge listed pairs in. That is not a measurement, it is an artifact. My first version did exactly that and reported 50% on a run where the judge had returned 12 agree relations over two 12-claim lists.

Kuhn's algorithm fixes it:

```ts
// server/graph.ts
  const assign = (a: number, visited: Set<number>): boolean => {
    for (const b of adjacency.get(a) ?? []) {
      if (visited.has(b)) continue;
      visited.add(b);
      const holder = bToA.get(b);
      if (holder === undefined || assign(holder, visited)) {
        bToA.set(b, a);
        aToB.set(a, b);
        return true;
      }
    }
    return false;
  };

  for (const a of [...adjacency.keys()].sort((x, y) => x - y)) assign(a, new Set<number>());
```

Each claim's candidate list is sorted by judge strength, then lexical Jaccard, then index — so among maximum matchings the result is deterministic and prefers the strongest relations. Contradictions never form consensus. Re-running the control case greedy scored at 50% gave 71.4%: the difference between measuring the judge's output and the order of it.

The matching is deliberately strict — each claim counted once — so it *under*-reports when extraction granularity differs. The result therefore reports two readings: `consensusByNodes` = `sharedPairs / (sharedPairs + aOnly + bOnly)`, the headline; and `participationByNodes`, the share of claims the judge linked at all.

## Three panels, and the merge that eats edges

Panels A and B cannot draw cross-model edges: those endpoints are not in the panel. They draw the **bipartite projection**: two of A's claims linked to the same B claim are related to each other — agreeing when they share a relation, opposed when they don't — at the weaker strength.

On the **Both** panel a matched pair becomes one consensus node carrying both phrasings, which has a consequence I initially got wrong: an `agree` relation between two claims that got merged now points from a node to itself. A self-loop is not something you can draw, and not something you can drop either — it *is* the core, so `buildGraph` counts it as `absorbedIntoCore` and never draws it. Hence the stats separate `agreeCount` (what the judge returned), `absorbedIntoCore` (relations that became consensus nodes) and `drawnEdges` (what is on screen). Before that split, a run showed "0 agree edges" on a panel with 12 shared pairs — a reporting bug that looked like a rendering bug.

Layout is d3-force on SVG. Shared nodes are pulled hard to the centre — three times the charge and 20× the centering of a unique claim — while unique claims are pushed to a ring.

```ts
// src/components/GraphPanel.tsx
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((node) => node.id)
          .distance(isBoth ? 74 : 104)
          .strength(0.22),
      )
      .force('collide', forceCollide<SimNode>().radius((node) => node.radius + 5).iterations(2))
      // Stronger centering on consensus nodes, almost none on the unique rings:
      // this is what makes the "Both" panel readable at a glance.
      .force('x', forceX<SimNode>(cx).strength(isBoth ? (node) => (node.shared ? 0.3 : 0.015) : 0.05))
      .force('y', forceY<SimNode>(cy).strength(isBoth ? (node) => (node.shared ? 0.3 : 0.015) : 0.05))
      .force(
        'radial',
        forceRadial<SimNode>(outerRadius, cx, cy).strength(isBoth ? (node: SimNode) => (node.shared ? 0 : 0.4) : 0),
      )
      .alphaDecay(0.035)
      .stop();
```

The simulation runs on d3's own timer, `on('tick')` driving the settle progress bar and `on('end')` settling the panel; `prefers-reduced-motion` runs 320 ticks synchronously. Positions are clamped to the panel each render, and labels are placed greedily — biggest and shared first — hiding collisions until you hover.

## Capability detection without assumptions

Three rules, all detect-don't-assume. The thinking flag is gated on provider *and* model:

```ts
// shared/providers.ts
export function supportsThinkingFlag(slot: SlotConfig): boolean {
  return slot.provider === 'particle' && slot.model.trim().toLowerCase().startsWith('deepseek-');
}
```

`chat_template_kwargs: {enable_thinking: false}` is sent only when both hold. The toggle is per slot and renders only where the flag can be sent. Second, reasoning tokens are read, never invented: `usage.completion_tokens_details.reasoning_tokens`, falling back to a top-level `usage.reasoning_tokens`. Absent means `null` → `n/a`, never `0`.

Third, hidden chain-of-thought is destroyed at the edge. `stripReasoning` reads `message.content` first, then `delete`s every key in `REASONING_KEYS` — `reasoning_content`, `reasoning`, `reasoning_details`, `thinking`, `chain_of_thought`, `analysis`, `thoughts` — so nothing downstream can see them. Only the token *count* leaves that function.

HTTP 200 with empty content is not a refusal: it is hidden reasoning eating the budget, so the first empty response doubles `max_tokens` and retries once, capped at 4000; a second is a real error. A local judge spent 3997 of 4000 tokens on reasoning and returned nothing.

## SSE over POST, and the bug that ate every stage

The staged UI (asking → extracting → classifying → weaving → settled) is only honest if the stages are real server events, so `/api/weave` streams SSE frames as the run progresses, with keepalive comments every 15 seconds so an idle connection survives a proxy or `fetch` body timeout.

The bug: I detected disconnects with `req.on('close')`.

```ts
// server/index.ts
  // Watch the RESPONSE for the disconnect, never the request: on Node 16+
  // req 'close' fires as soon as the request body has been read, which is
  // immediately here, and it would silently swallow every progress event after
  // the first — leaving the staged UI stuck on "asking".
  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
    clearInterval(keepalive);
  });
```

On Node 16+, `req` emits `close` when the request has been fully received — immediate, because `express.json()` already consumed the body. So `closed` was true before the first model call returned and every `progress` frame after `asking` was dropped; the first survived only because it was emitted before the event loop processed the close. Watching the response fixed it, and the verify script now prints real stage timings: `asking (0.0s) -> extracting (13.5s) -> classifying (21.6s)`.

## How it was verified

`scripts/verify.mjs` drives the app's own HTTP API, not the UI. Three conditions, judge held constant: `control0` (same model both slots, temperature 0), `control` (same model, sampled), `cross` (two models).

| Condition | A | B | temp | shared / A-only / B-only | consensus | claims linked | unique |
| --- | --- | --- | --- | --- | --- | --- | --- |
| same model, deterministic | gpt-oss-20b | gpt-oss-20b | 0 | 10 / 2 / 2 | **71.4%** | 87.5% | 4 |
| same model, sampled | gpt-oss-20b | gpt-oss-20b | 0.7 | 8 / 4 / 4 | **50.0%** | 66.7% | 8 |
| two models | gpt-oss-20b | gemma-4-e4b | 0.7 | 7 / 5 / 5 | **41.2%** | 66.7% | 10 |

Overlap falls and the unique rings grow as the slots get further apart — in the percentage *and* the raw counts. The cross run also produced 3 contradiction pairs (mean strength 0.667): the dashed red edges. Three repeats per condition give means of 59.3% (range 37.5–83.3), 60.0% and 47.5% (range 41.2–60.0): the direction holds every time, the gap moves with the judge's mood.

Eleven assertions run against every payload, all passing. The ones that matter recompute:

```js
// scripts/verify.mjs
  const recomputed =
    expectedBoth === 0 ? 0 : Number(((result.consensus.sharedPairs / expectedBoth) * 100).toFixed(1));
  add(
    'consensus % recomputes from node overlap',
    Math.abs(recomputed - result.consensus.consensusByNodes) < 0.11,
    `reported ${result.consensus.consensusByNodes} / recomputed ${recomputed}`,
  );
```

`findReasoningLeaks` walks the payload for any key matching `reasoning_content|reasoning_details|chain_of_thought|thinking|thoughts`; counts are allowed, text is not. Others assert node counts equal claim counts, `Both` = shared + A-only + B-only, every edge endpoint is a real node, every edge carries a `judge` or `lexical` label, 5/5 prompt hashes unique, and no API key in the payload.

`scripts/shots.py` is the browser layer: 33 checks through real Chromium — a live run, the five stages in order, node counts compared against the run that produced them (via a dev-only `window.__weaveResult` hook), hover, drag, exports (SVG must contain circles and lines, the share card a real PNG), and a fail on any console error.

## The five bugs verification found

1. **Every stage after "asking" was dropped.** `req.on('close')` fires when the request body is read, not when the client leaves, so the guard swallowed all later `progress` frames. Now watches `res`.
2. **Consensus used greedy matching**, so the headline depended on judge pair order. Kuhn's matching took the same control run from 50% to 71.4%.
3. **Nodes could be pushed outside their panel**, making a claim unreadable. Positions are clamped per tick.
4. **Labels overlapped** — 5 collisions of 16. Now greedily placed with collision rejection: 0 of 10.
5. **The reasoning toggle was one global switch**, but capability is per slot. Now per slot, rendering only where the flag can be sent.

## Honest limitations

**A local 20B judge is the weak link.** For two 12-claim lists it returns 8–14 relations, setting the ceiling on any overlap measure. My default judge is Particle.ai `deepseek-v4.1-flash`, which is steadier; every number here comes from a local judge because I had no key.

**Extraction granularity differs between samples.** In one control run the judge split one point into four claims in A and two in B. It found all four relations, but only two pair one-to-one, so strict matching reports 71.4% where a human would say the answers agreed. That is why the strict number sits next to "claims linked across models" (87.5%): it is a floor.

**Temperature 0 is not determinism on a local server.** Two identical prompts produced different answers with different sha256s, because parallel inference batches differently. The nonce check proves no prompt was reused; it cannot prove the model is deterministic. And the judge is never asked to be generous: it returns what it sees, and the app never inflates overlap.

## What I'd build next

- **A claims-level diff view.** The unmatched ring — a claim only one model made — is the interesting artifact. Sorting it by size answers "what did B miss?" better than the graph does.
- **Multi-model consensus.** Three or more answers, consensus as a hypergraph: core = claims every model made, rings by how many made them.
- **Judge self-consistency.** Run CLASSIFY three times at temperature 0, keep relations appearing in all three, and score each edge's stability.
- **Fixture-driven parser tests.** `parseJsonLoose`, `coerceClaims` and `coercePairs` have a dozen real failure shapes I found by hand; they belong in a unit test.

---

## Run it yourself

```bash
git clone <this repo> weave && cd weave
npm install
npm run dev            # backend on 3001, front end on 5173
```

Open **http://localhost:5173** and paste a key into the slots, or point all three at Ollama or
LM Studio and run it with no key at all. Then reproduce the experiment above:

```bash
node scripts/verify.mjs all                                     # data: 11 assertions per run
WEAVE_URL=http://localhost:5173/ python scripts/shots.py --run  # browser: 33 checks
```

The full reference — provider table, capability rules, consensus math, feature ideas — is in
[`README.md`](../README.md). Screenshots used above live in [`screenshots/`](screenshots/).

---

Built by **[Harish Kotra](https://harishkotra.me)** — more builds at
**[dailybuild.xyz](https://dailybuild.xyz)**.
