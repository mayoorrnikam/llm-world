#!/usr/bin/env node
/**
 * Drafts a release spec from a URL, and says what it could not work out.
 *
 *   node scripts/draft-from-url.mjs <url> [--model="X"] [--company="Y"] [--date=YYYY-MM-DD]
 *   node scripts/draft-from-url.mjs <url> --json          machine-readable spec only
 *
 * The bot half of the submission flow. It does the tedious work — fetch the
 * page, confirm it is readable and actually about the model, ask the Wayback
 * Machine for a snapshot, pull out the figures the page states — and produces a
 * spec.json for add-model.mjs plus a report of everything it could not settle.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not decide whether the draft is correct. A fetcher can tell you a
 * page loaded; it cannot tell you the page says what was extracted from it, and
 * this project has had a benchmark parser read scores off by one, a PDF reader
 * return bitmap noise as prose, and a citation return HTTP 200 from a different
 * model's page. Each of those was caught by a person looking. So this writes a
 * draft for review and never touches the dataset.
 *
 * It also does not guess. Every figure below is either quoted from the page or
 * left out, because a spec with an invented parameter count is worse than a
 * spec with a gap — the gap gets researched, the guess gets published.
 */

import { writeFileSync } from 'node:fs';
import { sourceText } from '../lib/source-text.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const JSON_ONLY = args.includes('--json');

if (!url) {
  console.error('usage: node scripts/draft-from-url.mjs <url> [--model="X"] [--company="Y"] [--date=YYYY-MM-DD]');
  process.exit(1);
}

const say = (...a) => { if (!JSON_ONLY) console.log(...a); };

/* ------------------------------------------------------------------ read */

const text = await sourceText(url, { cache: false });
if (!text) {
  console.error(`could not read ${url}\n`
    + 'The page may be client-rendered, may block automated fetches, or may be a\n'
    + 'format this reader does not handle. A source that cannot be read cannot be\n'
    + 'cited, so there is nothing to draft.');
  process.exit(2);
}
say(`read ${text.length.toLocaleString('en-US')} characters from ${url}`);

const model = flag('model');
const company = flag('company');

// A page that never names the model is the wrong page — the exact failure that
// put a hollow citation on gpt-5-3-codex, where a docs URL archived as
// navigation and evidenced nothing it was cited for.
if (model && !new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
  say(`\n⚠ the page never names "${model}" — check the URL is this model's own page`);
}

/* --------------------------------------------------------------- extract */

const gaps = [];

/** A figure the page states, or nothing. Never a guess. */
function stated(label, patterns, transform = (x) => x) {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return { value: transform(m[1]), quote: m[0].replace(/\s+/g, ' ').trim().slice(0, 140) };
  }
  gaps.push(label);
  return null;
}

const num = (s) => Number(String(s).replace(/,/g, ''));

// "256k context window" — the magnitude suffix broke the first pattern, and the
// fallback then read digits from the far side of the phrase and produced 0. A
// context window of zero is not a value; the parse failed and said nothing.
const MAG = { k: 1e3, m: 1e6 };
const toTokens = (raw) => {
  const m = /^([\d.,]+)\s*([km])?$/i.exec(String(raw).trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? MAG[m[2].toLowerCase()] : 1);
  return n > 0 ? Math.round(n) : null;
};

const context = stated('context window', [
  /([\d.,]+\s*[km]?)\s*(?:token[- ]?)?context window/i,
  /context window\s*(?:of|:)?\s*([\d.,]+\s*[km]?)\b/i,
  /([\d.,]+\s*[km]?)[- ]token context/i,
], toTokens);

const params = stated('parameter count', [
  /\b([\d.]+)\s*(?:billion|B)\s+(?:total\s+)?parameters?\b/i,
  // "a 30-billion-parameter model" — hyphenated and singular, which is how
  // Meta writes it and how the first version of this missed it.
  /\b([\d.]+)[- ]billion[- ]parameter\b/i,
  /\bparameters?\s*[:=]\s*([\d.]+)\s*[Bb]\b/i,
], (s) => Math.round(Number(s) * 1e9));

const licence = stated('licence', [
  /\b(Apache[- ]2\.0|MIT|BSD-3-Clause|CC BY(?:-[A-Z]{2})?[- ]?4\.0)\b/i,
]);

// Labs date their posts in prose far more often than in ISO. Both forms are
// read and normalised; nothing is inferred when neither appears.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const toIso = (raw) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(raw);
  if (!m) return raw;
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return raw;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
};

/**
 * Dates on a model page that are NOT its release date.
 *
 * Caught by drafting Grok 4.6 from xAI's own documentation, which reads "The
 * knowledge cut-off date of Grok 4.6 is February 1, 2026". The first date on
 * the page was taken as the release date, and an automatically opened pull
 * request would have proposed February for a model that shipped in August.
 *
 * These are stripped before any date is looked for, rather than filtered
 * afterwards, because the surrounding words are the only thing distinguishing
 * them — the dates themselves look identical.
 */
