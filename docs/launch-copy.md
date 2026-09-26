# Weave — launch copy

Ready to paste. Two tweets for X, one LinkedIn post. Numbers are the measured ones from
`verify.mjs` (see the README), not invented.

---

## X thread (2 tweets)

### Tweet 1

> I asked two models the same question, then turned each answer into a graph.
>
> A judge model splits both answers into atomic claims. Every claim becomes a node — sized by how much text it took to say, coloured by who said it.
>
> Then it renders the overlap. 🧵

**Attach:** the 1080×1080 share card (the `Both` panel) — it is the whole idea in one image.

Character count: 255.

---

### Tweet 2

> Same question, three runs:
>
> • same model, temp 0 → 71.4% consensus, 4 unique claims
> • same model, sampled → 50.0%, 8 unique
> • two models → 41.2%, 10 unique
>
> Shared claims form a white core, unique ones ring the outside, contradictions are dashed red.
>
> Built by @harishkotra

**Attach:** a short screen recording of a run settling (10–20s), or the three panels side by side.

Character count: 273.

---

## LinkedIn post (under 300 characters)

> I built Weave: ask two AI models the same question, and it graphs their answers. A judge model splits both into claims; shared claims form a white core, unique ones ring the outside. Same model twice: 71% overlap. Two models: 41%.
>
> https://dailybuild.xyz

Character count: 254 (including the URL).

---

## Notes on posting

- Post the thread after the LinkedIn post, not before — LinkedIn's link preview will pick up
  the deployed page, and the thread performs better when the link is in a reply, not the first
  tweet.
- The strongest single asset is the share card PNG. If you post one thing, post that image
  with tweet 1's text and put the numbers in a reply.
- Do not claim the models "agreed 41% of the time" as a fact about the models. It is a
  measurement of one run through one judge — the README says this plainly, and the post should
  not say more than the README does.