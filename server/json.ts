/**
 * Tolerant JSON parsing for judge output.
 *
 * Local models fence their JSON, prefix it with "Sure! Here is the JSON:", use
 * smart quotes, leave trailing commas, or write Python literals. A strict
 * JSON.parse would throw on all of those and the whole run would be labelled a
 * fallback when the judge actually answered fine.
 */

export interface LooseParse<T> {
  value: T | null;
  repaired: boolean;
  error?: string;
}

/** Strip markdown fences and leading/trailing prose. */
function stripFences(text: string): string {
  let out = text.trim();
  const fence = out.match(/```(?:json|json5|javascript|js)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().length > 0) out = fence[1].trim();
  return out;
}

/** Quote/whitespace repairs that keep JSON.parse viable. */
function repair(text: string): string {
  return (
    text
      // smart quotes -> straight
      .replace(/[\u201C\u201D\u2033]/g, '"')
      .replace(/[\u2018\u2019\u2032]/g, "'")
      // Python / JS literals
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null')
      .replace(/\bNaN\b/g, 'null')
      // trailing commas before } or ]
      .replace(/,(\s*[}\]])/g, '$1')
      // full-width punctuation some CJK models emit
      .replace(/[\uFF0C]/g, ',')
      .replace(/[\uFF1A]/g, ':')
  );
}

/** Walk from the first bracket to its matching close, ignoring brackets inside strings. */
function sliceBalanced(text: string, open: '[' | '{'): string | null {
  const close = open === '[' ? ']' : '}';
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Single-quoted strings -> double-quoted, only when the text has no valid double quotes there. */
function singleToDouble(text: string): string {
  let out = '';
  let inSingle = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'" && text[i - 1] !== '\\') {
      inSingle = !inSingle;
      out += '"';
      continue;
    }
    if (inSingle && char === '"') out += '\\"';
    else out += char;
  }
  return out;
}

export function parseJsonLoose<T = unknown>(raw: string): LooseParse<T> {
  const text = stripFences(raw ?? '');
  if (text.trim() === '') return { value: null, repaired: false, error: 'empty output' };

  const attempts: { body: string; repaired: boolean }[] = [
    { body: text, repaired: false },
    { body: repair(text), repaired: true },
    { body: repair(singleToDouble(text)), repaired: true },
  ];

  for (const open of ['[', '{'] as const) {
    const balanced = sliceBalanced(repair(text), open);
    if (balanced) attempts.push({ body: balanced, repaired: true });
    const balancedSingle = sliceBalanced(repair(singleToDouble(text)), open);
    if (balancedSingle) attempts.push({ body: balancedSingle, repaired: true });
  }

  let lastError = 'no JSON value found';
  for (const attempt of attempts) {
    const candidate = attempt.body.trim();
    if (!candidate) continue;
    try {
      return { value: JSON.parse(candidate) as T, repaired: attempt.repaired };
    } catch (error) {
      lastError = (error as Error).message;
    }
    // A model that wraps its array in prose may have left a stray bracket pair.
    const trimmed = candidate.replace(/^[^[{]*/, '').replace(/[^}\]]*$/, '');
    if (trimmed && trimmed !== candidate) {
      try {
        return { value: JSON.parse(trimmed) as T, repaired: true };
      } catch (error) {
        lastError = (error as Error).message;
      }
    }
  }
  return { value: null, repaired: false, error: lastError };
}

/** Pull the first array out of whatever shape the judge returned. */
export function pickArray(value: unknown, keys: string[]): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      const found = record[key];
      if (Array.isArray(found)) return found;
    }
    // {"claims": {"items": [...]}} and similar one-level nesting
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') {
        const inner = pickArray(nested, keys);
        if (inner) return inner;
      }
    }
  }
  return null;
}