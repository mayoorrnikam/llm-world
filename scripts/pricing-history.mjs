#!/usr/bin/env node
/**
 * Builds a PRICE HISTORY from archived captures of a lab's own pricing page.
 *
 *   node scripts/pricing-history.mjs             report what the captures say
 *   node scripts/pricing-history.mjs --write     record the observations
 *   node scripts/pricing-history.mjs --lab=anthropic
 *
 * WHY THIS IS THE MISSING PIECE
 *
 * This dataset's pitch is how models change over time, and 0 of 186 records
 * carried more than one price observation. Every price was a single point,
 * recorded the day somebody looked, with nothing behind it — "historical" was
 * aspirational rather than true.
 *
 * The Wayback CDX index fixes that and the availability API never could. The
 * availability API answers "is there a capture near this date"; CDX answers
 * "list every capture", which is the actual question. One request returns
 * hundreds of dated snapshots of a page whose whole job is to state prices.
 *
 * COLLAPSING, AND WHY MONTHLY
 *
 * 329 captures of Anthropic's pricing page is more fetching than the answer is
 * worth, and collapse=digest barely helps: marketing pages churn their markup
 * so the digests differ even when the prices do not. collapse=timestamp:6 gives
 * one capture per month, which turns 329 into 10 and is the resolution a price
 * change actually has.
 *
 * THE VALUE COMES FROM THE CAPTURE, NEVER FROM AN AGGREGATOR
 *
 * LiteLLM knows when prices changed and is MIT-licensed and accurate, and it is
 * still not the source of a single figure here (METHODOLOGY §5). Every rate
 * below is read off a snapshot of the lab's own page, and cites that snapshot.
 * The archive is what makes a past price checkable at all: a live pricing page
 * proves today's price and nothing about last March.
 *
 * WHAT IT WILL NOT DO
 *
 * It records an observation only where the price CHANGED from the previous
 * capture. Ten captures of an unchanged price are one fact, not ten, and
 * writing them all would inflate the history it is meant to establish.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import { sourceText, FAILED } from '../lib/source-text.mjs';
import { flat } from '../lib/model-docs.mjs';

const WRITE = process.argv.includes('--write');
const LAB = (process.argv.find((a) => a.startsWith('--lab='))?.split('=')[1] ?? 'anthropic').toLowerCase();
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One lab, one page, one parser — the same line drawn in lib/model-docs.mjs.
 *
 * Anthropic's table is Model | Base Input | 5m Cache Writes | 1h Cache Writes |
 * Cache Hits | Output, so a row is a name followed by exactly five "$n / MTok".
 * The header is checked before any row is trusted: taking column 1 and column 5
 * on faith is how the benchmark reader once gave every model the same figures.
 */
const LABS = {
  anthropic: {
    company: 'Anthropic',
    url: 'https://platform.claude.com/docs/en/about-claude/pricing',
    header: /Model\s+Base Input Tokens[\s\S]{0,80}?Output Tokens/i,
    parse(s) {
      const out = new Map();
      const row = /(Claude [A-Za-z0-9.\s]{2,24}?)\s*(?:\(\s*deprecated\s*\)\s*)?((?:\$[\d.]+\s*\/\s*MTok\s*){5})/g;
      for (const m of s.matchAll(row)) {
        const cells = [...m[2].matchAll(/\$([\d.]+)\s*\/\s*MTok/g)].map((x) => Number(x[1]));
        if (cells.length !== 5) continue;
        const name = m[1].trim();
        // Base input is the first column, output the last. The three between
        // are cache rates, which `pricing[].rates` has no place for.
        if (!out.has(name)) out.set(name, { input: cells[0], output: cells[4] });
      }
      return out;
    },
  },
  openai: {
    company: 'OpenAI',
    url: 'https://developers.openai.com/api/docs/pricing',
    header: /Short context[\s\S]{0,120}?Long context[\s\S]{0,160}?Model\s+Input\s+Cached input/i,
    /**
     * EIGHT price columns, not two, and the difference is expensive.
     *
     *   Short context                    Long context
     *   Model | Input | Cached | Writes | Output | Input | Cached | Writes | Output
     *   gpt-5.6-sol  $5.00 $0.50 $6.25 $30.00  $10.00 $1.00 $12.50 $45.00
     *
     * Reading "the first figure and the last" — the obvious shape, and what the
     * xAI table genuinely is — records $45.00 as GPT-5.6 Sol's output rate. That
     * is the LONG-context price, half again the real one, and it would look
     * entirely plausible sitting in the field. Base input is column 1, base
     * output column 4.
     *
     * Rows also carry "-" where a tier does not apply:
     *
     *   gpt-5.5  $5.00 $0.50 - $30.00  $10.00 $1.00 - $45.00
     *
     * so a pattern demanding eight dollar figures silently skips exactly the
     * models with the simplest pricing. Cells are matched as "$n OR -", and a
     * row whose first or fourth cell is a dash is dropped rather than guessed.
     */
    parse(s) {
      const out = new Map();
      const row = /\b([a-z][\w.\-]{2,28})\s+((?:(?:\$[\d.]+|-)\s+){7}(?:\$[\d.]+|-))/g;
      for (const m of s.matchAll(row)) {
        const cells = m[2].trim().split(/\s+/);
        if (cells.length !== 8) continue;
        const num = (c) => (c === '-' ? null : Number(c.replace('$', '')));
        const input = num(cells[0]);
        const output = num(cells[3]);
        if (input == null || output == null) continue;
        const name = m[1].trim();
        if (!out.has(name)) out.set(name, { input, output });
      }
      return out;
    },
    note: 'Short-context base input and output as the page read on this date. '
      + 'OpenAI prices long-context requests higher and cached input lower; '
      + 'neither is recorded here.',
  },
};

