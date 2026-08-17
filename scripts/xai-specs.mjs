#!/usr/bin/env node
/**
 * Reads context windows and pricing from xAI's own models table.
 *
 *   node scripts/xai-specs.mjs           report what the table states
 *   node scripts/xai-specs.mjs --write   record it
 *
 * WHY THE .md AND NOT THE PAGE
 *
 * docs.x.ai/developers/models.md is the same page as markdown, and markdown is
 * a far better thing to parse than flattened HTML. Every row is one model:
 *
 *   | grok-4.6 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |
 *
 * Model, context, input, cached input, output — delimited, in order, with no
 * ambiguity about which number belongs to which column. Compare Anthropic's
 * overview, where the same facts arrive as "1M tokens 1M tokens 1M tokens 200k
 * tokens" with the model names in a header row somewhere above; that needs the
 * column-identification machinery in lib/benchmark-table.mjs. This needs a
 * split on a pipe.
 *
 * TIERED PRICING IS RECORDED AT THE BASE TIER
 *
 * xAI prices most models twice — one rate under a 200k-token prompt and a
 * higher one at or above it. Only the base tier is recorded, because
 * `pricing[].rates` holds one input and one output figure and inventing a
 * blended number would publish a price nobody charges. The note says the
 * threshold exists so the record does not read as the whole story.
 *
 * WHAT IT WILL NOT DO
 *
 * Only empty fields are filled. A context window already traced to a source
 * outranks this table, which describes what is served today rather than what
 * shipped on release day — those differ, and the record is about the release.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
// The shared half of every docs reader; the parsing below stays xAI-specific
// on purpose — see lib/model-docs.mjs for why that line is drawn there.
import { fetchText, tokens, dollars, flat, citeDocs } from '../lib/model-docs.mjs';

const WRITE = process.argv.includes('--write');
const SRC = 'https://docs.x.ai/developers/models.md';
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

const md = await fetchText(SRC);
if (!md) { console.error(`could not read ${SRC}`); process.exit(2); }


/**
 * One entry per model, from the base pricing tier only.
 *
 * The tier is identified by the "< 200k" marker rather than by row order: a
 * model with a single row has no tiering at all, and assuming the first row is
 * always the cheap one would silently take the expensive rate for those.
 */
const specs = new Map();
for (const line of md.split('\n')) {
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  if (cells.length !== 5 || !/^grok/i.test(cells[0])) continue;
  const [rawName, ctx, input, , output] = cells;
  if (/≥/.test(rawName)) continue;
  const id = rawName.replace(/\s*\(.*\)\s*$/, '').trim();
  if (specs.has(id)) continue;
  specs.set(id, {
    context_window: tokens(ctx),
    input: dollars(input),
    output: dollars(output),
    tiered: /</.test(rawName),
  });
}

console.log(`${specs.size} models in xAI's pricing table\n`);

const xai = data.releases.filter((r) => r.company === 'xAI');
const today = new Date().toISOString().slice(0, 10);
const deferrals = [];
let touched = 0;

for (const r of xai) {
  const key = [...specs.keys()].find((k) => flat(k) === flat(r.model));
  if (!key) { console.log(`  · ${r.model.padEnd(12)} not in the table`); continue; }
  const s = specs.get(key);
  const added = [];

  if (r.specifications?.language && r.specifications.language.context_window == null && s.context_window) {
    added.push(`context ${s.context_window.toLocaleString('en-US')}`);
    if (WRITE) r.specifications.language.context_window = s.context_window;
  }
  if (!r.pricing && s.input != null && s.output != null) {
    // The table states the price, so the table is what the price cites — not
    // sources[0], which is the announcement and may say nothing about money.
    // METHODOLOGY §6 wants a snapshot of the page as it read today, so the
    // price waits for one rather than pointing at a live URL.
    const cited = r.sources.find((x) => x.url === SRC);
    if (!cited?.archived_url) {
      deferrals.push(`${r.model}: $${s.input}/$${s.output} — ${cited ? 'table not archived yet' : 'table not yet a cited source'}`);
      if (WRITE) citeDocs(r, SRC, 'xdocs');
    } else {
      added.push(`$${s.input}/$${s.output} per 1M`);
      if (WRITE) {
        // observed_on, not effective_from: this records what the page said
        // today, never when the price started.
        r.pricing = [{
          unit: 'per_million_tokens',
          rates: { input: s.input, output: s.output },
          currency: 'USD',
          observed_on: today,
          sources: [cited.id],
          ...(s.tiered ? { note: 'Base tier. xAI bills a higher rate for prompts at or above 200k tokens.' } : {}),
        }];
      }
    }
  }

  if (!added.length) { console.log(`  · ${r.model.padEnd(12)} nothing to add`); continue; }
  console.log(`  ✓ ${r.model.padEnd(12)} ${added.join(' · ')}`);
  touched++;
}

/**
 * Models xAI prices that this dataset does not track at all.
 *
 * Reported, never added: a pricing row proves a model is served, not when it
 * was released, and a record needs a date from the lab's own announcement.
 */
const untracked = [...specs.keys()].filter((k) => !xai.some((r) => flat(r.model) === flat(k)));
const imagine = [...md.matchAll(/^\|\s*(grok-(?:imagine|voice)[a-z0-9.\-]*)/gim)].map((m) => m[1]);
if (untracked.length || imagine.length) {
  console.log(`\nNOT TRACKED — xAI serves these and this dataset has no record:`);
  for (const k of untracked) console.log(`  ${k}  (text)`);
  for (const k of [...new Set(imagine)]) console.log(`  ${k}  (image / video / voice)`);
  console.log('  Each needs xAI\'s own announcement for a release date before it can be added.');
}

if (deferrals.length) {
  console.log(`\nWITHHELD — the price is read but not yet citable to an archived page (METHODOLOGY \u00a76):`);
  for (const d of deferrals) console.log(`  ${d}`);
  console.log('  Run `node scripts/archive-sources.mjs --save`, then this again.');
}

console.log(`\n${touched} record${touched === 1 ? '' : 's'} with something to add`);
if (WRITE && (touched || deferrals.length)) {
  saveDataset(data);
  console.log('wrote data/llm-releases.json');
} else if (!WRITE) {
  console.log('dry run — pass --write to record');
}
