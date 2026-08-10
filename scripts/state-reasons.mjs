#!/usr/bin/env node
/**
 * Gives every non-verified record a stated reason.
 *
 *   node scripts/state-reasons.mjs           report what it would write
 *   node scripts/state-reasons.mjs --write   write provenance.reason
 *
 * A bare "partially_verified" badge tells a reader nothing. It could mean the
 * date is shaky, or that one specification is missing, or that nobody has
 * looked yet — and those are very different things. docs/METHODOLOGY.md §9
 * requires the record to say which.
 *
 * Every sentence produced here is derived from the record's OWN state: which
 * source authorities it holds, which fields are null. Nothing is inferred about
 * the model itself, so this cannot introduce a claim that isn't already true of
 * the data. Reasons are meant to be overwritten by a human with something more
 * specific once a record is actually researched.
 *
 * Existing reasons are never overwritten — pass --force to redo them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { contextWindow, parameterCount } from '../lib/record.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

const data = JSON.parse(readFileSync(FILE, 'utf8'));

const SOURCE_PHRASE = {
  official_announcement: "the lab's own announcement",
  official_documentation: 'official documentation',
  official_model_card: 'the official model card',
  official_repository: 'the official repository',
  technical_paper: 'the technical paper',
  independent_benchmark: 'independent benchmarking',
  independent_analysis: 'independent analysis',
  news: 'news reporting',
};

const list = (items) => items.length <= 1 ? (items[0] ?? '')
  : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

function reasonFor(r) {
  const primary = r.sources.filter((s) => s.authority === 'primary');
  const secondary = r.sources.filter((s) => s.authority !== 'primary');

  // What the lab has not disclosed. Absence here is a fact about the record.
  const undisclosed = [];
  if (parameterCount(r) == null) undisclosed.push('parameter count');
  if (contextWindow(r) == null) undisclosed.push('context window');
  if (r.access.open_weights && !r.access.license) undisclosed.push('licence');
  if (r.modalities == null) undisclosed.push('modalities');

  if (!primary.length) {
    const kinds = [...new Set(secondary.map((s) => SOURCE_PHRASE[s.type] ?? s.type))];
    return `No primary source. The release is recorded from ${list(kinds)} only, `
      + `so it cannot be verified until the lab's own announcement is cited.`;
  }

  const kinds = [...new Set(primary.map((s) => SOURCE_PHRASE[s.type] ?? s.type))];
  const cited = `Cited to ${list(kinds)}`;

  if (undisclosed.length) {
    // "modalities" is plural even when it is the only item in the list.
    const plural = undisclosed.length > 1 || undisclosed[0] === 'modalities';
    return `${cited}. Not verified because ${list(undisclosed)} `
      + `${plural ? 'are' : 'is'} not recorded — `
      + `either undisclosed by the lab or not yet researched.`;
  }
  return `${cited}, and every recorded field has a value, but the individual `
    + `facts have not yet been checked against the source one by one.`;
}

let written = 0, skipped = 0;
const preview = [];

for (const r of data.releases) {
  if (r.provenance.status === 'verified') continue;
  if (r.provenance.reason && !FORCE) { skipped++; continue; }
  const reason = reasonFor(r);
  preview.push(`${r.id.padEnd(20)} ${reason}`);
  if (WRITE) r.provenance.reason = reason;
  written++;
}

for (const p of preview.slice(0, 12)) console.log(p);
if (preview.length > 12) console.log(`… and ${preview.length - 12} more`);

console.log(`\n${written} record${written === 1 ? '' : 's'} given a stated reason`
  + `${skipped ? `, ${skipped} already had one` : ''}`);

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`wrote ${FILE}`);
} else {
  console.log(`dry run — pass --write to apply`);
}
