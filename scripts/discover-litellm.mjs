#!/usr/bin/env node
/**
 * Uses LiteLLM's model table to find which gaps are worth chasing.
 *
 *   node scripts/discover-litellm.mjs                 report gaps it can point at
 *   node scripts/discover-litellm.mjs --field=context only that field
 *
 * DISCOVERY ONLY. IT WRITES NOTHING, AND THAT IS NOT A LIMITATION TO FIX.
 *
 * model_prices_and_context_window.json is 3,040 entries of context windows,
 * prices and modalities, MIT-licensed, and it agrees with every figure this
 * project verified independently — Claude Opus 5 at 1,000,000, GPT-5.6 Sol at
 * 1,050,000, Gemini 3.7 Flash at 1,048,576. It is also a third party, and
 * METHODOLOGY §5 does not care how good a third party is: a secondary source
 * may corroborate a date and can never back a value. Epoch AI sits in exactly
 * this position and is used exactly this way.
 *
 * The temptation is obvious. 30 records are missing a context window, LiteLLM
 * has a number for most of them, and importing would close the gap in one
 * command. It would also replace 30 traceable facts with 30 numbers whose
 * provenance is "an aggregator said so" — and this project's entire claim is
 * that you can click a figure and reach the lab that stated it.
 *
 * So this answers a narrower question: WHICH gaps does a lab plausibly publish,
 * and therefore which are worth a reader's time? A gap LiteLLM cannot fill
 * either is probably a gap nobody has published, which is a different problem
 * from one nobody has looked up.
 *
 * The number it prints is a LEAD, never a value. Verify it against the
 * provider's own page and cite that — the per-model docs readers in this repo
 * are how, and they already cover Anthropic, OpenAI, Google and xAI.
 */

import { readFileSync } from 'node:fs';
import { flat } from '../lib/model-docs.mjs';
import { contextWindow } from '../lib/record.mjs';

const SRC = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

const res = await fetch(SRC, { signal: AbortSignal.timeout(60000) });
if (!res.ok) { console.error(`could not read LiteLLM: HTTP ${res.status}`); process.exit(2); }
const table = await res.json();

/** Their keys carry provider prefixes; index by the flattened bare name too. */
const index = new Map();
for (const [key, v] of Object.entries(table)) {
  if (!v || typeof v !== 'object') continue;
  const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  for (const k of [key, bare]) if (!index.has(flat(k))) index.set(flat(k), { key, ...v });
}

const missing = data.releases.filter((r) => contextWindow(r) == null);
console.log(`${missing.length} records with no context window · ${index.size} LiteLLM names\n`);

const leads = [], blank = [];
for (const r of missing) {
  const hit = index.get(flat(r.model))
    ?? index.get(flat(r.model.replace(/\s+/g, '-')))
    ?? index.get(flat(r.id));
  const n = hit?.max_input_tokens ?? hit?.max_tokens;
  if (typeof n === 'number' && n > 0) {
    leads.push({ r, n, key: hit.key, provider: hit.litellm_provider });
  } else {
    blank.push(r);
  }
}

leads.sort((a, b) => a.r.company.localeCompare(b.r.company) || a.r.model.localeCompare(b.r.model));
if (leads.length) {
  console.log('LEADS — a lab probably publishes this; go and read their page:');
  for (const l of leads) {
    console.log(`  ${l.r.company.padEnd(18)} ${l.r.model.padEnd(24)} ~${l.n.toLocaleString('en-US').padStart(9)}  (litellm: ${l.key})`);
  }
  console.log('\n  These are LEADS, not values. Cite the provider\'s own page —'
    + '\n  npm run anthropic | openai | gemini | xai read four of them already.');
}

console.log(`\nNO LEAD — LiteLLM has nothing either (${blank.length}):`);
const byCo = {};
for (const r of blank) (byCo[r.company] ??= []).push(r.model);
for (const [c, ms] of Object.entries(byCo).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${c.padEnd(20)} ${ms.length.toString().padStart(2)}  ${ms.slice(0, 3).join(', ')}${ms.length > 3 ? ' …' : ''}`);
}
console.log('\n  Most of these are image, video or audio models, where a context'
  + '\n  window is not a property the model has — check classification before'
  + '\n  recording this as a gap at all.');
