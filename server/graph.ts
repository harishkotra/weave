/**
 * Graph construction. Three views: A, B, and the overlap.
 *
 * Nothing here invents a node. Panel A has exactly as many nodes as the judge
 * returned claims for A; the "Both" panel merges matched pairs into one
 * consensus node and keeps the rest as unique satellites.
 */
import type { ConsensusStats, GraphEdge, GraphNode, GraphPanelData, PanelStats, Relation } from '../shared/types';
import type { EdgeSource } from '../shared/types';
import { jaccard, tokenize, type RawPair } from './judge';

/** Node radius = sqrt(claim length): how much text it took to say it. */
export function radiusFor(chars: number): number {
  return Math.max(7, Math.min(46, 4 + Math.sqrt(Math.max(1, chars)) * 1.35));
}

export interface ConsensusMatch {
  a: number;
  b: number;
  strength: number;
  id: string;
}

export interface BuiltGraph {
  panels: { a: GraphPanelData; b: GraphPanelData; both: GraphPanelData };
  consensus: ConsensusStats;
  matches: ConsensusMatch[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const round = (value: number, places = 3) => Number(value.toFixed(places));

/**
 * One claim can agree with several claims on the other side. Consensus is a
 * matching — each claim counted once — and it must be a MAXIMUM matching, or the
 * headline number would depend on the order the judge happened to list pairs in.
 * Kuhn's algorithm, with each claim's candidate list sorted by judge strength
 * (then lexical similarity) so the result is deterministic and prefers the
 * strongest relations. Contradictions never form consensus.
 */
export function matchConsensus(claimsA: string[], claimsB: string[], pairs: RawPair[]): ConsensusMatch[] {
  const tokensA = claimsA.map(tokenize);
  const tokensB = claimsB.map(tokenize);
  const strengthOf = new Map<string, number>();
  const adjacency = new Map<number, number[]>();

  for (const pair of pairs) {
    if (pair.relation !== 'agree' || pair.strength < 0.5) continue;
    strengthOf.set(`${pair.a}:${pair.b}`, pair.strength);
    const list = adjacency.get(pair.a) ?? [];
    list.push(pair.b);
    adjacency.set(pair.a, list);
  }

  for (const [a, list] of adjacency) {
    list.sort((x, y) => {
      const sx = strengthOf.get(`${a}:${x}`) ?? 0;
      const sy = strengthOf.get(`${a}:${y}`) ?? 0;
      if (sy !== sx) return sy - sx;
      const lx = jaccard(tokensA[a], tokensB[x]);
      const ly = jaccard(tokensA[a], tokensB[y]);
      if (ly !== lx) return ly - lx;
      return x - y;
    });
  }

  const bToA = new Map<number, number>();
  const aToB = new Map<number, number>();

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

  return [...aToB.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([a, b], index) => ({
      a,
      b,
      strength: strengthOf.get(`${a}:${b}`) ?? 0.5,
      id: `x:${index}`,
    }));
}

/**
 * Panel A and panel B edges are the bipartite projection of the judge's
 * cross-model relations: two of A's claims linked to the same B claim are on the
 * same side (agree) when they carry the same relation, and opposed when the
 * judge gave them different relations. Derived from judge output, never invented.
 */
function project(
  pairs: RawPair[],
  side: 'a' | 'b',
  sourceKind: EdgeSource,
): GraphEdge[] {
  const groups = new Map<number, RawPair[]>();
  for (const pair of pairs) {
    const key = side === 'a' ? pair.b : pair.a;
    const list = groups.get(key) ?? [];
    list.push(pair);
    groups.set(key, list);
  }
  const byPairKey = new Map<string, GraphEdge>();
  for (const [hub, list] of groups) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const one = list[i];
        const two = list[j];
        const from = side === 'a' ? one.a : one.b;
        const to = side === 'a' ? two.a : two.b;
        if (from === to) continue;
        const relation: Relation = one.relation === two.relation ? 'agree' : 'contradict';
        const strength = Math.min(one.strength, two.strength);
        const key = from < to ? `${from}-${to}` : `${to}-${from}`;
        const existing = byPairKey.get(key);
        if (existing && existing.strength >= strength) continue;
        byPairKey.set(key, {
          id: `p${side}:${key}:${hub}`,
          source: side === 'a' ? `a:${from}` : `b:${from}`,
          target: side === 'a' ? `a:${to}` : `b:${to}`,
          relation,
          strength: round(strength),
          source_kind: sourceKind,
        });
      }
    }
  }
  return [...byPairKey.values()];
}

function statsFor(edges: GraphEdge[], claimCount: number, sharedCount: number): PanelStats {
  const contradictions = edges.filter((edge) => edge.relation === 'contradict');
  return {
    claimCount,
    sharedCount,
    uniqueCount: claimCount - sharedCount,
    overlapPct: claimCount === 0 ? 0 : round((sharedCount / claimCount) * 100, 1),
    agreeCount: edges.filter((edge) => edge.relation === 'agree').length,
    contradictCount: contradictions.length,
    meanContradictionStrength: round(mean(contradictions.map((edge) => edge.strength))),
    edgeCount: edges.length,
  };
}

export interface BuildInput {
  claimsA: string[];
  claimsB: string[];
  pairs: RawPair[];
  sourceKind: EdgeSource;
}

