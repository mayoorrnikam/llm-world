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
 * Per-model pages, which the pricing table cannot replace.
 *
 * docs.x.ai/developers/models/<id>.md states things the table has no column
 * for — modalities, and an explicit Yes/No per capability:
 *
 *   - **Modalities:** text, image -> text
 *   ## Capabilities
 *   - **Function calling:** Yes
 *   - **Reasoning:** Yes
 *
 * That Yes/No is the useful part. TAXONOMY §4 reads an unlisted capability as
 * "not evidenced" rather than "absent", and a page that answers No is one of
 * the few places a lab says absent out loud — so a No is skipped rather than
 * recorded, because this schema has no way to express "the lab says it cannot".
 *
 * Coding and agentic come from the one-line description ("SpaceXAI's frontier
 * model for coding, agentic tasks, and knowledge work"). That is the lab
 * describing its own model, so it is evidence; the sentence is printed so the
 * reading can be checked rather than trusted.
 */
const CAP_ROW = {
  'Function calling': 'function_calling',
  'Structured outputs': 'structured_output',
  Reasoning: 'reasoning',
};
const MODALITY = new Set(['text', 'image', 'audio', 'video']);

async function perModel(r) {
  const key = [...specs.keys()].find((k) => flat(k) === flat(r.model));
  if (!key) return null;
  const url = `https://docs.x.ai/developers/models/${key}`;
  const md = await fetchText(`${url}.md`);
  if (!md) return null;

  const modLine = /^-\s*\*\*Modalities:\*\*\s*(.+)$/im.exec(md);
  let modalities = null;
  if (modLine) {
    const [inRaw, outRaw] = modLine[1].split(/->|→/);
    const list = (x) => (x ?? '').split(',').map((y) => y.trim().toLowerCase())
      .filter((y) => MODALITY.has(y));
    const input = list(inRaw), output = list(outRaw);
    if (input.length && output.length) modalities = { input, output };
  }

  const caps = [];
  for (const [label, cap] of Object.entries(CAP_ROW)) {
    if (new RegExp(`\\*\\*${label}:\\*\\*\\s*Yes`, 'i').test(md)) caps.push(cap);
  }
  // The description line sits under the H1, before "## At a glance".
  const desc = md.split(/^##/m)[0].split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).join(' ');
  if (/\bfor\b[^.]*\bcoding\b/i.test(desc) || /\bcoding model\b/i.test(desc)) caps.push('coding');
  if (/\bagentic\b/i.test(desc)) caps.push('agentic');

  return { url, modalities, caps: [...new Set(caps)], desc };
}

console.log('\nPER-MODEL PAGES');
let enriched = 0;
for (const r of xai) {
  const p = await perModel(r);
  if (!p) { console.log(`  · ${r.model.padEnd(12)} no per-model page`); continue; }
  const added = [];

  if (!r.modalities && p.modalities) {
    added.push(`modalities in ${p.modalities.input.join('/')} out ${p.modalities.output.join('/')}`);
    if (WRITE) r.modalities = p.modalities;
  }
  const fresh = p.caps.filter((c) => !(r.capabilities ?? []).includes(c));
  if (fresh.length) {
    added.push(`capabilities +${fresh.join(' +')}`);
    if (WRITE) r.capabilities = [...(r.capabilities ?? []), ...fresh];
  }

  if (!added.length) { console.log(`  · ${r.model.padEnd(12)} nothing to add`); continue; }
  console.log(`  \u2713 ${r.model.padEnd(12)} ${added.join(' \u00b7 ')}`);
  if (fresh.includes('coding') || fresh.includes('agentic')) {
    console.log(`      from: "${p.desc.slice(0, 104)}"`);
  }
  enriched++;
  if (WRITE) citeDocs(r, p.url, 'xmodel');
}
console.log(`  ${enriched} record${enriched === 1 ? '' : 's'} enriched from per-model pages`);

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
if (WRITE && (touched || deferrals.length || enriched)) {
  saveDataset(data);
  console.log('wrote data/llm-releases.json');
} else if (!WRITE) {
  console.log('dry run — pass --write to record');
}
