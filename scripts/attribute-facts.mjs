#!/usr/bin/env node
/**
 * Records WHICH source states each published fact.
 *
 *   node scripts/attribute-facts.mjs               report
 *   node scripts/attribute-facts.mjs --write       record evidence[]
 *   node scripts/attribute-facts.mjs --limit=20    do 20 records and stop
 *
 * Stage 5. verify-facts.mjs already answers "does a primary source contain this
 * value"; this answers "which one", and stores it, so a reader can click a
 * number and see the document behind it.
 *
 *   "evidence": {
 *     "release_date":    [{ "value": "2024-05-13", "sources": ["gpt-4o-s1"] }],
 *     "context_window":  [{ "value": 128000, "sources": ["gpt-4o-s2"] }]
 *   }
 *
 * Each entry is a CLAIM: a value, and the sources that state it. More than one
 * entry means credible sources disagree, and both are kept — silently picking a
 * winner is invisible to the reader (docs/METHODOLOGY.md §8, rule R4).
 *
 * Only three fields, on purpose. Doing every field at once is what makes this
 * kind of work never ship.
 *
 * TWO RULES THIS TOOL MUST NOT BREAK
 *
 * 1. A failed fetch is not evidence of absence. archive.org rate-limits, and
 *    "we could not read the page" must never be recorded as "the page does not
 *    say this". A record with any unreadable source is skipped entirely.
 *
 * 2. It is resumable. Records that already have evidence are skipped, so a run
 *    interrupted by rate limiting can simply be run again. Combined with --limit
 *    that makes this safe to do in small batches.
 */

import { readFileSync, writeFileSync } from 'node:fs';
// One reader for every script: HTML, PDF and client-rendered pages, cached on
// disk so a full pass fetches each source once rather than five times.
import { sourceText, FAILED } from '../lib/source-text.mjs';
import { canonicalDate, assertedValue, EVIDENCED_FIELDS } from '../lib/record.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Every plausible written form of a value, so a match is not missed. */
function formsFor(field, v) {
  if (field === 'release_date') {
    const [y, m, d] = String(v).split('-').map(Number);
    const month = MONTHS[m - 1];
    if (!d) return [String(v), `${month} ${y}`];
    return [...new Set([String(v), `${month} ${d}, ${y}`, `${month} ${d} ${y}`,
      `${d} ${month} ${y}`, `${month.slice(0, 3)} ${d}, ${y}`])];
  }
  const forms = [String(v), v.toLocaleString('en-US')];
  if (field === 'context_window') {
    if (v % 1000 === 0) forms.push(`${v / 1000}K`, `${v / 1000}k`, `${v / 1000},000`);
    if (v % 1_000_000 === 0) forms.push(`${v / 1e6}M`, `${v / 1e6} million`);
    if (v === 1_048_576) forms.push('1M', '1 million');
  } else {
    if (v >= 1e12) forms.push(`${+(v / 1e12).toFixed(2)}T`, `${+(v / 1e12).toFixed(2)} trillion`);
    else if (v >= 1e9) {
      const b = +(v / 1e9).toFixed(v < 1e10 ? 1 : 0);
      forms.push(`${b}B`, `${b} billion`, `${b}-billion`);
    }
  }
  return [...new Set(forms)];
}




// Resumable: anything already attributed is left alone.
const pending = data.releases.filter((r) => !r.evidence);
console.log(`${data.releases.length} records · ${data.releases.length - pending.length} already attributed`
  + ` · ${Math.min(pending.length, LIMIT)} to do now\n`);

let attributed = 0, skipped = 0, unproven = 0;
const skippedIds = [];

for (const r of pending.slice(0, LIMIT)) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  if (!archived.length) { skipped++; skippedIds.push(`${r.id} (no archived primary source)`); continue; }

  const corpus = [];
  let failed = false;
  for (const s of archived) {
    const t = await sourceText(s.archived_url);
    if (t === FAILED) { failed = true; break; }
    corpus.push({ id: s.id, text: t });
    await sleep(1200);
  }

  // Rule 1: a page we could not read tells us nothing. Do not write.
  if (failed) {
    skipped++;
    skippedIds.push(`${r.id} (a source could not be read — rerun later)`);
    process.stdout.write(`  ~ ${r.id} skipped, source unreadable\n`);
    continue;
  }

  const evidence = {};
  const found = [];
  for (const field of EVIDENCED_FIELDS) {
    const value = assertedValue(r, field);
    if (value == null) continue;
    const backing = corpus
      .filter((c) => formsFor(field, value).some((f) => c.text.includes(f)))
      .map((c) => c.id);
    if (backing.length) {
      evidence[field] = [{ value, sources: backing }];
      found.push(`${field}←${backing.join(',')}`);
    }
  }

  if (!Object.keys(evidence).length) unproven++;
  attributed++;
  if (WRITE) {
    r.evidence = evidence;
    // Flush as we go. Rule 2 says this is resumable, but a run that only saves
    // at the end is not resumable at all — rate limiting kills it and every
    // record read so far is thrown away. Each record costs several slow
    // fetches; none of them should have to be paid for twice.
    writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  }
  process.stdout.write(`  ✓ ${r.id}  ${found.join('  ') || '(nothing matched)'}\n`);
}

console.log(`\nattributed: ${attributed}`);
console.log(`skipped:    ${skipped}`);
if (unproven) console.log(`of the attributed, ${unproven} had no field matched in any source`);
if (skippedIds.length) {
  console.log(`\nskipped records:`);
  for (const s of skippedIds) console.log(`  ${s}`);
}

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record`);
}