export function buildGraph({ claimsA, claimsB, pairs, sourceKind }: BuildInput): BuiltGraph {
  const matches = matchConsensus(claimsA, claimsB, pairs);
  const matchByA = new Map(matches.map((match) => [match.a, match]));
  const matchByB = new Map(matches.map((match) => [match.b, match]));

  const nodeA = (index: number): GraphNode => ({
    id: `a:${index}`,
    panel: 'a',
    model: 'a',
    index,
    text: claimsA[index],
    chars: claimsA[index].length,
    radius: round(radiusFor(claimsA[index].length), 2),
    shared: matchByA.has(index),
    pairId: matchByA.get(index)?.id ?? null,
  });

  const nodeB = (index: number): GraphNode => ({
    id: `b:${index}`,
    panel: 'b',
    model: 'b',
    index,
    text: claimsB[index],
    chars: claimsB[index].length,
    radius: round(radiusFor(claimsB[index].length), 2),
    shared: matchByB.has(index),
    pairId: matchByB.get(index)?.id ?? null,
  });

  const nodesA = claimsA.map((_, index) => nodeA(index));
  const nodesB = claimsB.map((_, index) => nodeB(index));
  const edgesA = project(pairs, 'a', sourceKind);
  const edgesB = project(pairs, 'b', sourceKind);

  // The overlap view: consensus pairs become one node, everything else stays a satellite.
  const consensusNodes: GraphNode[] = matches.map((match, index) => {
    const text = claimsA[match.a];
    const other = claimsB[match.b];
    const chars = Math.round((text.length + other.length) / 2);
    return {
      id: match.id,
      panel: 'both',
      model: 'both',
      index,
      text,
      textOther: other,
      chars,
      radius: round(radiusFor(chars), 2),
      shared: true,
      pairId: match.id,
    };
  });
  const bothNodes = [
    ...consensusNodes,
    ...nodesA.filter((node) => !node.shared).map((node) => ({ ...node, panel: 'both' as const })),
    ...nodesB.filter((node) => !node.shared).map((node) => ({ ...node, panel: 'both' as const })),
  ];

  const mapA = (index: number) => matchByA.get(index)?.id ?? `a:${index}`;
  const mapB = (index: number) => matchByB.get(index)?.id ?? `b:${index}`;
  const bothEdges: GraphEdge[] = [];
  const seen = new Set<string>();
  let absorbedIntoCore = 0;
  for (const pair of pairs) {
    const source = mapA(pair.a);
    const target = mapB(pair.b);
    if (source === target) {
      // The two claims became one consensus node, so this relation IS the core.
      // Counted in the stats, never drawn as a self-loop.
      absorbedIntoCore += 1;
      continue;
    }
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bothEdges.push({
      id: `x:${key}`,
      source,
      target,
      relation: pair.relation,
      strength: round(pair.strength),
      source_kind: sourceKind,
    });
  }

  const aOnly = nodesA.filter((node) => !node.shared).length;
  const bOnly = nodesB.filter((node) => !node.shared).length;
  const sharedPairs = matches.length;
  const totalNodes = sharedPairs + aOnly + bOnly;

  const totalChars = claimsA.reduce((sum, claim) => sum + claim.length, 0) + claimsB.reduce((sum, claim) => sum + claim.length, 0);
  const consensusChars = matches.reduce(
    (sum, match) => sum + claimsA[match.a].length + claimsB[match.b].length,
    0,
  );

  const contradictions = bothEdges.filter((edge) => edge.relation === 'contradict');
  const judgeContradictions = pairs.filter((pair) => pair.relation === 'contradict');
  const judgeAgreements = pairs.filter((pair) => pair.relation === 'agree');

  // Two ways to read the same judge output. The matching is strict: each claim
  // counted once, so it drops claims whose counterpart was already taken by a
  // claim of finer granularity. Participation is generous: a claim counts when
  // the judge linked it to the other answer at all.
  const linkedA = new Set(judgeAgreements.filter((pair) => pair.strength >= 0.5).map((pair) => pair.a));
  const linkedB = new Set(judgeAgreements.filter((pair) => pair.strength >= 0.5).map((pair) => pair.b));
  const allClaims = claimsA.length + claimsB.length;

  const consensus: ConsensusStats = {
    sharedPairs,
    aOnly,
    bOnly,
    totalNodes,
    // Share of claim-nodes both models made. Identical answers -> 100%.
    consensusByNodes: totalNodes === 0 ? 0 : round((sharedPairs / totalNodes) * 100, 1),
    participationByNodes: allClaims === 0 ? 0 : round(((linkedA.size + linkedB.size) / allClaims) * 100, 1),
    linkedClaims: linkedA.size + linkedB.size,
    // Same overlap measured in characters of text.
    consensusByText: totalChars === 0 ? 0 : round((consensusChars / totalChars) * 100, 1),
    // Contradictions can never be absorbed into the core, so the drawn set is the whole set.
    meanContradictionStrength: round(mean(contradictions.map((edge) => edge.strength))),
    contradictionCount: judgeContradictions.length,
    agreeCount: judgeAgreements.length,
    absorbedIntoCore,
    drawnEdges: bothEdges.length,
  };

  return {
    panels: {
      a: { nodes: nodesA, edges: edgesA, stats: statsFor(edgesA, claimsA.length, sharedPairs) },
      b: { nodes: nodesB, edges: edgesB, stats: statsFor(edgesB, claimsB.length, sharedPairs) },
      both: {
        nodes: bothNodes,
        edges: bothEdges,
        stats: statsFor(bothEdges, bothNodes.length, sharedPairs),
      },
    },
    consensus,
    matches,
  };
}