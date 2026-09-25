import { useEffect, useRef, useState } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import type { GraphPanelData, Stage } from '../../shared/types';
import { downloadPanelSvg, type PanelSnapshot } from '../lib/export';

export const THREAD_A = '#3FE0E8';
export const THREAD_B = '#FF4FD8';
export const CORE = '#FFF4E2';
export const CONTRA = '#FF5B45';
export const AGREE = '#8F93A8';
const INK = '#0A0910';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  index: number;
  text: string;
  textOther?: string;
  chars: number;
  radius: number;
  model: 'a' | 'b' | 'both';
  shared: boolean;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
  relation: 'agree' | 'contradict';
  strength: number;
  source_kind: string;
}

function colorFor(model: SimNode['model']): string {
  if (model === 'both') return CORE;
  return model === 'a' ? THREAD_A : THREAD_B;
}

function shortLabel(text: string, max = 30): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max).trim()}…`;
}

export interface GraphPanelProps {
  panelId: 'a' | 'b' | 'both';
  eyebrow: string;
  title: string;
  blurb: string;
  data: GraphPanelData;
  stage: Stage;
  runKey: string;
  height: number;
  fileStem: string;
  caption: string[];
  onSettled: (panelId: 'a' | 'b' | 'both') => void;
  onSnapshot: (panelId: 'a' | 'b' | 'both', snapshot: PanelSnapshot) => void;
  footer?: React.ReactNode;
  extraActions?: React.ReactNode;
}

export function GraphPanel(props: GraphPanelProps) {
  const { panelId, data, stage, runKey, height, onSettled, onSnapshot } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const settledRef = useRef(false);
  const [width, setWidth] = useState(640);
  const [progress, setProgress] = useState(0);
  const [hovered, setHovered] = useState<SimNode | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidth(Math.round(next));
    });
    observer.observe(host);
    setWidth(Math.round(host.getBoundingClientRect().width) || 640);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!svgElement || width === 0) return;

    settledRef.current = false;
    setProgress(0);

    const cx = width / 2;
    const cy = height / 2;
    const isBoth = panelId === 'both';
    const outerRadius = Math.max(70, Math.min(width, height) / 2 - 46);

    // Deterministic seed: consensus claims start inside, unique claims outside.
    // The assembly you watch is the physics finding the real structure, but it
    // always starts from the same frame so two runs are comparable on camera.
    const nodes: SimNode[] = data.nodes.map((node, index) => {
      const count = Math.max(1, data.nodes.length);
      const angle = (index / count) * Math.PI * 2;
      const radius = isBoth ? (node.shared ? 58 : outerRadius * 0.82) : outerRadius * 0.55;
      return {
        id: node.id,
        index: node.index,
        text: node.text,
        textOther: node.textOther,
        chars: node.chars,
        radius: node.radius,
        model: node.model,
        shared: node.shared,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      };
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const links: SimLink[] = data.edges
      .filter((edge) => byId.has(edge.source) && byId.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        strength: edge.strength,
        source_kind: edge.source_kind,
      }));

    const simulation: Simulation<SimNode, SimLink> = forceSimulation(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((node) => node.id)
          .distance(isBoth ? 74 : 104)
          .strength(0.22),
      )
      .force(
        'charge',
        forceManyBody<SimNode>()
          .strength((node) => (isBoth ? (node.shared ? -340 : -110) : -250))
          .distanceMax(Math.max(width, height) * 0.9),
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

    const root = select(svgElement);
    root.selectAll('*').remove();
    root.attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height);

    const defs = root.append('defs');
    const glow = defs.append('filter').attr('id', `weave-glow-${panelId}`).attr('x', '-80%').attr('y', '-80%').attr('width', '260%').attr('height', '260%');
    glow.append('feGaussianBlur').attr('stdDeviation', '5').attr('result', 'blur');
    glow
      .append('feMerge')
      .selectAll('feMergeNode')
      .data(['blur', 'SourceGraphic'])
      .join('feMergeNode')
      .attr('in', (value) => value);

    const layer = root.append('g');
    const linkLayer = layer.append('g').attr('class', 'links');
    const nodeLayer = layer.append('g').attr('class', 'nodes');

    const linkSelection = linkLayer
      .selectAll<SVGLineElement, SimLink>('line')
      .data(links, (link) => link.id)
      .join('line')
      .attr('stroke', (link) => (link.relation === 'contradict' ? CONTRA : AGREE))
      .attr('stroke-width', (link) => (0.7 + link.strength * 2.6).toFixed(2))
      .attr('stroke-dasharray', (link) => (link.relation === 'contradict' ? '7 5' : null))
      .attr('stroke-opacity', (link) => (link.relation === 'contradict' ? 0.85 : 0.5))
      .attr('stroke-linecap', 'round');

    const nodeSelection = nodeLayer
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes, (node) => node.id)
      .join('g')
      .attr('class', 'node')
      .style('cursor', 'grab');

    nodeSelection
      .filter((node) => node.shared)
      .append('circle')
      .attr('class', 'halo')
      .attr('r', (node) => node.radius + 7)
      .attr('fill', 'none')
      .attr('stroke', CORE)
      .attr('stroke-width', 3)
      .attr('opacity', 0.5)
      .attr('filter', `url(#weave-glow-${panelId})`);

    nodeSelection
      .append('circle')
      .attr('class', 'body')
      .attr('r', (node) => node.radius)
      .attr('fill', (node) => colorFor(node.model))
      .attr('fill-opacity', (node) => (node.shared ? 0.95 : 0.82))
      .attr('stroke', (node) => (node.shared ? CORE : INK))
      .attr('stroke-width', (node) => (node.shared ? 2.5 : 1.2));

    nodeSelection
      .append('text')
      .attr('class', 'label')
      .attr('text-anchor', 'middle')
      .attr('y', (node) => node.radius + 13)
      .attr('font-size', (node) => (node.radius > 20 ? 12.5 : 11))
      .attr('font-weight', (node) => (node.shared ? 600 : 450))
      .attr('fill', (node) => (node.shared ? CORE : '#C9C5DA'))
      .attr('stroke', INK)
      .attr('stroke-width', 3)
      .attr('paint-order', 'stroke')
      .attr('opacity', 0)
      .style('pointer-events', 'none')
      .text((node) => shortLabel(node.text));

    nodeSelection
      .append('title')
      .text((node) => node.text);

    const endpointId = (endpoint: SimLink['source']): string =>
      typeof endpoint === 'object' && endpoint !== null ? endpoint.id : String(endpoint);

    const neighbours = new Map<string, Set<string>>();
    for (const link of links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (!neighbours.has(source)) neighbours.set(source, new Set());
      if (!neighbours.has(target)) neighbours.set(target, new Set());
      neighbours.get(source)?.add(link.id);
      neighbours.get(target)?.add(link.id);
    }

    let visibleLabels = new Set<string>();

    const highlight = (node: SimNode | null) => {
      if (!node) {
        nodeSelection.attr('opacity', 1);
        linkSelection.attr('stroke-opacity', (link) => (link.relation === 'contradict' ? 0.85 : 0.5)).attr('stroke-width', (link) => (0.7 + link.strength * 2.6).toFixed(2));
        nodeSelection.select<SVGTextElement>('text.label').attr('opacity', (datum) => (visibleLabels.has(datum.id) ? 1 : 0));
        return;
      }
      const incident = neighbours.get(node.id) ?? new Set<string>();
      const connected = new Set<string>([node.id]);
      for (const link of links) {
        const source = endpointId(link.source);
        const target = endpointId(link.target);
        if (source === node.id) connected.add(target);
        if (target === node.id) connected.add(source);
      }
      nodeSelection.attr('opacity', (datum) => (connected.has(datum.id) ? 1 : 0.16));
      linkSelection
        .attr('stroke-opacity', (link) => (incident.has(link.id) ? 1 : 0.06))
        .attr('stroke-width', (link) => (incident.has(link.id) ? (1.4 + link.strength * 3.2).toFixed(2) : '0.8'));
      nodeSelection.select<SVGTextElement>('text.label').attr('opacity', (datum) => (connected.has(datum.id) ? 1 : 0.1));
    };

    nodeSelection
      .on('mouseenter', (_event, node) => {
        highlight(node);
        setHovered(node);
      })
      .on('mouseleave', () => {
        highlight(null);
        setHovered(null);
      });

    let dragging = false;
    nodeSelection.call(
      drag<SVGGElement, SimNode>()
        .on('start', (event, node) => {
          dragging = true;
          if (!event.active) simulation.alphaTarget(0.2).restart();
          node.fx = node.x;
          node.fy = node.y;
          select(event.sourceEvent.target as Element).style('cursor', 'grabbing');
        })
        .on('drag', (event, node) => {
          node.fx = event.x;
          node.fy = event.y;
        })
        .on('end', (event, node) => {
          dragging = false;
          simulation.alphaTarget(0);
          // Pin where it was dropped: a dragged graph should stay dragged.
          node.fx = node.x;
          node.fy = node.y;
          select(event.sourceEvent.target as Element).style('cursor', 'grab');
          render();
          placeLabels();
          highlight(null);
          publishSnapshot();
        }),
    );

    function render() {
      // Keep every node inside its panel: a claim pushed off-screen is a claim
      // nobody can read.
      for (const node of nodes) {
        const limitX = Math.max(0, width / 2 - node.radius - 3);
        const limitY = Math.max(0, height / 2 - node.radius - 3);
        node.x = Math.max(cx - limitX, Math.min(cx + limitX, node.x ?? cx));
        node.y = Math.max(cy - limitY, Math.min(cy + limitY, node.y ?? cy));
      }
      linkSelection
        .attr('x1', (link) => (link.source as SimNode).x ?? 0)
        .attr('y1', (link) => (link.source as SimNode).y ?? 0)
        .attr('x2', (link) => (link.target as SimNode).x ?? 0)
        .attr('y2', (link) => (link.target as SimNode).y ?? 0);
      nodeSelection.attr('transform', (node) => `translate(${node.x ?? 0},${node.y ?? 0})`);
    }

    /**
     * Labels are placed greedily — shared claims and bigger nodes first — and any
     * label that would land on one already placed is hidden until you hover it.
     * Readable beats complete.
     */
    function placeLabels() {
      const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
      const ranked = [...nodes].sort(
        (a, b) => Number(b.shared) - Number(a.shared) || b.radius - a.radius || a.index - b.index,
      );
      const placed = new Set<string>();
      for (const node of ranked) {
        if (!node.shared && node.radius < 11) continue;
        const label = shortLabel(node.text);
        const advance = node.radius > 20 ? 6.9 : 6.1;
        const half = (label.length * advance) / 2;
        const box = {
          x1: (node.x ?? 0) - half,
          y1: (node.y ?? 0) + node.radius + 2,
          x2: (node.x ?? 0) + half,
          y2: (node.y ?? 0) + node.radius + 16,
        };
        if (boxes.some((other) => box.x1 < other.x2 && other.x1 < box.x2 && box.y1 < other.y2 && other.y1 < box.y2)) continue;
        boxes.push(box);
        placed.add(node.id);
      }
      visibleLabels = placed;
    }

    function publishSnapshot() {
      onSnapshot(panelId, {
        width,
        height,
        nodes: nodes.map((node) => ({
          id: node.id,
          x: node.x ?? 0,
          y: node.y ?? 0,
          radius: node.radius,
          model: node.model,
          shared: node.shared,
          text: node.text,
        })),
        edges: links.map((link) => ({
          source: endpointId(link.source),
          target: endpointId(link.target),
          relation: link.relation,
          strength: link.strength,
        })),
      });
    }

    render();
    placeLabels();
    highlight(null);

    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    let lastProgress = 0;

    const settle = () => {
      if (settledRef.current) return;
      settledRef.current = true;
      setProgress(1);
      render();
      placeLabels();
      highlight(null);
      publishSnapshot();
      onSettled(panelId);
    };

    if (reduced) {
      // Respect reduced motion: place the graph, do not animate the assembly.
      for (let i = 0; i < 320; i += 1) simulation.tick();
      settle();
    } else {
      simulation.on('tick', () => {
        render();
        const value = Math.min(1, Math.max(0, 1 - simulation.alpha()));
        if (value - lastProgress > 0.01) {
          lastProgress = value;
          setProgress(value);
        }
      });
      simulation.on('end', () => {
        if (!dragging) settle();
      });
      simulation.restart();
      frame = window.setTimeout(() => {
        if (!settledRef.current && !dragging) settle();
      }, 12000);
    }

    return () => {
      if (frame) window.clearTimeout(frame);
      simulation.on('tick', null);
      simulation.on('end', null);
      simulation.stop();
      root.selectAll('*').remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, runKey, width, height, panelId]);

  const stats = data.stats;
  const settled = stage === 'settled';

  return (
    <section className={`panel panel-${panelId}`} data-panel={panelId}>
      <header className="panel-head">
        <div className="panel-titles">
          <span className="eyebrow">{props.eyebrow}</span>
          <h3>{props.title}</h3>
          <p className="blurb">{props.blurb}</p>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => svgRef.current && downloadPanelSvg(svgRef.current, `${props.fileStem}.svg`, props.caption)}
          >
            Download SVG
          </button>
          {props.extraActions}
        </div>
      </header>

      <dl className="panel-stats">
        <div>
          <dt>claims</dt>
          <dd className="num">{stats.claimCount}</dd>
        </div>
        <div>
          <dt>unique to this model</dt>
          <dd className="num">{stats.uniqueCount}</dd>
        </div>
        <div>
          <dt>overlap</dt>
          <dd className="num">{stats.overlapPct.toFixed(1)}%</dd>
        </div>
        <div>
          <dt>mean contradiction</dt>
          <dd className="num">{stats.contradictCount === 0 ? '0.00' : stats.meanContradictionStrength.toFixed(2)}</dd>
        </div>
      </dl>

      <div className="stage" ref={hostRef} style={{ height }}>
        <svg ref={svgRef} className="graph" role="img" aria-label={`${props.title} claim graph`} />
        {hovered && (
          <div
            className="tooltip"
            style={{
              left: `${Math.min(Math.max((hovered.x ?? 0) + 16, 8), Math.max(8, width - 300))}px`,
              top: `${Math.min(Math.max((hovered.y ?? 0) + 16, 8), height - 96)}px`,
            }}
          >
            <span className={`chip chip-${hovered.model}`}>
              {hovered.model === 'both' ? 'both models' : hovered.model === 'a' ? 'Model A' : 'Model B'}
            </span>
            <p>{hovered.text}</p>
            {hovered.textOther && hovered.textOther !== hovered.text && (
              <p className="tooltip-other">
                <span className="mono">{hovered.model === 'both' ? 'the other phrasing' : ''}</span> {hovered.textOther}
              </p>
            )}
            <span className="mono dim">{hovered.chars} chars</span>
          </div>
        )}
        <div className={`settle ${settled ? 'is-settled' : ''}`} aria-live="polite">
          <span className="settle-track">
            <span className="settle-fill" style={{ transform: `scaleX(${settled ? 1 : progress})` }} />
          </span>
          <span className="settle-label mono">{settled ? 'force layout settled' : `force layout ${(progress * 100).toFixed(0)}%`}</span>
        </div>
      </div>

      {props.footer && <div className="panel-foot">{props.footer}</div>}
    </section>
  );
}