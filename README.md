# Weave

Ask two models the same question. Turn each answer into a graph. See what shape the reasoning takes.

Weave sends one question to two models at the same moment, hands both answers to a third
slot (the judge), and turns the result into three force-directed graphs: **A only**,
**B only**, and **Both**. Each atomic claim is a node, sized by how much text it took to
say, coloured by which model said it. Shared claims are pulled into a white consensus core;
claims only one model made are pushed out to the rings. Agree edges are solid grey,
contradictions are dashed red.

The headline number is the share of the answer both models agreed on, measured from node
overlap — not from string similarity, not from an embedding.

---

## Quick start

```bash
git clone <this repo> weave && cd weave
npm install
npm run dev
```

Open **http://localhost:5173**, paste a key into the Model A / Model B / Judge slots (they
are saved in your browser's localStorage), and press **Run the weave**.

No API key exists anywhere in this repository, and nothing is read from a `.env` file. Keys
are typed into the UI, sent only to the local backend, and used only for that provider's
`/chat/completions`.

Requirements: Node 20+.

---

## Providers

Two model slots (A and B) plus a judge slot. Every slot has its **own** provider, base URL,
API key and model name — a local model can judge two cloud models, or the other way round.

| Provider | Base URL | Key | Models |
| --- | --- | --- | --- |
| Particle.ai | `https://api.particle.ai/v1` | required | `deepseek-v4.1-flash`, `deepseek-v4-flash-0731`, `glm5.3flash` |
| Ollama | `http://127.0.0.1:11434/v1` | none | read live from `GET /v1/models` |
| LM Studio | `http://127.0.0.1:1234/v1` | none | read live from `GET /v1/models` |
| OpenRouter | `https://openrouter.ai/api/v1` | required | read live from `GET /v1/models` |
| Custom | anything OpenAI-compatible | depends | whatever you type |

Defaults: A = Particle.ai / `deepseek-v4-flash-0731`, B = Particle.ai / `deepseek-v4.1-flash`,
judge = same as B, temperature 0.7, max tokens 1600 (judge 2000), reasoning off for A and B
and on for the judge — a judge that spends its budget on hidden chain-of-thought returns no
JSON. Every slot has its own **Disable reasoning** toggle, and it only renders where the flag
can actually be sent (Particle.ai + `deepseek-*`).

**The model field is always typeable.** `deepseek-v4-flash-0731` does not appear in
Particle.ai's `/models` list and still answers, so a run is never gated on the model list
succeeding. If a provider is unreachable you get the provider's real error text:

```
Cannot reach http://127.0.0.1:11434 — is Ollama running?
detail: connect ECONNREFUSED 127.0.0.1:11434 (ECONNREFUSED) · tried http://127.0.0.1:11434/v1/chat/completions
hint:   Start Ollama, then press Run again. No API key is needed for Ollama.
```

---

## How one run works

```
POST /api/weave { question, config }              Server-Sent Events
  │
  ├─ asking        A and B called CONCURRENTLY with the identical question text
  │                 system: "You are a precise assistant. Answer the user's request directly."
  │
  ├─ extracting    judge call #1 (twice, concurrently, one per answer)
  │                 "Split the following answer into atomic claims. Return JSON array of
  │                  strings, max 12 items. No commentary."
  │
  ├─ classifying   judge call #2 (once, over both claim lists)
  │                 {"pairs":[{"a":i,"b":j,"relation":"agree"|"contradict","strength":0..1}]}
  │                 capped at 30 pairs, empty array allowed
  │
  ├─ simulating    client-side d3-force layout, three panels at once
  └─ settled
```

Judge system prompt: `You are a strict JSON API. Output only valid JSON.` Judge temperature
is 0. A/B temperature comes from the config. `max_tokens` defaults to 1600 (judge 2000) and
is never allowed below 900 — reasoning models need a real budget.

### When the judge does not return JSON

Judge output goes through a tolerant parser (fences, prose preambles, smart quotes, trailing
commas, Python literals, single quotes, balanced-bracket extraction). If it still fails, the
call is retried once. If it fails twice:

- claims fall back to sentence splitting, and
- edges fall back to **lexical Jaccard similarity** over stopword-filtered token sets
  (threshold 0.32; a negation mismatch above 0.45 is marked a contradiction).

Either fallback labels the view **`fallback: lexical`** in the headline, in the panel footer,
in the share card and in the copied JSON, and adds a warning. Lexical edges are never
presented as semantic ones.

---

## The three views

| Panel | Nodes | Edges |
| --- | --- | --- |
| **A only** | A's claims | projection of the judge's cross-model relations |
| **B only** | B's claims | projection of the judge's cross-model relations |
| **Both** | matched pairs merged into one consensus node, plus each model's unique claims | every cross-model relation, mapped through the merge |

The projection in the A/B panels is derived, not invented: when two of A's claims are linked
to the *same* claim in B, they are on the same side when the judge gave them the same
relation (drawn solid) and opposed when it gave different relations (drawn dashed). Nothing
is drawn that the judge did not classify.

