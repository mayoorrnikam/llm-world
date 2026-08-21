#!/usr/bin/env node
/**
 * Reads the docs corpus a lab publishes for machines, and fills in what it
 * states about models we already hold.
 *
 *   node scripts/llms-txt-bridge.mjs                  what the docs state that we lack
 *   node scripts/llms-txt-bridge.mjs --specs=out.json write apply-specs.mjs input
 *   node scripts/llms-txt-bridge.mjs --lab=xAI        one lab
 *
 * WHY THIS EXISTS
 *
 * hf-bridge closed the gap between "noticed" and "reviewable" for open-weights
 * models, because a Hugging Face card is a document the lab publishes about one
 * model. Closed labs have no such document. A docs INDEX lists twenty models at
 * once, so extracting a context window from it attaches whichever figure
 * appeared first to whichever model you were asking about, and the per-model
 * page — where one exists at all — is a client-rendered shell whose readable
 * text is navigation chrome.
 *
 * llms.txt is the way through. Labs publish their documentation as one Markdown
 * file so that models can read it, which means the specification tables their
 * website renders in JavaScript are sitting in plain text, with headers saying
 * which column is which. It is the lab's own document, served from the lab's
 * own domain: primary, by METHODOLOGY §5, exactly like the docs pages already
 * cited throughout this dataset.
 *
 * WHAT IT CANNOT DO, AND WHY THAT SHAPES EVERYTHING
 *
 * It cannot date a release. A model card at least has a repo-creation date —
 * wrong, but present and replaceable. A docs table has no date at all: it
 * describes what the lab serves TODAY and says nothing about when any of it
 * arrived.
 *
 * So this never drafts a new record. A record needs a date, and inventing one
 * from a docs table would be this project publishing a date no source states.
 * What it does instead is fill in FACTS about records we already have — a
 * context window that is currently null, traced to the lab's own page. Untracked
 * ids are reported as candidates and stop there, still needing an announcement.
 *
 * That asymmetry is the whole difference between the two bridges:
 *
 *   hf-bridge        card per model, has a date  -> can draft a RECORD
 *   llms-txt-bridge  table per lab, has no date  -> can only fill in FIELDS
 */

import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--limit=0')) process.exit(0);

const ONLY = process.argv.find((a) => a.startsWith('--lab='))?.split('=')[1];
const SPECS = process.argv.find((a) => a.startsWith('--specs='))?.split('=')[1];

/** 33MB of Markdown is not worth fetching twice a day to read one table. */
const MAX_BYTES = 12_000_000;

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const flat = (s) => String(s).toLowerCase().replace(/[\s._-]/g, '');

/**
 * Where to look, derived from documentation this dataset already cites.
 *
 * Same principle as scan-labs: the channel list cannot drift from the data,
 * because it IS the data. A lab whose docs we cite is a lab whose llms.txt is
 * worth probing.
 */
function origins() {
  const byLab = new Map();
  for (const r of data.releases) {
    for (const s of r.sources ?? []) {
      if (s.type !== 'official_documentation') continue;
      let origin;
      try { origin = new URL(s.url).origin; } catch { continue; }
      if (!byLab.has(r.company)) byLab.set(r.company, new Map());
      const m = byLab.get(r.company);
      m.set(origin, (m.get(origin) ?? 0) + 1);
    }
  }
  const out = [];
  for (const [lab, m] of byLab) {
    if (ONLY && lab.toLowerCase() !== ONLY.toLowerCase()) continue;
    // The origin most records cite is the one the lab actually maintains.
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ lab, origin: best });
  }
  return out;
}

