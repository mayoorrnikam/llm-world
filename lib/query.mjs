/**
 * Structured queries over the dataset, without an LLM and without a backend.
 *
 *   open weights with 1M context
 *   openai reasoning models 2026
 *   open weights >200K context under $5
 *
 * Charter §56 sketches "question → structured query → dataset → filtering →
 * answer → evidence". This is that, minus the AI: a parser that turns a typed
 * phrase into filters the dataset can answer exactly, so every result is the
 * data rather than a generated sentence about it.
 *
 * Two properties matter more than clever parsing:
 *
 *   1. It reports how it understood you. parse() returns `terms`, which the UI
 *      shows back as chips. A query that silently ignores half of what you
 *      typed is worse than one that says it did.
 *   2. Anything it cannot interpret stays free text and matches names, labs,
 *      families and notes — so a query is never worse than a plain search.
 *
 * Imported by the browser directly; no Node APIs.
 */

import { canonicalDate, contextWindow, parameterCount, displayTags } from './record.mjs';

const SCALE = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** "200k" / "1M" / "128,000" → a number, or null. */
function magnitude(raw) {
  const m = /^([\d.,]+)\s*([kmbt])?$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[2] ? n * SCALE[m[2].toLowerCase()] : n;
}

const CAPABILITIES = new Set([
  'reasoning', 'coding', 'vision', 'audio', 'video', 'tool use', 'tool_use',
  'function calling', 'structured output', 'agentic', 'multilingual',
  'image generation', 'video generation', 'speech generation',
]);

const TYPES = {
  language: 'language', llm: 'language', text: 'language',
  image: 'image_generation', 'image generation': 'image_generation',
  video: 'video_generation', 'video generation': 'video_generation',
};

/**
 * Turn a typed phrase into filters.
 * @returns {{terms: object[], free: string}}
 */