const lab = LABS[LAB];
if (!lab) { console.error(`no page configured for --lab=${LAB}`); process.exit(2); }

/** Every capture of the page, one per month. */
async function captures(url) {
  const q = `http://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}`
    + '&output=json&filter=statuscode:200&collapse=timestamp:6&fl=timestamp';
  const res = await fetch(q, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`CDX HTTP ${res.status}`);
  const rows = await res.json();
  return rows.slice(1).map((r) => r[0]).sort();
}

const iso = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

const stamps = await captures(lab.url);
console.log(`${lab.company}: ${stamps.length} monthly captures, ${iso(stamps[0])} → ${iso(stamps[stamps.length - 1])}\n`);

/** model name → [{ on, input, output, archived }] in capture order. */
const timeline = new Map();
let read = 0, unreadable = 0, headerless = 0, empty = 0;

for (const ts of stamps) {
  const archived = `https://web.archive.org/web/${ts}/${lab.url}`;
  const t = await sourceText(archived, { cache: true });
  await sleep(2500); // CDX and the replay hosts both throttle; pacing is the answer.
  if (typeof t !== 'string' || t === FAILED) { unreadable++; continue; }
  const s = t.replace(/\s+/g, ' ');
  // A capture that does not carry the header is a redirect, a consent wall or a
  // redesign — never something to read columns out of by position.
  if (!lab.header.test(s)) { headerless++; continue; }
  read++;

  const rows = lab.parse(s);
  // A capture whose header matches but whose rows do not is the dangerous case:
  // it looks like a successful read and contributes nothing, so a price history
  // silently starts at whichever capture happened to parse. Say so.
  if (!rows.size) {
    console.log(`  ! ${iso(ts)} header present, 0 rows parsed — layout differs, not read`);
    empty++;
  }
  for (const [name, rates] of rows) {
    const list = timeline.get(name) ?? [];
    const last = list[list.length - 1];
    // Only a CHANGE is a fact. Ten captures of one price is one observation.
    if (!last || last.input !== rates.input || last.output !== rates.output) {
      list.push({ on: iso(ts), ...rates, archived });
      timeline.set(name, list);
    }
  }
}

console.log(`\nread ${read} captures · ${unreadable} unreadable · ${headerless} without the pricing table`
  + `${empty ? ` · ${empty} parsed no rows` : ''}\n`);

const records = data.releases.filter((r) => r.company === lab.company);
let touched = 0, added = 0;

for (const [name, points] of [...timeline].sort()) {
  const r = records.find((x) => flat(x.model) === flat(name));
  if (!r) {
    console.log(`  · ${name.padEnd(22)} ${points.length} price point(s) — no record`);
    continue;
  }
  // Never restate what the record already holds, and never overwrite it.
  const have = new Set((r.pricing ?? []).map((p) => `${p.rates.input}/${p.rates.output}`));
  const fresh = points.filter((p) => !have.has(`${p.input}/${p.output}`));
  const label = points.map((p) => `${p.on} $${p.input}/$${p.output}`).join('  →  ');
  console.log(`  ${fresh.length ? '✓' : '·'} ${r.model.padEnd(22)} ${label}`);
  if (!fresh.length) continue;
  touched++;
  added += fresh.length;

  if (WRITE) {
    r.pricing ??= [];
    for (const p of fresh) {
      const sid = `${r.id}-price-${p.on.replace(/-/g, '')}`;
      if (!r.sources.some((s) => s.id === sid)) {
        r.sources.push({
          id: sid,
          url: lab.url,
          type: 'official_documentation',
          authority: 'primary',
          archived_url: p.archived,
          retrieved: p.on,
        });
      }
      r.pricing.push({
        unit: 'per_million_tokens',
        rates: { input: p.input, output: p.output },
        currency: 'USD',
        observed_on: p.on,
        sources: [sid],
        note: lab.note ?? 'Base input and output rates as the page read on this date. '
          + 'Cache writes and cache hits are priced separately and are not recorded here.',
      });
    }
    r.pricing.sort((a, b) => a.observed_on.localeCompare(b.observed_on));
  }
}

console.log(`\n${added} observation(s) across ${touched} record(s)`);
if (WRITE && added) { saveDataset(data); console.log('wrote data/llm-releases.json'); }
else if (!WRITE) console.log('dry run — pass --write to record');