async function corpus(origin) {
  // llms.txt is the index and llms-full.txt the whole corpus; which one carries
  // the tables differs by lab, so try both and keep whichever has more.
  let best = null;
  for (const path of ['/llms.txt', '/llms-full.txt']) {
    try {
      const res = await fetch(origin + path, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world source-reader)' },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) continue;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_BYTES) { best ??= { path, tooBig: len }; continue; }
      const text = await res.text();
      if (text.length > MAX_BYTES) { best ??= { path, tooBig: text.length }; continue; }
      const rows = (text.match(/^\|.*\|$/gm) ?? []).length;
      if (!best || rows > (best.rows ?? -1)) best = { path, text, rows };
    } catch { /* a host that will not answer is not a lab with no models */ }
  }
  return best;
}

/* ------------------------------------------------------------------ tables */

/** "500k" -> 500000, "2M" -> 2000000, "128,000" -> 128000. */
function tokens(cell) {
  const m = /^\s*~?\s*([\d.,]+)\s*([km])?\b/i.exec(String(cell).replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = m[2] ? (m[2].toLowerCase() === 'm' ? 1e6 : 1e3) : 1;
  const v = Math.round(n * mult);
  // A context window below 1000 is a price or a rate limit in the wrong column.
  return v >= 1000 ? v : null;
}

/**
 * Markdown tables, as header plus rows.
 *
 * Only tables whose header names a model column AND a context column are read.
 * A docs corpus is full of tables — rate limits, error codes, SDK parameters —
 * and a positional guess would read an error code as a context window.
 */
function specTables(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\|.*\|\s*$/.test(lines[i])) continue;
    const block = [];
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
    if (block.length < 3) continue;
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(block[0]).map((h) => h.toLowerCase());
    if (!/^-{2,}|^:?-+:?$/.test(cells(block[1])[0] ?? '')) continue;   // separator row
    const mi = head.findIndex((h) => /\bmodels?\b|\bname\b|\bid\b/.test(h));
    const ci = head.findIndex((h) => /context|window|max.*input|input.*length/.test(h));
    if (mi < 0 || ci < 0) continue;
    for (const row of block.slice(2)) {
      const c = cells(row);
      if (c.length < head.length - 1) continue;
      // "grok-4.6 (< 200k prompt tokens)" is one model with tiered pricing.
      const name = (c[mi] ?? '').replace(/\(.*?\)/g, '').replace(/[`*]/g, '').trim();
      const ctx = tokens(c[ci]);
      if (name && ctx) out.push({ name, context_window: ctx });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- run */

const ctxOf = (r) => (r.specifications?.language ?? {}).context_window ?? null;

const filled = [];
const candidates = [];
const notes = [];

for (const { lab, origin } of origins()) {
  const got = await corpus(origin);
  if (!got) { notes.push(`**${lab}** — ${origin} publishes no llms.txt`); continue; }
  if (got.tooBig) {
    notes.push(`**${lab}** — ${origin}${got.path} is ${(got.tooBig / 1e6).toFixed(0)}MB, over the `
      + `${MAX_BYTES / 1e6}MB cap, and was not read`);
    continue;
  }

  /**
   * One model, one entry.
   *
   * A model appears in several tables — text pricing, tiered pricing, a
   * capability matrix — so a raw pass lists grok-4.3 six times. Where those
   * tables disagree the disagreement is REPORTED rather than resolved: picking
   * the larger, or the first, would be this script deciding a fact.
   */
  const merged = new Map();
  for (const row of specTables(got.text)) {
    const k = flat(row.name);
    if (!merged.has(k)) merged.set(k, { name: row.name, values: new Set() });
    merged.get(k).values.add(row.context_window);
  }
  const rows = [];
  for (const { name, values } of merged.values()) {
    if (values.size === 1) rows.push({ name, context_window: [...values][0] });
    else {
      notes.push(`**${lab}** — \`${name}\` is given ${[...values].map((v) => v.toLocaleString('en-US')).join(' and ')} `
        + `in different tables on ${origin}${got.path} — needs a person`);
    }
  }
  if (!rows.length) { notes.push(`**${lab}** — ${origin}${got.path} has no table naming a model and a context window`); continue; }

  const mine = data.releases.filter((r) => r.company === lab);
  const url = origin + got.path;

  for (const row of rows) {
    const rec = mine.find((r) => flat(r.id) === flat(row.name) || flat(r.model) === flat(row.name));
    if (!rec) {
      candidates.push({ lab, name: row.name, context_window: row.context_window, url });
      continue;
    }
    // Only what we do not already hold. This fills gaps; it never overwrites a
    // figure a person already traced, and a disagreement is a thing to look at
    // rather than a thing to silently resolve.
    const have = ctxOf(rec);
    if (have == null) {
      filled.push({ id: rec.id, model: rec.model, lab, context_window: row.context_window, url });
    } else if (have !== row.context_window) {
      notes.push(`**${lab}** — \`${rec.id}\` holds ${have.toLocaleString('en-US')} but `
        + `${url} states ${row.context_window.toLocaleString('en-US')} — needs a person`);
    }
  }
}

