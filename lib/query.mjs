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

  /**
   * Recency windows — "last 7 days", "past month", "this week".
   *
   * The one shape of question the dataset could answer and the parser could
   * not hear: every date term was an absolute year, so "how many models
   * released in the last 7 days" fell through to free text and matched nothing.
   * A window is resolved to a cutoff at parse time and compared against the
   * canonical date, so it means the same thing wherever it is used.
   */
  const WINDOW = { day: 1, week: 7, fortnight: 14, month: 30, quarter: 91, year: 365 };
  take(/\b(?:in\s+)?(?:the\s+)?(?:last|past|previous)\s+(\d+)\s*(day|week|month|quarter|year)s?\b/g,
    (_, n, unit) => {
      const days = Number(n) * WINDOW[unit];
      terms.push({ kind: 'since', value: days, label: `last ${n} ${unit}${Number(n) === 1 ? '' : 's'}` });
    });
  take(/\b(?:in\s+)?(?:the\s+)?(?:last|past|this)\s+(day|week|fortnight|month|quarter|year)\b/g,
    (_, unit) => terms.push({ kind: 'since', value: WINDOW[unit], label: `last ${unit}` }));
  take(/\b(?:recent(?:ly)?|newly released|just released)\b/g,
    () => terms.push({ kind: 'since', value: 30, label: 'last 30 days' }));

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

  /**
   * Same facet ORs, different facets AND.
   *
   * Every term used to AND, which made whole classes of question unanswerable
   * rather than merely unsupported: "anthropic vs openai" asked for a model
   * belonging to both companies and returned nothing, and so did any two
   * capabilities. Nobody means "and" when they name two labs.
   */
  const byKind = new Map();
  for (const t of terms) (byKind.get(t.kind) ?? byKind.set(t.kind, []).get(t.kind)).push(t);

  const OR_KINDS = new Set(['company', 'family', 'capability', 'type']);

  /**
   * true / false / null, where null means THE DATASET DOES NOT KNOW.
   *
   * This used to return a bare boolean, and a missing value read as a definite
   * no. "Best model for coding with 1M context" then answered with 7 records
   * and silently dropped Claude Opus 5, Claude Sonnet 5 and GPT-5.6 Sol — all
   * of which have the context window, and none of which has `coding` in
   * `capabilities` because nobody has evidenced it yet.
   *
   * That is the one thing TAXONOMY §4 forbids: an unlisted capability means
   * "not evidenced", never "absent". Every renderer in the project honours it —
   * it is the rule that stops "what changed" reporting "− vision" between two
   * Claude releases — and the search box, the one place a reader asks a direct
   * question, was quietly asserting the opposite.
   *
   * So a capability is true when listed and unknown when not. It is never
   * false. A record cannot be excluded for lacking evidence.
   */
  const holds = (r, t) => {
    switch (t.kind) {
      case 'context': {
        const v = contextWindow(r);
        return v == null ? null : cmp(v, t.op, t.value);
      }
      case 'params': {
        const v = parameterCount(r);
        return v == null ? null : cmp(v, t.op, t.value);
      }
      case 'price': {
        const p = r.pricing?.[0]?.rates?.input;
        return p == null ? null : cmp(p, t.op, t.value);
      }
      case 'access': return Boolean(r.access?.open_weights) === t.value;
      case 'verified': return r.provenance?.status === 'verified';
      case 'multimodal': {
        const m = r.modalities;
        return m ? (m.input.length > 1 || m.output.length > 1) : null;
      }
      case 'year': return cmp(Number(String(canonicalDate(r)).slice(0, 4)), t.op, t.value);
      case 'since': {
        const iso = canonicalDate(r);
        if (!iso) return false;
        return (Date.now() - Date.parse(`${iso}T00:00:00Z`)) / 86400000 <= t.value;
      }
      case 'company': return r.company === t.value;
      case 'family': return r.family === t.value;
      case 'type': return (r.classification?.primary_type ?? 'language') === t.value;
      case 'capability':
        // Never false — see above. Listed is evidence; unlisted is silence.
        return displayTags(r).includes(t.value) || r.capabilities?.includes(t.value)
          ? true
          : null;
      default: return true;
    }
  };

  /**
   * Combine terms without letting "unknown" masquerade as "no".
   *
   * Within a facet the terms OR, across facets they AND, and in both cases a
   * definite failure outranks an unknown: a record is only excluded when
   * something it DOES assert rules it out.
   */
  const verdict = (r) => {
    const unsure = [];
    let confirmed = 0;
    for (const [kind, list] of byKind) {
      const vals = list.map((t) => holds(r, t));
      const ok = OR_KINDS.has(kind)
        ? (vals.some((v) => v === true) ? true : vals.some((v) => v === null) ? null : false)
        : (vals.some((v) => v === false) ? false : vals.some((v) => v === null) ? null : true);
      if (ok === false) return { state: false };
      if (ok === true) confirmed++;
      // Name the terms that came back unknown, so the reader is told which fact
      // is missing rather than being handed a mystery pile.
      if (ok === null) unsure.push(...list.filter((t, i) => vals[i] === null).map((t) => t.label));
    }
    return unsure.length
      ? { state: null, why: [...new Set(unsure)], confirmed }
      : { state: true };
  };

  const graded = records.map((r) => [r, verdict(r)]);
  const structured = graded.filter(([, v]) => v.state === true).map(([r]) => r);
  /** Not ruled out, but resting on a field nobody has evidenced yet. */
  const unevidenced = graded.filter(([, v]) => v.state === null)
    .map(([r, v]) => ({ record: r, why: v.why, confirmed: v.confirmed }));

  /**
   * Free text ranks when a filter is present; it only filters when nothing else
   * does.
   *
   * It was documented as a soft filter and implemented as `every()`, so any
   * question phrased as a sentence emptied the page: "best coding model" parsed
   * `coding` correctly and then required "best" and "model" in the same record,
   * and returned nothing. Words around a filter are how people talk, not extra
   * constraints.
   */
  const narrowed = terms.length
    ? structured
    : structured.filter((r) => !useful.length || useful.every((w) => hay(r).includes(w)));

  // Narrowing to nothing is not narrowing. "Which model has the largest context
  // window" parses no filters, so every word became a requirement and the page
  // went empty — even though the dataset answers that question outright. When
  // the words empty a non-empty set they are dropped and reported as ignored,
  // which is what "soft filter" was always supposed to mean.
  const emptied = !narrowed.length && structured.length > 0 && useful.length > 0;
  const matched = emptied ? structured : narrowed;
  if (emptied) { ignored.push(...useful); useful.length = 0; }

  // Rank by how directly the text names the model, so "gpt-4" leads with GPT-4
  // rather than with everything whose name contains a 4.
  const needle = useful.join(' ');
  // With a filter present the free words no longer narrow, so they earn their
  // keep here: a record whose text carries them sorts above one that does not.
  const textHit = (r) => (useful.length && useful.some((w) => hay(r).includes(w)) ? 0.5 : 0);
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
  const rank = (a, b) => (score(b) + textHit(b)) - (score(a) + textHit(a))
    || String(canonicalDate(b)).localeCompare(String(canonicalDate(a)));
  matched.sort(rank);

  /**
   * Near misses, best first — and only the ones worth showing.
   *
   * "Unknown on something" is far too wide a net on its own: coding + 1M
   * context put 105 records here, led by a video model that is unknown on both
   * terms, while Claude Sonnet 5 — which definitely has the context window and
   * is unknown only on coding — sat below it. A reader wants the models the
   * dataset can half-answer for, not every model it cannot answer for at all.
   *
   * So a near miss must confirm at least one facet outright, and those
   * confirming more rank higher.
   */
  const near = terms.length
    ? unevidenced.filter((x) => x.confirmed > 0)
      .sort((a, b) => b.confirmed - a.confirmed || rank(a.record, b.record))
    : [];

  return { results: matched, near, ignored, used: useful.join(' ') };
}

