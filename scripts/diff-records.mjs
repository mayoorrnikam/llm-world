#!/usr/bin/env node
/**
 * What a change did to the dataset, record by record.
 *
 *   node scripts/diff-records.mjs                   working tree vs HEAD
 *   node scripts/diff-records.mjs origin/main       working tree vs a ref
 *   node scripts/diff-records.mjs A B               ref A vs ref B
 *   node scripts/diff-records.mjs A B --fields      also print every changed field
 *
 * A line diff of data/llm-releases.json cannot be reviewed: an enrichment pass
 * touches a thousand lines, and one agent commit that added two records
 * changed 658 because it re-encoded the file. This reports what a reviewer
 * actually has to judge — which records were added or removed, which fields
 * changed on how many records, and every provenance status that moved.
 * Run it before committing, and paste its summary into the pull request.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FILE = 'data/llm-releases.json';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const FIELDS = process.argv.includes('--fields');

const load = (ref) => JSON.parse(ref === undefined
  ? readFileSync(FILE, 'utf8')
  : execFileSync('git', ['show', `${ref}:${FILE}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const [fromRef, toRef] = args.length >= 2 ? args : [args[0] ?? 'HEAD', undefined];
const A = load(fromRef), B = load(toRef);
const ra = new Map(A.releases.map((r) => [r.id, r]));
const rb = new Map(B.releases.map((r) => [r.id, r]));
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

const added = [...rb.keys()].filter((id) => !ra.has(id));
const removed = [...ra.keys()].filter((id) => !rb.has(id));
const changed = [...rb.keys()].filter((id) => ra.has(id) && !same(ra.get(id), rb.get(id)));

console.log(`## Dataset diff: ${fromRef} → ${toRef ?? 'working tree'}\n`);
if (A.updated !== B.updated) console.log(`updated: ${A.updated} → ${B.updated}`);
console.log(`releases: ${A.releases.length} → ${B.releases.length}\n`);

if (added.length) {
  console.log(`### Added (${added.length})\n`);
  for (const id of added) {
    const r = rb.get(id);
    const date = r.events.find((e) => e.type === 'announcement')?.date ?? r.events[0]?.date;
    console.log(`- ${id} — ${r.model}, ${r.company}, ${date}, ${r.classification.primary_type}, ${r.provenance.status}`);
  }
  console.log();
}
if (removed.length) {
  console.log(`### REMOVED (${removed.length}) — a removal needs a reason in the commit\n`);
  for (const id of removed) console.log(`- ${id}`);
  console.log();
}

if (changed.length) {
  const byField = new Map();
  const moves = [];
  for (const id of changed) {
    const a = ra.get(id), b = rb.get(id);
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (same(a[k], b[k])) continue;
      if (!byField.has(k)) byField.set(k, []);
      byField.get(k).push(id);
    }
    if (a.provenance?.status !== b.provenance?.status) moves.push(`${id}: ${a.provenance?.status} → ${b.provenance?.status}`);
  }
  console.log(`### Changed (${changed.length})\n`);
  for (const [k, ids] of [...byField].sort((x, y) => y[1].length - x[1].length)) {
    console.log(`- ${k}: ${ids.length} — ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}`);
  }
  if (moves.length) {
    console.log('\n### Provenance status moved — check each one\n');
    for (const m of moves) console.log(`- ${m}`);
  }
  if (FIELDS) {
    console.log('\n### Field detail\n');
    for (const id of changed) {
      const a = ra.get(id), b = rb.get(id);
      console.log(`**${id}**`);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (same(a[k], b[k])) continue;
        console.log(`  ${k}: ${JSON.stringify(a[k] ?? null).slice(0, 240)}`);
        console.log(`    → ${JSON.stringify(b[k] ?? null).slice(0, 240)}`);
      }
    }
  }
}
if (!added.length && !removed.length && !changed.length) console.log('No record changed.');