/* ----------------------------------------------------------------- report */

console.log('## What the labs\' own machine-readable docs state\n');

if (filled.length) {
  console.log(`${filled.length} context window${filled.length === 1 ? '' : 's'} this dataset records `
    + `as unresearched, stated by the lab's own documentation.\n`);
  console.log('| Record | Lab | Context window | Stated by |');
  console.log('| --- | --- | --- | --- |');
  for (const f of filled) {
    console.log(`| \`${f.id}\` | ${f.lab} | ${f.context_window.toLocaleString('en-US')} | [llms.txt](${f.url}) |`);
  }
  console.log();
} else {
  console.log('_No unresearched context window is stated by a lab\'s llms.txt._\n');
}

if (candidates.length) {
  console.log(`### Served, documented, and not tracked\n`);
  console.log(`${candidates.length} model${candidates.length === 1 ? '' : 's'} named in a lab's own `
    + `docs with a context window, and absent from this dataset. **No draft is written for these**: `
    + `a docs table says what is served today and never when it arrived, and a record needs a date `
    + `a source states.\n`);
  for (const c of candidates.slice(0, 30)) {
    console.log(`- **${c.lab}** \`${c.name}\` — ${c.context_window.toLocaleString('en-US')} tokens — ${c.url}`);
  }
  if (candidates.length > 30) console.log(`- _…and ${candidates.length - 30} more._`);
  console.log();
}

if (notes.length) {
  console.log('### Channels and disagreements\n');
  for (const n of notes) console.log(`- ${n}`);
  console.log();
}

/**
 * WHY THIS WRITES A FILE INSTEAD OF THE DATASET
 *
 * The values here are stated by a primary source, and that is still not enough
 * to merge unattended. `verified` in this project means a value is traced to an
 * ARCHIVED primary source, so applying these to nine records made the validator
 * fail six of them: the figure was right, the citation was live-only, and a
 * live URL is not evidence a year from now.
 *
 * archive-sources found no snapshot of any llms.txt, and asking for one writes
 * to a third-party service, which is opt-in everywhere in this repo. So the
 * order is: archive.yml captures the corpus on its daily run, attribute-facts
 * traces the figure inside it, and only then does the value belong in a record.
 * This writes the file that waits for that.
 */
if (SPECS && filled.length) {
  writeFileSync(SPECS, `${JSON.stringify({
    results: filled.map((f) => ({
      id: f.id,
      context_window: f.context_window,
      sources: [{ field: 'context_window', url: f.url }],
    })),
  }, null, 2)}\n`);
  console.log(`_Wrote ${filled.length} value(s) to ${SPECS}._\n\n`
    + '_Do not merge these until the corpus is archived. `verified` here means traced to an '
    + 'ARCHIVED primary source, so applying them now fails validation on records that are '
    + 'currently sound — the figure is right and the citation is live-only. Let archive.yml '
    + 'capture the file, then `attribute-facts --redo`._');
}

console.log('\n_llms.txt is the lab\'s own document, served from the lab\'s own domain, so it is a '
  + 'PRIMARY source for what it states. It states no dates, so it can fill in a record and never '
  + 'create one._');
