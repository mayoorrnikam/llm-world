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
    header: /Short context[\s\S]{0,120}?Long context[\s\S]{0,200}?Model\s+Input\s+Cached input/i,
    /**
     * The column layout CHANGES, so it is read from the header every time.
     *
     * Two layouts of the same page, five months apart:
     *
     *   2026-04  Model | Input | Cached input | Output | Input | Cached input | Output
     *   2026-08  Model | Input | Cached | Cache writes | Output | Input | Cached | Writes | Output
     *
     * Base output is the third cell in one and the fourth in the other. A
     * parser that hard-codes either is right for half the archive and
     * confidently wrong for the rest — and "wrong" here means quoting the
     * LONG-context rate, $45.00 where the answer is $30.00, which is a plausible
     * number in the correct units that nothing downstream would question.
     *
     * So the header is parsed into column names and Output is located by name,
     * which is the same discipline lib/benchmark-table.mjs exists to enforce.
     * The short-context group is everything up to the first Output; the same
     * labels repeat afterwards for long context and are ignored.
     *
     * Rows carry "-" where a tier does not apply (gpt-5.4-mini has no long
     * context), so cells match "$n OR -" and a row missing either figure it
     * needs is dropped rather than guessed.
     */
    parse(s) {
      const LABELS = ['Cached input', 'Cache writes', 'Input', 'Output'];
      const head = /Model((?:\s+(?:Cached input|Cache writes|Input|Output))+)/.exec(s);
      if (!head) return new Map();
      const cols = [];
      let rest = head[1];
      while (rest.trim()) {
        const label = LABELS.find((l) => rest.trim().startsWith(l));
        if (!label) break;
        cols.push(label);
        rest = rest.trim().slice(label.length);
      }
      const outputAt = cols.indexOf('Output');
      const inputAt = cols.indexOf('Input');
      if (outputAt < 0 || inputAt < 0 || inputAt > outputAt) return new Map();
      const perRow = cols.length;

      const out = new Map();
      const row = new RegExp(`\\b([a-z][\\w.\\-]{2,28})\\s+((?:(?:\\$[\\d.]+|-)\\s+){${perRow - 1}}(?:\\$[\\d.]+|-))`, 'g');
      for (const m of s.matchAll(row)) {
        const cells = m[2].trim().split(/\s+/);
        if (cells.length !== perRow) continue;
        const num = (c) => (c === '-' ? null : Number(c.replace('$', '')));
        const input = num(cells[inputAt]);
        const output = num(cells[outputAt]);
        if (input == null || output == null) continue;
        if (!out.has(m[1].trim())) out.set(m[1].trim(), { input, output });
      }
      return out;
    },
    note: 'Short-context base input and output as the page read on this date. '
      + 'OpenAI prices long-context requests higher and cached input lower; '
      + 'neither is recorded here.',
  },
  google: {
    company: 'Google DeepMind',
    url: 'https://ai.google.dev/gemini-api/docs/pricing',
    header: /Input price[\s\S]{0,400}?Output price/i,
    /**
     * Labels, not columns — which makes this the safest of the three.
     *
     * Google does not publish a price table. Each model gets a block:
     *
     *   Gemini 3.6 Flash  gemini-3.6-flash  …
     *   Standard   Free Tier   Paid Tier, per 1M tokens in USD
     *   Input price                          Free of charge   $1.50
     *   Output price (including thinking tokens)  Free of charge   $7.50
     *   Context caching price                Free of charge   $0.15
     *
     * A figure is found by the label above it rather than by counting cells, so
     * the layout drift that broke the OpenAI parser across five months cannot
     * bite here. "Free of charge" carries no dollar sign, so the first $ after
     * a label is the paid rate — and anchoring on the label is what stops
     * Context caching, one line further down, being read as the output price.
     *
     * The block is cut at the next model id. Without that boundary a model
     * whose own block omits a price silently inherits the next model's, which
     * is the same failure as reading a Related-stories date as this article's.
     */
    parse(s) {
      const out = new Map();
      const ids = [...s.matchAll(/\b(gemini-[\d.]+[a-z0-9-]*)\b/g)];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i][1];
        if (out.has(id)) continue;
        const from = ids[i].index;
        const to = ids[i + 1]?.index ?? s.length;
        const block = s.slice(from, Math.min(to, from + 1400));
        const grab = (label) => {
          const m = new RegExp(`${label}[^$]{0,160}?\\$([\\d.]+)`, 'i').exec(block);
          return m ? Number(m[1]) : null;
        };
        const input = grab('Input price');
        const output = grab('Output price');
        if (input == null || output == null) continue;
        out.set(id, { input, output });
      }
      return out;
    },
    note: 'Paid-tier input and output as the page read on this date. The free '
      + 'tier and context-caching rates are priced separately and are not recorded here.',
  },
  cohere: {
    company: 'Cohere',
    url: 'https://cohere.com/pricing',
    header: /Input\s*\$\s*[\d.]+[\s\S]{0,40}?\/\s*1M tokens[\s\S]{0,120}?Output\s*\$\s*[\d.]+/i,
    /**
     * A card per model, and a FAQ underneath that states prices the other way round.
     *
     *   Command A new  Command A is our most efficient and performant model …
     *   Input  $ 2.50 $ 2.50 / 1M tokens
     *   Output $ 10.00 $ 10.00 / 1M tokens
     *
     * The doubled figure is the mobile copy of the same cell, so the first $ after
     * the label is the rate either way; the older layout prints it once.
     *
     * The trap is the FAQ, which survives in captures where the cards do not:
     *
     *   Command pricing is $1.00/1M tokens for input and $2.00/1M tokens for output
     *
     * Here the figure comes BEFORE its label, so a loose "Input … $n" would read
     * "for input and $2.00" and record the OUTPUT rate as the input price. Demanding
     * the label be followed immediately by the figure and "/ 1M tokens" excludes
     * that sentence, and so does the header — a capture with only the FAQ is
     * reported as carrying no pricing table rather than parsed.
     *
     * Bare "Command" is skipped for the same reason: every occurrence of it is nav
     * chrome or FAQ prose about the retired Command/Command-light models, never a
     * card. Blocks are cut at the next model name so that a card without a rate
     * cannot inherit the next card's, and the first card for a name wins — which is
     * what keeps "Command R Fine-tuned Model", further down the page, from
     * overwriting Command R's own rate with the fine-tuned one.
     */
    parse(s) {
      const out = new Map();
      // A variant is a short token — R, R+, A, R7B, Light — and never one of the
      // table's own labels: the 2023 card reads "Command Input $ 1.00 / 1M tokens",
      // which a greedier name would read as a model called "Command Input".
      const names = [...s.matchAll(/\bCommand(?:\s+(?!Input|Output|Cost|Training|Model|Pricing)[A-Z][\w+.]{0,4})?/g)];
      for (let i = 0; i < names.length; i++) {
        const name = names[i][0].replace(/\s+/g, ' ').trim();
        if (name === 'Command' || out.has(name)) continue;
        const from = names[i].index;
        const to = names[i + 1]?.index ?? s.length;
        const block = s.slice(from, Math.min(to, from + 900));
        const grab = (label) => {
          const m = new RegExp(`\\b${label}\\s*\\$\\s*([\\d.]+)(?:\\s*\\$\\s*[\\d.]+)?\\s*\\/\\s*1M tokens`, 'i').exec(block);
          return m ? Number(m[1]) : null;
        };
        const input = grab('Input');
        const output = grab('Output');
        if (input == null || output == null) continue;
        out.set(name, { input, output });
      }
      return out;
    },
    note: 'Base input and output rates as the page read on this date. Fine-tuned '
      + 'and training rates are priced separately and are not recorded here.',
  },
  deepseek: {
    company: 'DeepSeek',
    url: 'https://api-docs.deepseek.com/quick_start/pricing/',
    header: /MODEL(?:\s*\(\d\))?\s+deepseek-[\w.-]+[\s\S]{0,1200}?1M\s+(?:TOKENS\s+)?INPUT(?:\s+PRICE)?(?:\s+TOKENS)?\s*\(CACHE MISS\)/,
    /**
     * The one transposed table here: models are COLUMNS, prices are labelled rows.
     *
     *   MODEL                            deepseek-chat   deepseek-reasoner
     *   MODEL VERSION                    DeepSeek-V3.2 … DeepSeek-V3.2 …
     *   STANDARD PRICE （UTC 00:30-16:30）
     *   1M INPUT TOKENS (CACHE HIT)      $0.07           $0.14
     *   1M INPUT TOKENS (CACHE MISS)     $0.27           $0.55
     *   1M OUTPUT TOKENS                 $1.10           $2.19
     *   DISCOUNT PRICE （UTC 16:30-00:30）
     *   1M INPUT TOKENS (CACHE MISS)     $0.135（50% OFF）…
     *
     * Four ways to get a plausible wrong number off it, all of them live:
     *
     *   · CACHE HIT sits directly above CACHE MISS and is ~4× cheaper. The base
     *     input rate is the MISS.
     *   · The DISCOUNT PRICE section repeats every label of the STANDARD one, so
     *     the region is cut at DISCOUNT PRICE when a standard section exists. On
     *     the 2025-09 capture that same rule is what picks the price then in force
     *     over the one announced for four days later, which is printed first.
     *   · Columns are named deepseek-chat / deepseek-reasoner, which are endpoints
     *     rather than models. MODEL VERSION names the model, and where that row is
     *     absent the footnote ("The deepseek-chat model points to DeepSeek-V3")
     *     does. Without one of the two there is nothing a record can be matched on.
     *   · A row can carry one figure for all columns (a colspan, when both share a
     *     price) or one per column. Anything else — a "(75% off)" annotation with
     *     both the discounted and the list price in the same cell, as in 2026-05 —
     *     is ambiguous, and the capture is refused rather than guessed at.
     *
     * Before 2025-03 the table ran the other way, a row per model, and by 2025-01
     * each cell held the list price and a promotional one together with nothing in
     * the markup to separate them. Those captures fail the header — MODEL is not
     * followed by a model id there — and are reported as carrying no table.
     */
    parse(s) {
      const ids = /\bMODEL(?:\s*\(\d\))?\s+((?:deepseek-[\w.-]+\s*(?:\(\d\)\s*)?)+)/.exec(s);
      if (!ids) return new Map();
      const cols = ids[1].match(/deepseek-[\w.-]+/gi) ?? [];

      // MODEL VERSION first: it names the model in the same column order. The
      // footnote is the fallback for captures published before that row existed.
      const version = /MODEL VERSION(?:\s*\(\d\))?\s+((?:\s*DeepSeek-[A-Za-z0-9.]+(?:-[A-Za-z0-9.]+)*(?:\s*（?\(?[^)）]{0,24}[)）])?)+)/.exec(s);
      let names = version ? (version[1].match(/DeepSeek-[A-Za-z0-9.]+(?:-[A-Za-z0-9.]+)*/g) ?? []) : [];
      if (names.length !== cols.length) {
        const byId = new Map();
        for (const m of s.matchAll(/\b(deepseek-[\w.-]+)\s+(?:model\s+)?(?:points to|has been upgraded to)(?:\s+the new model)?\s+(DeepSeek-[A-Za-z0-9.]+(?:-[A-Za-z0-9.]+)*)/gi)) {
          byId.set(m[1].toLowerCase(), m[2]);
        }
        names = cols.map((c) => byId.get(c.toLowerCase()));
      }
      if (names.length !== cols.length || names.some((n) => !n)) return new Map();

      // Standard hours only. Where the page prints a discounted list too, every
      // label below DISCOUNT PRICE is a repeat and none of it is the base rate.
      const std = s.search(/STANDARD PRICE/);
      const cut = s.search(/DISCOUNT PRICE/);
      const region = std >= 0 ? s.slice(std, cut > std ? cut : s.length) : s;

      // "1M TOKENS INPUT (CACHE MISS)" and "1M INPUT TOKENS (CACHE MISS)" are the
      // same row a year apart, so the label is matched either way round.
      const row = (label, qualifier = '') => {
        const m = new RegExp(`1M\\s+(?:TOKENS\\s+)?${label}(?:\\s+PRICE)?(?:\\s+TOKENS)?${qualifier}(?:\\s*\\(\\d\\))?`).exec(region);
        if (!m) return null;
        const after = region.slice(m.index + m[0].length);
        const stop = after.search(/1M\s+(?:TOKENS\s+)?(?:INPUT|OUTPUT)|DISCOUNT PRICE|Concurrency/);
        const cells = after.slice(0, stop < 0 ? Math.min(after.length, 160) : stop);
        // A run that also states a percentage holds the discounted price and the
        // list price together, and nothing in the markup says which is in force.
        if (/%|\boff\b/i.test(cells)) return null;
        const figs = [...cells.matchAll(/\$([\d.]+)/g)].map((f) => Number(f[1]));
        if (figs.length === cols.length) return figs;
        if (figs.length === 1) return cols.map(() => figs[0]); // one cell spanning every column
        return null; // a cell holding more than its own price — not ours to interpret
      };
      const input = row('INPUT', '\\s*\\(CACHE MISS\\)');
      const output = row('OUTPUT');

      const out = new Map();
      if (!input || !output) return out;
      for (let i = 0; i < cols.length; i++) {
        // Thinking and non-thinking modes are one model under two endpoints, so
        // the same version name arrives twice; the first column is the one kept.
        if (!out.has(names[i])) out.set(names[i], { input: input[i], output: output[i] });
      }
      return out;
    },
    note: 'Standard-hours cache-miss input and output as the page read on this date. '
      + 'Cache-hit input and any off-peak discount are priced separately and are not '
      + 'recorded here.',
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