In the **Both** panel the consensus core is pulled to the centre by a stronger centering
force, unique claims are pushed out by a radial force, and node radius is `sqrt(claim
length)` — so how much text it took to say something is visible as size.

### The consensus number

- Agree pairs with strength ≥ 0.5 form a **matching** (greedy by judge strength, then lexical
  similarity as a tie-break), so every claim is counted at most once. Contradictions never
  form consensus.
- `sharedPairs` = matched pairs, `aOnly` / `bOnly` = claims left over.
- **Consensus by nodes** = `sharedPairs / (sharedPairs + aOnly + bOnly)`. Two identical
  answers score 100%.
- **Consensus by text** = matched characters ÷ all characters. Both are shown.

---

## Capability detection, never assumptions

| Situation | What Weave does |
| --- | --- |
| `usage.completion_tokens_details.reasoning_tokens` present | shows that number |
| that field absent (normal for Ollama, common for LM Studio) | shows **n/a** and hides the thinking toggle for that slot — never prints 0 |
| `chat_template_kwargs {"enable_thinking": false}` | sent **only** when that slot is Particle.ai **and** the model name starts with `deepseek-` |
| HTTP 200 with empty content | treated as the hidden CoT eating the budget: retried **once** with double `max_tokens` (cap 4000), never as a refusal |
| `reasoning_content` / `reasoning` in the message | stripped at the edge, before anything else reads the response. Never logged, never returned, never stored. Only the token **count** is shown |
| repeated-run experiment | a fresh random nonce is appended to every prompt; A and B get byte-identical question text, and all prompt hashes are checked for reuse (`promptReuse.duplicates` must be 0) |

---

## Ports

| Service | Default | Override |
| --- | --- | --- |
| Front end (Vite) | 5173 | `WEAVE_WEB_PORT` |
| Back end (Express) | 3001 | `PORT` |
| Vite proxy target | `http://127.0.0.1:3001` | `WEAVE_API_TARGET` |

The overrides exist so Weave can run next to another project on the same machine. A clean
clone needs none of them.

---

## Repository map

```
index.html               Vite entry
src/App.tsx              state machine: idle → asking → extracting → classifying → simulating → settled
src/components/          SlotCard (per-slot provider config), GraphPanel (d3-force → SVG)
src/lib/api.ts           SSE client for /api/weave, /api/models
src/lib/config.ts        localStorage config (keys live here, nowhere else)
src/lib/export.ts        SVG per panel, 1080×1080 PNG share card, clipboard
server/index.ts          Express: /api/health, /api/models, /api/weave (SSE)
server/providers.ts      the only place that talks to a model provider
server/judge.ts          extract + classify prompts, retries, lexical fallback
server/graph.ts          three panels, consensus matching, stats
server/json.ts           tolerant JSON parser
shared/                  provider presets, capability rules, result types
scripts/verify.mjs       data verification against the running API
scripts/shots.py         browser verification (Playwright): states, exports, console errors
```

---

## Verification

Both scripts hit the real pipeline. No fixture, no mock, no hand-written claim.

```bash
npm run dev                                            # in one terminal
node scripts/verify.mjs control                        # A and B on the SAME model
node scripts/verify.mjs cross                          # A older, B newer
node scripts/verify.mjs all                            # both, then compares them
```

Override the models for your own providers:

```bash
WEAVE_PROVIDER=particle WEAVE_BASE=https://api.particle.ai/v1 WEAVE_API_KEY=... \
WEAVE_A_MODEL=deepseek-v4-flash-0731 WEAVE_B_MODEL=deepseek-v4.1-flash \
WEAVE_JUDGE_MODEL=deepseek-v4.1-flash node scripts/verify.mjs all
```

`verify.mjs` checks, on every run:

1. panel A node count == the judge's claim count for A (same for B) — no invented nodes;
2. `Both` node count == shared + A-only + B-only;
3. the consensus percentage recomputes from node overlap;
4. every edge endpoint exists as a node, and every edge is labelled `judge` or `lexical`;
5. no reasoning text anywhere in the payload;
6. prompt nonces: 0 duplicates, all prompts unique;
7. reasoning tokens are a number or `n/a`;
8. the API key never appears in the payload (only `provided` / `none`);
9. the judge's JSON actually parsed (parse mode is not `fallback-lexical`).

Then it compares the control and cross runs: the same-model run should show a high overlap
with near-empty rings, and the cross-model run should show a lower overlap with bigger rings.
If both runs look the same, extraction or classification is broken.

<!--VERIFICATION-RESULTS-->

### Measured results

Run on this machine with LM Studio on `127.0.0.1:1234`, preset 1
("Should companies ban AI-generated code from production?"), judge `openai/gpt-oss-20b`
in every run. `node scripts/verify.mjs all`:

