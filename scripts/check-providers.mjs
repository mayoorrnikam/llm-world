#!/usr/bin/env node
/**
 * Watches what the labs are actually SERVING, through a public model catalogue.
 *
 *   node scripts/check-providers.mjs            new models, and disagreements
 *   node scripts/check-providers.mjs --backlog  every untracked model, not just new
 *   node scripts/check-providers.mjs --record   remember what was reported
 *
 * WHY A FOURTH DISCOVERY CHANNEL
 *
 * The three that exist read prose and hope:
 *
 *   check-freshness  Hugging Face — blind to any lab shipping no weights
 *   check-feeds      RSS — nineteen labs publish none
 *   scan-labs        documentation HTML — works, but it is scraping, and a
 *                    docs page can lag the API by days
 *
 * A provider's model catalogue is the same information as JSON, maintained
 * because customers' code breaks when it is wrong. OpenRouter publishes one
 * without an API key, covering ~60 vendors, and it carries context length,
 * pricing and modalities per model. That is the channel ai-model-directory is
 * built on, and it is free to read.
 *
 * IT ANSWERS A QUESTION NOTHING ELSE HERE CAN
 *
 * Not just "is there a model we lack" but "does the model we already recorded
 * still match what is being served". No other channel compares a value we hold
 * against a value in the world, so a context window that was right in March and
 * silently revised in June stays wrong here forever.
 *
 * A DISAGREEMENT IS NOT AN ERROR
 *
 * OpenRouter is a RESELLER. It reports what IT serves, which is legitimately
 * allowed to differ from the lab's own specification — a router may cap context
 * to fit its own limits, or expose a variant under the base name. So a mismatch
 * means "look at this", never "our value is wrong". Resolving one still means
 * reading the lab's own announcement (METHODOLOGY §5).
 *
 * NOTHING IS WRITTEN TO THE DATASET. Not by this script, not ever.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalDate, contextWindow, fieldState } from '../lib/record.mjs';
import { fetchCatalogue, trackedIndex, bare } from '../lib/catalogue.mjs';

const SEEN_FILE = 'data/seen-providers.json';
const BACKLOG = process.argv.includes('--backlog');

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

let seen = [];
try { seen = JSON.parse(readFileSync(SEEN_FILE, 'utf8')).candidates ?? []; } catch { /* first run */ }
const seenSet = new Set(seen);

const tracked = trackedIndex(data.releases);

let served;
try {
  served = await fetchCatalogue();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const untracked = [];
const disagreements = [];

for (const m of served) {
  const k = bare(m.id);
  const rec = tracked.get(k);

  if (!rec) {
    if (BACKLOG || !seenSet.has(k)) untracked.push(m);
    continue;
  }

  // Compare only against a value we genuinely assert. `undisclosed` and
  // `unresearched` are not claims, so they cannot disagree with anything.
  if (fieldState(rec, 'context_window') !== 'recorded') continue;
  const ours = contextWindow(rec);
  const theirs = m.context_length;
  if (typeof theirs === 'number' && ours !== theirs) {
    /**
     * "200K" and "262,144" are the same number in different bases, and a report
     * that ranks them beside a genuine 200K-vs-1M gap trains the reader to skim
     * past both. A lab writes the decimal figure in its announcement and serves
     * the binary one, so the two disagree forever and neither is wrong.
     *
     * Five percent separates notation from news: 1,048,576 vs 1,000,000 is 4.9%,
     * and the smallest real gap in the first run of this was 100%.
     */
    const drift = Math.abs(theirs - ours) / Math.max(theirs, ours);
    disagreements.push({ rec, ours, theirs, id: m.id, notation: drift < 0.05 });
  }
}

const n = (v) => (v == null ? '—' : v.toLocaleString('en-US'));
const out = [];

out.push(`## Served but not tracked — ${untracked.length}`);
out.push('');
if (!untracked.length) {
  out.push('_Nothing new in the catalogue._');
} else {
  out.push('| Catalogue id | Name | Context | First seen |');
  out.push('|---|---|---|---|');
  for (const m of untracked.sort((a, b) => (b.created ?? 0) - (a.created ?? 0))) {
    const when = m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '—';
    out.push(`| \`${m.id}\` | ${m.name ?? ''} | ${n(m.context_length)} | ${when} |`);
  }
}

out.push('');
const material = disagreements.filter((d) => !d.notation);
const notation = disagreements.filter((d) => d.notation);

out.push(`## Recorded value differs from what is served — ${material.length}`);
out.push('');
if (!material.length) {
  out.push('_Every tracked model matches the catalogue, allowing for notation._');
} else {
  out.push('| Model | Ours | Served | Recorded |');
  out.push('|---|---|---|---|');
  for (const d of material.sort((a, b) => a.rec.model.localeCompare(b.rec.model))) {
    out.push(`| ${d.rec.model} | ${n(d.ours)} | ${n(d.theirs)} | ${canonicalDate(d.rec) ?? '—'} |`);
  }
  out.push('');
  out.push('A router may serve less than the lab documents, so a difference is a '
    + 'question, not a correction. Check the lab\'s own announcement before changing a value.');
}

if (notation.length) {
  out.push('');
  out.push(`<details><summary>${notation.length} within 5% — decimal against binary, not news</summary>`);
  out.push('');
  out.push('| Model | Ours | Served |');
  out.push('|---|---|---|');
  for (const d of notation.sort((a, b) => a.rec.model.localeCompare(b.rec.model))) {
    out.push(`| ${d.rec.model} | ${n(d.ours)} | ${n(d.theirs)} |`);
  }
  out.push('');
  out.push('</details>');
}

out.push('');
out.push('_A catalogue is a discovery source, never a source of truth. Nothing here is added '
  + 'to the dataset without the lab\'s own announcement and an archived snapshot._');

console.log(out.join('\n'));

if (process.argv.includes('--record')) {
  const all = [...new Set([...seen, ...untracked.map((m) => bare(m.id))])].sort();
  writeFileSync(SEEN_FILE, `${JSON.stringify({
    note: 'Catalogue identifiers already surfaced by scripts/check-providers.mjs. Presence '
      + 'here means "reported once", never "tracked" — the dataset is the record of what is tracked.',
    candidates: all,
  }, null, 2)}\n`);
  console.log(`\n_Recorded ${all.length} surfaced identifiers, so the next run reports only what is new._`);
}
