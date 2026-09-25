import type { ConsensusStats, ModelRun, Relation } from '../../shared/types';

export interface SnapshotNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  model: 'a' | 'b' | 'both';
  shared: boolean;
  text: string;
}

export interface SnapshotEdge {
  source: string;
  target: string;
  relation: Relation;
  strength: number;
}

export interface PanelSnapshot {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
  width: number;
  height: number;
}

const INK = '#0A0910';
const THREAD_A = '#3FE0E8';
const THREAD_B = '#FF4FD8';
const CORE = '#FFF4E2';
const CONTRA = '#FF5B45';
const AGREE = '#8F93A8';
const TEXT = '#EDEAF5';
const MUTED = '#8A85A0';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function slug(value: string, max = 48): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'weave'
  );
}

/**
 * Exports the live panel. Presentation attributes are already on the elements,
 * so a clone plus a background and a portable font stack is a faithful file.
 */
export function downloadPanelSvg(svg: SVGSVGElement, filename: string, caption: string[]): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const width = Number(svg.getAttribute('width')) || svg.clientWidth || 720;
  const height = Number(svg.getAttribute('height')) || svg.clientHeight || 480;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = `text{font-family:'Helvetica Neue',Arial,sans-serif}.label{fill:${TEXT}}.num{font-family:Menlo,Consolas,monospace}`;
  clone.insertBefore(style, clone.firstChild);

  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(width));
  background.setAttribute('height', String(height));
  background.setAttribute('fill', INK);
  clone.insertBefore(background, style.nextSibling);

  caption.forEach((line, index) => {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '18');
    text.setAttribute('y', String(26 + index * 18));
    text.setAttribute('font-size', index === 0 ? '15' : '12');
    text.setAttribute('font-weight', index === 0 ? '700' : '400');
    text.setAttribute('fill', index === 0 ? TEXT : MUTED);
    text.textContent = line;
    clone.appendChild(text);
  });

  download(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

/** Greedy wrap with an estimated advance width. Runs in the browser, no measuring API needed. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  return lines.slice(0, maxLines);
}

export interface ShareCardInput {
  question: string;
  consensus: ConsensusStats;
  both: PanelSnapshot;
  modelA: ModelRun;
  modelB: ModelRun;
  judgeLabel: string;
  judgeModel: string;
  parseMode: string;
}

/** 1080x1080 share card of the "Both" panel. Fonts are portable stacks: this SVG is rasterised. */
export function buildShareCardSvg(input: ShareCardInput): string {
  const { question, consensus, both } = input;
  const size = 1080;
  const pad = 56;

  // Fit the live layout into the card's graph box without distorting it.
  const box = { x: pad, y: 300, w: size - pad * 2, h: 470 };
  const scale = Math.min(box.w / Math.max(1, both.width), box.h / Math.max(1, both.height));
  const offsetX = box.x + (box.w - both.width * scale) / 2;
  const offsetY = box.y + (box.h - both.height * scale) / 2;
  const project = (x: number, y: number) => ({ x: offsetX + x * scale, y: offsetY + y * scale });

  const nodes = new Map(both.nodes.map((node) => [node.id, node]));
  const edgeMarkup = both.edges
    .map((edge) => {
      const from = nodes.get(edge.source);
      const to = nodes.get(edge.target);
      if (!from || !to) return '';
      const a = project(from.x, from.y);
      const b = project(to.x, to.y);
      const contradict = edge.relation === 'contradict';
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${
        contradict ? CONTRA : AGREE
      }" stroke-width="${(0.6 + edge.strength * 2.4).toFixed(2)}" ${contradict ? 'stroke-dasharray="7 5"' : ''} opacity="0.75" />`;
    })
    .join('');

  const nodeMarkup = both.nodes
    .map((node) => {
      const point = project(node.x, node.y);
      const radius = Math.max(4, node.radius * scale);
      const fill = node.model === 'both' ? CORE : node.model === 'a' ? THREAD_A : THREAD_B;
      const ring = node.shared && node.model !== 'both' ? ` stroke="${CORE}" stroke-width="2.5"` : '';
      return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="${fill}"${ring} opacity="0.94" />`;
    })
    .join('');

  const questionLines = wrap(question, 46, 3)
    .map((line, index) => `<text x="${pad}" y="${196 + index * 44}" font-size="38" font-weight="600" fill="${TEXT}">${escapeXml(line)}</text>`)
    .join('');

  const stats: [string, string][] = [
    ['shared claims', String(consensus.sharedPairs)],
    ['A only', String(consensus.aOnly)],
    ['B only', String(consensus.bOnly)],
    ['contradictions', String(consensus.contradictionCount)],
    ['by text volume', `${consensus.consensusByText.toFixed(1)}%`],
  ];
  const statsMarkup = stats
    .map(
      ([label, value], index) =>
        `<text x="${size - pad}" y="${336 + index * 34}" text-anchor="end" font-size="22" font-family="Menlo,Consolas,monospace" fill="${MUTED}">${escapeXml(
          label,
        )} <tspan fill="${TEXT}" font-weight="700">${escapeXml(value)}</tspan></text>`,
    )
    .join('');

  const grid = Array.from({ length: 19 }, (_, index) => {
    const at = index * 60;
    return `<line x1="${at}" y1="0" x2="${at}" y2="${size}" stroke="#ffffff" stroke-opacity="0.028" />`;
  }).join('');

  const gridH = Array.from({ length: 19 }, (_, index) => {
    const at = index * 60;
    return `<line x1="0" y1="${at}" x2="${size}" y2="${at}" stroke="#ffffff" stroke-opacity="0.028" />`;
  }).join('');

  const label = input.parseMode === 'fallback-lexical' ? 'edges: fallback lexical' : 'edges: judge classified';
  const footer = `A ${input.modelA.model}  ·  B ${input.modelB.model}  ·  judge ${input.judgeModel} (${input.judgeLabel})  ·  ${label}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${INK}" />
  <g>${grid}${gridH}</g>
  <text x="${pad}" y="${96}" font-size="26" font-family="Menlo,Consolas,monospace" letter-spacing="10" fill="${MUTED}">WEAVE</text>
  <line x1="${pad}" y1="${120}" x2="${size - pad}" y2="${120}" stroke="${MUTED}" stroke-opacity="0.28" />
  ${questionLines}
  <g>${edgeMarkup}${nodeMarkup}</g>
  ${statsMarkup}
  <text x="${pad}" y="${880}" font-size="150" font-weight="800" font-family="Helvetica Neue,Arial,sans-serif" fill="${CORE}" letter-spacing="-4">${consensus.consensusByNodes.toFixed(0)}%</text>
  <text x="${pad}" y="${928}" font-size="26" font-family="Helvetica Neue,Arial,sans-serif" fill="${TEXT}">of the claims both models made</text>
  <text x="${pad}" y="${958}" font-size="22" font-family="Menlo,Consolas,monospace" fill="${MUTED}">consensus measured by node overlap, not by text similarity</text>
  <line x1="${pad}" y1="1000" x2="${size - pad}" y2="1000" stroke="${MUTED}" stroke-opacity="0.28" />
  <text x="${pad}" y="${1030}" font-size="19" font-family="Menlo,Consolas,monospace" fill="${MUTED}">${escapeXml(footer.slice(0, 108))}</text>
</svg>`;
}

export async function downloadShareCardPng(input: ShareCardInput, filename: string): Promise<void> {
  const svg = buildShareCardSvg(input);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const image = new Image();
  image.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Could not rasterise the share card SVG.'));
    image.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1080;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give a 2D canvas context.');
  context.fillStyle = INK;
  context.fillRect(0, 0, 1080, 1080);
  context.drawImage(image, 0, 0, 1080, 1080);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'));
  if (!blob) throw new Error('canvas.toBlob returned nothing.');
  download(blob, filename);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}