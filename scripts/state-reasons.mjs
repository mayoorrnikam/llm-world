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
import {
  assertedValue, evidenceFor, EVIDENCED_FIELDS,
} from '../lib/record.mjs';

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

const FIELD_PHRASE = {
  release_date: 'the release date',
  context_window: 'the context window',
  parameter_count: 'the parameter count',
};

/**
 * Why this record is not verified — stated as the fact that is actually
 * unproven, using the evidence recorded in Stage 5.
 *
 * The first version of this reasoned from which fields were null, and said
 * things like "not verified because modalities are not recorded". That
 * contradicted the bar settled in Stage 2: a record is verified when every
 * value it ASSERTS is found in a primary source, and a null asserts nothing.
 * An unrecorded modality is a coverage gap, never a verification blocker.
 */
function reasonFor(r) {
  const primary = r.sources.filter((s) => s.authority === 'primary');
  const secondary = r.sources.filter((s) => s.authority !== 'primary');

  if (!primary.length) {
    const kinds = [...new Set(secondary.map((s) => SOURCE_PHRASE[s.type] ?? s.type))];
    return `No primary source. The release is recorded from ${list(kinds)} only, `
      + `so it cannot be verified until the lab's own announcement is cited.`;
  }

  const kinds = [...new Set(primary.map((s) => SOURCE_PHRASE[s.type] ?? s.type))];
  const cited = `Cited to ${list(kinds)}`;

  const asserted = EVIDENCED_FIELDS.filter((f) => assertedValue(r, f) != null);
  const unproven = asserted.filter((f) => !evidenceFor(r, f).sources.length);

  if (!asserted.length) {
    return `${cited}, but this record asserts no figure that could be traced to it.`;
  }
  if (!unproven.length) {
    return `${cited}, and every value it asserts was found there.`;
  }
  return `${cited}. Not verified because ${list(unproven.map((f) => FIELD_PHRASE[f] ?? f))} `
    + `could not be found in any cited primary source — the value may be correct, `
    + `but this dataset cannot yet show where it came from.`;
}

let written = 0, skipped = 0;
const preview = [];

for (const r of data.releases) {
  if (r.provenance.status === 'verified') continue;
  if (r.provenance.reason && !FORCE) { skipped++; continue; }
  // detect-modalities.mjs appends how a record's modalities were established.
  // That is provenance a regeneration must not throw away, so it is carried
  // across rather than overwritten.
  // Everything from the first "Modalities …" sentence to the end, not just that
  // sentence: the explanation of HOW the modalities were established follows it
  // and is the part worth keeping.
  const prior = r.provenance.reason ?? '';
  const at = prior.search(/(?:^|\s)Modalities /);
  const carried = at >= 0 ? prior.slice(at).trim() : '';

  const reason = [reasonFor(r), carried].filter(Boolean).join(' ');
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
