#!/usr/bin/env node
/**
 * Reads modalities, context and pricing from OpenAI's own per-model docs.
 *
 *   node scripts/openai-specs.mjs           report what the pages state
 *   node scripts/openai-specs.mjs --write   record it
 *
 * WHY THE .md, EMPHATICALLY
 *
 * Every page under developers.openai.com/api/docs/models has a markdown twin at
 * the same path plus `.md`, and the difference is not cosmetic. Flattened to
 * prose, the HTML reads:
 *
 *   context window 128,000 max output tokens Feb 16, 2026 knowledge cutoff
 *
 * — a label sitting before one number and after another, with a knowledge
 * cutoff alongside for a parser to mistake for a release date. The markdown
 * says the same facts unambiguously:
 *
 *   - Input modalities: text, image
 *   - 1,050,000 context window
 *   - 128,000 max output tokens
 *
 * The real context window is 1,050,000, not the 128,000 the flattened line
 * would have handed over. That is not a near miss; it is an eight-fold error
 * on the field this dataset is most often asked about, and it would have
 * looked entirely plausible on the page.
 *
 * OpenAI blocks automated requests to openai.com, but not to
 * developers.openai.com — which is why this dataset can read specifications
 * from a lab whose announcements it can only reach through the Wayback Machine.
 *
 * WHAT IT WILL NOT DO
 *
 * Only empty fields are filled; anything already traced to a source outranks a
 * page describing what is served today. Prompts above 272K are priced at 2x
 * input and 1.5x output, and only the base rate is recorded — `pricing[].rates`
 * holds one figure per direction and a blended number is a price nobody pays.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';

const WRITE = process.argv.includes('--write');
const INDEX = 'https://developers.openai.com/api/docs/models';
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; llm-world docs reader)' };
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: UA });
  return res.ok ? res.text() : null;
};

/** Every model the index links to. The hrefs are the authoritative list. */
const html = await get(INDEX);
if (!html) { console.error(`could not read ${INDEX}`); process.exit(2); }
const endpoints = [...new Set(
  [...html.matchAll(/href="[^"]*\/api\/docs\/models\/([a-z0-9.-]+)"/g)].map((m) => m[1]),
)];

const num = (s) => Number(String(s).replace(/,/g, ''));
const MODALITY = new Set(['text', 'image', 'audio', 'video']);

function parse(md) {
  const line = (re) => re.exec(md)?.[1]?.trim() ?? null;
  const mods = (label) => {
    const raw = line(new RegExp(`^- ${label} modalities:\\s*(.+)$`, 'im'));
    if (!raw) return null;
    const list = raw.split(',').map((x) => x.trim().toLowerCase()).filter((x) => MODALITY.has(x));
    return list.length ? list : null;
  };
  const input = mods('Input');
  const output = mods('Output');
  // Anchored to the line start so "Maximum input tokens" cannot be read as the
  // context window — they are different numbers on the same page.
  const ctx = line(/^-\s*([\d,]+)\s+context window\s*$/im);
  const row = (name) => {
    const m = new RegExp(`^\\|\\s*${name}\\s*\\|\\s*\\$([\\d.]+)\\s*\\|`, 'im').exec(md);
    return m ? Number(m[1]) : null;
  };
  return {
    modalities: input && output ? { input, output } : null,
    context_window: ctx ? num(ctx) : null,
    input_price: row('Input'),
    output_price: row('Output'),
  };
}

const flat = (s) => String(s).toLowerCase().replace(/[\s._-]/g, '');
const oai = data.releases.filter((r) => r.company === 'OpenAI');
const today = new Date().toISOString().slice(0, 10);

console.log(`${oai.length} OpenAI records · ${endpoints.length} models linked from the index\n`);

let touched = 0;
for (const r of oai) {
  const ep = endpoints.find((e) => flat(e) === flat(r.model))
    ?? endpoints.find((e) => flat(e).startsWith(flat(r.model)));
  if (!ep) { console.log(`  · ${r.model.padEnd(18)} not served by the API`); continue; }

  const md = await get(`${INDEX}/${ep}.md`);
  if (!md) { console.log(`  ~ ${r.model.padEnd(18)} ${ep}.md unreadable`); continue; }
  const s = parse(md);
  const added = [];

  if (r.specifications?.language && r.specifications.language.context_window == null && s.context_window) {
    added.push(`context ${s.context_window.toLocaleString('en-US')}`);
    if (WRITE) r.specifications.language.context_window = s.context_window;
  }
  if (!r.modalities && s.modalities) {
    added.push(`modalities in ${s.modalities.input.join('/')} out ${s.modalities.output.join('/')}`);
    if (WRITE) r.modalities = s.modalities;
  }
  if (!r.pricing && s.input_price != null && s.output_price != null) {
    added.push(`$${s.input_price}/$${s.output_price} per 1M`);
    if (WRITE) {
      r.pricing = [{
        unit: 'per_million_tokens',
        rates: { input: s.input_price, output: s.output_price },
        currency: 'USD',
        observed_on: today,
        sources: [r.sources[0].id],
        note: 'Base rate. Prompts above 272K tokens are billed at 2x input and 1.5x output.',
      }];
    }
  }

  if (!added.length) { console.log(`  · ${r.model.padEnd(18)} nothing to add`); continue; }
  console.log(`  ✓ ${r.model.padEnd(18)} ${added.join(' · ')}`);
  touched++;
}

const untracked = endpoints.filter((e) => !oai.some((r) => flat(r.model) === flat(e)));
if (untracked.length) {
  console.log(`\nNOT TRACKED — OpenAI serves these and this dataset has no record:`);
  console.log('  ' + untracked.join('\n  '));
  console.log('  A docs page proves a model is served, not when it shipped — each still'
    + '\n  needs its announcement, which openai.com serves only through the archive.');
}

console.log(`\n${touched} record${touched === 1 ? '' : 's'} with something to add`);
if (WRITE && touched) {
  saveDataset(data);
  console.log('wrote data/llm-releases.json');
} else if (!WRITE) {
  console.log('dry run — pass --write to record');
}