// The window must not stop at a full stop: "knowledge cut-off date of Grok 4.6
// is February 1, 2026" contains one inside the model's own name, so a [^.]
// bound ended the match before it ever reached the date it was meant to remove.
const NOT_A_RELEASE_DATE = [
  /knowledge cut[- ]?off[^\n]{0,70}/gi,
  /training data[^\n]{0,70}/gi,
  /cut[- ]?off date[^\n]{0,70}/gi,
  /deprecat\w+[^\n]{0,70}/gi,
  /retire\w*[^\n]{0,70}/gi,
  /shutdown[^\n]{0,70}/gi,
  // A page timestamp. xAI's model page ends "Last updated: August 12, 2026",
  // which is when the DOCS changed — proposing it as a release date would date
  // every model to whenever the draft happened to run.
  /last updated[^\n]{0,70}/gi,
  /last modified[^\n]{0,70}/gi,
  /©[^\n]{0,40}/g,
];

const dateText = NOT_A_RELEASE_DATE.reduce((t, p) => t.replace(p, ' '), text);

/**
 * schema.org datePublished, which is the most reliable date on a modern
 * announcement and the one the text reader never sees.
 *
 * sourceText strips <script> before returning prose, so the JSON-LD block goes
 * with it. That block is a machine-readable declaration by the lab — xAI's
 * Grok 4.6 page carries "datePublished":"2026-08-12T00:00:00Z" — and it does
 * not depend on the dateline being written in a format the patterns happen to
 * know. The prose fallback below missed "Aug 12, 2026" in one of my own checks
 * for exactly that reason.
 */
async function publishedDate(u) {
  try {
    const res = await fetch(u, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world draft)' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      const found = /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(m[1]);
      if (found) return found[1];
    }
  } catch { /* a missing block is not a finding */ }
  return null;
}

const structuredDate = await publishedDate(url);

const date = flag('date') ?? structuredDate ?? (() => {
  for (const p of [
    // A date the page ties to shipping outranks a bare one.
    /\b(?:released|announced|launched|available)\b[^.]{0,30}?((?:January|February|March|April|May|June|July|August|September|October|November|December)\.?\s+\d{1,2},?\s+20\d{2})/i,
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+20\d{2})\b/,
  ]) {
    const m = p.exec(dateText);
    if (m) return toIso(m[1]);
  }
  gaps.push('announcement date');
  return null;
})();

const openWeights = /\bopen[- ]weights?\b|\bweights? (?:are )?(?:available|released)\b|huggingface\.co/i.test(text);

/* --------------------------------------------------------------- archive */

let archived = null;
try {
  const res = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(25000) });
  const j = await res.json();
  const snap = j?.archived_snapshots?.closest;
  if (snap?.available) archived = { url: snap.url.replace(/^http:/, 'https:'), timestamp: snap.timestamp };
} catch { /* archive.org is a donated service; a failure here is not a finding */ }

if (archived) say(`snapshot available: ${archived.timestamp}`);
else {
  say('no snapshot yet — `npm run enrich` will request one, and R1 is unmet until it exists');
  gaps.push('archived snapshot');
}

/* ----------------------------------------------------------------- spec */

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// A draft with no date is not a draft. Documentation pages routinely carry a
// knowledge cutoff and a last-updated stamp and no release date at all, which
// is exactly the shape that produced a February date for an August model and
// then today's date for the same one. Rather than emit a spec with a hole, this
// says what is missing and exits non-zero, so an automated caller opens no pull
// request and asks for the announcement URL instead.
if (!date && !JSON_ONLY) {
  console.error(`\ncannot draft ${model ?? url}: no release date on this page.\n`
    + 'Documentation pages state a knowledge cutoff and a last-updated stamp;\n'
    + 'neither is a release date. Point this at the announcement instead.');
  process.exit(3);
}

const spec = {
  company: company ?? 'UNKNOWN — fill this in',
  family: model ? model.split(/[\s-]/)[0] : 'UNKNOWN',
  models: [{
    id: model ? slug(model) : 'unknown-id',
    model: model ?? 'UNKNOWN — fill this in',
    date: date ?? 'UNKNOWN — the page states no date',
    note: 'One sentence on what makes this release notable.',
    sources: [{ url, type: 'official_announcement' }],
    open_weights: openWeights,
    ...(licence && openWeights ? { license: licence.value } : {}),
    ...(params ? { parameter_count: params.value } : {}),
    ...(context?.value ? { context_window: context.value } : {}),
    primary_type: 'language',
  }],
};

if (JSON_ONLY) {
  console.log(JSON.stringify(spec, null, 2));
} else {
  writeFileSync('draft-spec.json', JSON.stringify(spec, null, 2) + '\n');
  say('\n--- drafted -------------------------------------------------');
  for (const [label, got] of [['context window', context], ['parameter count', params], ['licence', licence]]) {
    if (got) say(`  ${label.padEnd(16)} ${got.value}   “${got.quote}”`);
  }
  say(`  ${'open weights'.padEnd(16)} ${openWeights}`);
  say(`  ${'date'.padEnd(16)} ${date ?? '—'}${
    date && structuredDate === date ? '   (schema.org datePublished)' : date ? '   (read from the page text)' : ''}`);

  say(`\n--- a person still has to settle ----------------------------`);
  for (const g of gaps) say(`  · ${g}`);
  say('  · whether every figure above is really about this model');
  say('  · modalities and capabilities — the detectors read those from the');
  say('    sources during `npm run enrich`, never from this draft');

  say('\nwrote draft-spec.json — review it, then:');
  say('  node scripts/add-model.mjs draft-spec.json --write && npm run enrich && npm run check');
}