export function parse(input, { companies = [], families = [] } = {}) {
  let s = ` ${String(input || '').toLowerCase()} `;
  const terms = [];
  const take = (re, fn) => {
    s = s.replace(re, (...args) => (fn(...args), ' '));
  };

  // Comparisons first: they contain words later rules would eat.
  take(/\b(?:context|window)\s*(?:>=|>|over|above|at least|more than)\s*([\d.,]+\s*[kmbt]?)/g,
    (_, v) => terms.push({ kind: 'context', op: '>=', value: magnitude(v), label: `context ≥ ${v.trim()}` }));
  take(/\b(?:context|window)\s*(?:<=|<|under|below|less than)\s*([\d.,]+\s*[kmbt]?)/g,
    (_, v) => terms.push({ kind: 'context', op: '<=', value: magnitude(v), label: `context ≤ ${v.trim()}` }));
  // ">200K context" — the operator can lead the number as well as follow the word.
  take(/(?:>=|>)\s*([\d.,]+\s*[kmbt]?)\s*(?:token\s*)?(?:context|window)\b/g,
    (_, v) => terms.push({ kind: 'context', op: '>=', value: magnitude(v), label: `context ≥ ${v.trim()}` }));
  take(/(?:<=|<)\s*([\d.,]+\s*[kmbt]?)\s*(?:token\s*)?(?:context|window)\b/g,
    (_, v) => terms.push({ kind: 'context', op: '<=', value: magnitude(v), label: `context ≤ ${v.trim()}` }));
  // "1M context" / "200k context" reads as a floor, which is what people mean.
  take(/\b([\d.,]+\s*[kmbt])\s*(?:token\s*)?(?:context|window)\b/g,
    (_, v) => terms.push({ kind: 'context', op: '>=', value: magnitude(v), label: `context ≥ ${v.trim()}` }));

  take(/\b(?:params?|parameters)\s*(?:>=|>|over|above|more than)\s*([\d.,]+\s*[kmbt]?)/g,
    (_, v) => terms.push({ kind: 'params', op: '>=', value: magnitude(v), label: `parameters ≥ ${v.trim()}` }));
  take(/\b(?:params?|parameters)\s*(?:<=|<|under|below|less than)\s*([\d.,]+\s*[kmbt]?)/g,
    (_, v) => terms.push({ kind: 'params', op: '<=', value: magnitude(v), label: `parameters ≤ ${v.trim()}` }));

  take(/\b(?:under|below|less than|cheaper than)\s*\$\s*([\d.]+)/g,
    (_, v) => terms.push({ kind: 'price', op: '<=', value: Number(v), label: `input ≤ $${v}` }));
  take(/\b(?:over|above|more than)\s*\$\s*([\d.]+)/g,
    (_, v) => terms.push({ kind: 'price', op: '>=', value: Number(v), label: `input ≥ $${v}` }));

  take(/\bopen[- ]?(?:weights?|source)\b/g,
    () => terms.push({ kind: 'access', value: true, label: 'open weights' }));
  take(/\b(?:proprietary|closed)(?:[- ]weights?)?\b/g,
    () => terms.push({ kind: 'access', value: false, label: 'proprietary' }));

  take(/\bverified\b/g, () => terms.push({ kind: 'verified', label: 'verified records' }));
  take(/\bmultimodal\b/g, () => terms.push({ kind: 'multimodal', label: 'multimodal' }));

  // Years, and ranges like "since 2025".
  take(/\b(?:since|after|from)\s*(20\d{2})\b/g,
    (_, y) => terms.push({ kind: 'year', op: '>=', value: Number(y), label: `since ${y}` }));
  take(/\b(?:before|until)\s*(20\d{2})\b/g,
    (_, y) => terms.push({ kind: 'year', op: '<=', value: Number(y), label: `before ${y}` }));
  take(/\b(20\d{2})\b/g,
    (_, y) => terms.push({ kind: 'year', op: '=', value: Number(y), label: y }));

  // Labs and families come from the dataset, so they stay correct as it grows.
  for (const name of [...companies].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    if (re.test(s)) {
      s = s.replace(re, ' ');
      terms.push({ kind: 'company', value: name, label: name });
    }
  }
  for (const name of [...families].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    if (re.test(s)) {
      s = s.replace(re, ' ');
      terms.push({ kind: 'family', value: name, label: `${name} family` });
    }
  }

  for (const [word, type] of Object.entries(TYPES)) {
    const re = new RegExp(`\\b${word}\\s+models?\\b`, 'g');
    if (re.test(s)) { s = s.replace(re, ' '); terms.push({ kind: 'type', value: type, label: `${word} models` }); }
  }

  for (const cap of [...CAPABILITIES].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${cap}\\b`, 'g');
    if (re.test(s)) {
      s = s.replace(re, ' ');
      terms.push({ kind: 'capability', value: cap.replace(/ /g, '_'), label: cap });
    }
  }

  // Noise words left over from phrasing; dropping them keeps free text clean.
  s = s.replace(/\b(?:show|me|find|list|all|the|with|and|models?|model|that|which|of|in|a|an|is|are)\b/g, ' ');

  // The raw question is kept for ranking. Scoring against the leftover alone
  // fails the common case: "gpt-4" has "gpt" consumed as a family, leaving "4",
  // which matches GPT-4, GPT-4o and GPT-4.5 equally.
  return { terms, free: s.replace(/\s+/g, ' ').trim(), raw: String(input || '').toLowerCase().trim() };
}

/**
 * Apply parsed terms to the dataset.
 *
 * Free text is a SOFT filter. Requiring every word to appear meant one word the
 * parser could not place — "cheap models", "best model" — returned nothing at
 * all, which reads as "the dataset has none of these" when it means "I did not
 * understand you". Words that match nothing anywhere are reported as ignored
 * instead, and the rest of the query still answers.
 *
 * @returns {{results: object[], ignored: string[]}}
 */
export function run(records, { terms, free, raw = '' }) {
  const cmp = (v, op, target) => op === '>=' ? v >= target : op === '<=' ? v <= target : v === target;

  const hay = (r) => `${r.model} ${r.company} ${r.family} ${r.note}`.toLowerCase();
  const words = free ? free.split(/\s+/).filter(Boolean) : [];
  // A word nobody's name or note contains cannot narrow anything; it can only
  // empty the page.
  const ignored = words.filter((w) => !records.some((r) => hay(r).includes(w)));
  const useful = words.filter((w) => !ignored.includes(w));

  const matched = records.filter((r) => {
    for (const t of terms) {
      switch (t.kind) {
        case 'context': {
          const v = contextWindow(r);
          if (v == null || !cmp(v, t.op, t.value)) return false;
          break;
        }
        case 'params': {
          const v = parameterCount(r);
          if (v == null || !cmp(v, t.op, t.value)) return false;
          break;
        }
        case 'price': {
          const p = r.pricing?.[0]?.rates?.input;
          if (p == null || !cmp(p, t.op, t.value)) return false;
          break;
        }
        case 'access':
          if (Boolean(r.access?.open_weights) !== t.value) return false;
          break;
        case 'verified':
          if (r.provenance?.status !== 'verified') return false;
          break;
        case 'multimodal': {
          const m = r.modalities;
          if (!m || (m.input.length <= 1 && m.output.length <= 1)) return false;
          break;
        }
        case 'year': {
          const y = Number(String(canonicalDate(r)).slice(0, 4));
          if (!cmp(y, t.op, t.value)) return false;
          break;
        }
        case 'company':
          if (r.company !== t.value) return false;
          break;
        case 'family':
          if (r.family !== t.value) return false;
          break;
        case 'type':
          if ((r.classification?.primary_type ?? 'language') !== t.value) return false;
          break;
        case 'capability':
          if (!displayTags(r).includes(t.value) && !r.capabilities?.includes(t.value)) return false;
          break;
        default: break;
      }
    }

    if (!useful.length) return true;
    return useful.every((w) => hay(r).includes(w));
  });

  // Rank by how directly the text names the model, so "gpt-4" leads with GPT-4
  // rather than with everything whose name contains a 4.
  const needle = useful.join(' ');
  const flat = (x) => x.replace(/[\s.-]/g, '');
  const score = (r) => {
    const name = r.model.toLowerCase();
    const n = flat(name);
    // The whole question first: an exact name beats everything.
    if (raw && (name === raw || n === flat(raw))) return 4;
    if (raw && n.startsWith(flat(raw))) return 3;
    if (!needle) return 0;
    if (name === needle || n === flat(needle)) return 2;
    if (n.startsWith(flat(needle))) return 1;
    return 0;
  };
  // Score first, then newest — a question about models usually means recent
  // ones, and without the date tiebreak equal-scoring results came out in file
  // order, which is oldest first.
  matched.sort((a, b) => score(b) - score(a)
    || String(canonicalDate(b)).localeCompare(String(canonicalDate(a))));

  return { results: matched, ignored, used: useful.join(' ') };
}