/**
 * A direct answer, when the question has one.
 *
 * Filtering was the whole product, so "how many open-weight models are there"
 * returned fifty cards and left the reader to count them, and "which model has
 * the largest context window" returned nothing at all — it is not a filter, it
 * is a question about the set. The dataset can answer both; nothing was asking
 * it to.
 *
 * Deliberately narrow. Every answer here is a count, an extreme or a
 * comparison computed from the records already matched, so it cannot disagree
 * with the list below it, and it says which record it came from. Where a
 * question is not one of these shapes this returns null and the list stands on
 * its own — no guessing at intent.
 */
export function answer(matched, { raw = '', terms = [] } = {}) {
  const q = String(raw).toLowerCase();
  if (!q.trim()) return null;

  const label = (r) => r.model;
  const byMax = (list, val) => list.filter((r) => val(r) != null)
    .sort((a, b) => val(b) - val(a))[0];
  const byMin = (list, val) => list.filter((r) => val(r) != null)
    .sort((a, b) => val(a) - val(b))[0];

  const ctx = (r) => contextWindow(r);
  const par = (r) => parameterCount(r);
  const price = (r) => r.pricing?.[0]?.rates?.input ?? null;
  const date = (r) => String(canonicalDate(r) ?? '');
  const fmtTokens = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`;
  const fmtParams = (n) => n >= 1e12 ? `${+(n / 1e12).toFixed(2)}T` : `${+(n / 1e9).toFixed(0)}B`;

  // "anthropic vs openai" — a comparison, answered as counts per lab.
  const companies = terms.filter((t) => t.kind === 'company');
  if (companies.length > 1) {
    const counts = companies.map((t) => ({
      name: t.value,
      n: matched.filter((r) => r.company === t.value).length,
    }));
    return {
      text: counts.map((c) => `${c.name} ${c.n}`).join(' · '),
      detail: `tracked releases matching the rest of the question`,
    };
  }

  if (/\bhow many\b|\bhow much\b|\bcount\b|\bnumber of\b/.test(q)) {
    return { text: `${matched.length}`, detail: `release${matched.length === 1 ? '' : 's'} match` };
  }

  const wantsContext = /\bcontext\b|\bwindow\b|\btokens?\b/.test(q);
  const wantsParams = /\bparameters?\b|\bparams\b|\bbiggest model\b|\blargest model\b/.test(q);
  const wantsPrice = /\bprice|\bcost|\bcheap|\bexpensive|\$/.test(q);
  const big = /\blargest\b|\bbiggest\b|\blongest\b|\bhighest\b|\bmost\b|\bmax\b/.test(q);
  const small = /\bsmallest\b|\bshortest\b|\blowest\b|\bleast\b|\bmin\b/.test(q);

  if (wantsPrice && (big || small || /\bcheap/.test(q))) {
    const r = (/\bcheap/.test(q) || small) ? byMin(matched, price) : byMax(matched, price);
    if (r) return { text: `${label(r)} — $${price(r)} per million input tokens`, record: r,
      detail: 'of the releases here that publish a price' };
  }
  if (wantsContext && (big || small)) {
    const r = big ? byMax(matched, ctx) : byMin(matched, ctx);
    if (r) return { text: `${label(r)} — ${fmtTokens(ctx(r))} context`, record: r,
      detail: 'of the releases here that disclose one' };
  }
  if (wantsParams && (big || small)) {
    const r = big ? byMax(matched, par) : byMin(matched, par);
    if (r) return { text: `${label(r)} — ${fmtParams(par(r))} parameters`, record: r,
      detail: 'of the releases here that disclose a parameter count' };
  }
  if (/\bnewest\b|\blatest\b|\bmost recent\b/.test(q)) {
    const r = [...matched].sort((a, b) => date(b).localeCompare(date(a)))[0];
    if (r) return { text: `${label(r)} — ${date(r)}`, record: r, detail: 'the most recent match' };
  }
  if (/\boldest\b|\bfirst\b|\bearliest\b/.test(q)) {
    const r = [...matched].sort((a, b) => date(a).localeCompare(date(b)))[0];
    if (r) return { text: `${label(r)} — ${date(r)}`, record: r, detail: 'the earliest match' };
  }

  return null;
}