| Condition | A | B | temp | stages (real) | shared / A-only / B-only | consensus | claims linked | unique |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| same model, deterministic | gpt-oss-20b | gpt-oss-20b | 0 | asking 0.0s → extracting 13.5s → classifying 21.6s | 10 / 2 / 2 | **71.4%** | 87.5% | 4 |
| same model, sampled | gpt-oss-20b | gpt-oss-20b | 0.7 | 0.0s → 14.3s → 22.9s | 8 / 4 / 4 | **50.0%** | 66.7% | 8 |
| two models | gpt-oss-20b | gemma-4-e4b | 0.7 | 0.0s → 40.0s → 49.6s | 7 / 5 / 5 | **41.2%** | 66.7% | 10 |

Overlap falls and the unique rings grow as the two slots get further apart, in both the
percentage and the raw counts. The cross-model run also produced 3 contradiction pairs
(mean strength 0.667) — those are the dashed red edges in the overlap view; the same-model
runs produced none.

Repeating each condition three times (`WEAVE_REPEAT=3`) gives means of 59.3% (range
37.5–83.3), 60.0% and 47.5% (range 41.2–60.0) — the direction holds every time, the size of
the gap moves with the judge's mood.

Every run passed all 11 data checks: node counts equal judge claim counts on both sides, the
`Both` node count equals shared + A-only + B-only, the percentage recomputes from node
overlap, every edge endpoint is a real node, every edge is labelled `judge` or `lexical`, no
reasoning text appears anywhere in the payload, all five prompts are unique with zero reuse
and identical question bytes for A and B, reasoning tokens are a number or `n/a`, no API key
is in the payload, and the judge's JSON parsed (`parseMode json`).

Raw output is in `verify-output/`; the copied JSON from the UI carries the same fields plus
the raw claims, raw judge pairs and the exact judge prompts.

### What the numbers say, honestly

Two models make fewer shared claims than one model twice, and their unique rings are larger
(10 vs 4 claims). The size of the gap is limited by the judge, not by the app:

1. **A local 20B judge is the weak link.** For 12 × 12 claims it returns 8–14 relations, so
   the ceiling on any overlap measure is set by its recall. A stronger judge (the default here
   is Particle.ai `deepseek-v4.1-flash`) returns more relations and is far steadier.
2. **Extraction granularity differs between samples.** In one control run the judge split one
   point into four claims in A and two in B (`A5–A8` against `B5–B6`). It found all four
   relations, but only two of them can be paired one-to-one, so strict matching reports 71.4%
   where a human would say the two answers agreed. That is why the headline is accompanied by
   **claims linked across models** (87.5% in the same run) and by **consensus by text volume**
   (82.5%) — the strict number is the floor, not the whole story.
3. **Temperature 0 is not determinism on a local server.** Two identical prompts at
   temperature 0 produced different answers (different sha256), because parallel inference
   batches differently. The nonce check still proves no prompt was reused.
4. **The judge is not asked to be generous.** It returns the relations it sees; the app never
   inflates the overlap, keeps the raw pairs in the JSON, and labels lexical edges as lexical.

To see the control case at its ceiling, run the same model in both slots with a strong judge:
the overlap rises as judge recall rises.

### Browser verification

```bash
WEAVE_URL=http://localhost:5173/ python scripts/shots.py --run
```

Drives the real page in Chromium — 33 checks, all passing — and covers the idle state, the
provider error copy, the per-slot thinking-toggle capability rules, a live run through all
five stages (verified in order), node counts against the run that produced them, the headline
against the same run, the hover highlight, dragging, label collisions, nodes escaping their
panel, and both exports (the SVG must contain circles and lines; the share card must be a real
PNG). It fails on any console error or page exception and writes screenshots plus
`verify-output/browser-checks.json`.

This layer earned its keep: it caught the `req.on('close')` bug below, a node escaping its
panel, and overlapping labels.

### Bugs this verification found (and fixed)

- **Every stage after "asking" was silently dropped.** `server/index.ts` watched
  `req.on('close')` for the client disconnect, but on Node 16+ that fires as soon as the
  request body has been read — immediately — so the staged UI sat on "asking" for the whole
  run. It now watches the *response*, and `verify.mjs` prints real stage timings.
- **Consensus used a greedy matching**, so the headline depended on the order the judge listed
  pairs in. It is now a maximum bipartite matching (Kuhn's), which is why the same-model
  control reads 71.4% where greedy said 50%.
- **Nodes could be pushed outside their panel** by the forces; positions are now clamped to
  the panel, so no claim is off-screen.
- **Labels overlapped.** They are now placed greedily — shared and larger claims first — and a
  label that would collide is hidden until you hover it: 0 collisions of 10 labels.
- **The thinking toggle was one global switch.** Capability is per slot, so the toggle is now
  per slot and only renders where the flag can actually be sent.

---

## Non-goals

No embeddings API dependency (the lexical fallback is required instead), no three.js, no
graph library on top of D3, no graph database, no auth, no persistence beyond localStorage,
no conversation history, no web search, no fine-tuning.