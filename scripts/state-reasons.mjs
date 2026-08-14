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
import { saveDataset } from '../lib/dataset.mjs';
import {
  assertedValue, evidenceFor, EVIDENCED_FIELDS, canonicalDate,
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
  /**
   * A snapshot older than the release is a different failure, and saying so
   * matters.
   *
   * "Could not be found in any cited primary source" reads as: nobody
   * published it, or nobody looked. For Mistral Medium 3.5 neither was true —
   * the announcement states 22 May 2026 plainly, and the only capture
   * archive.org holds is from the day before, when the page had not announced
   * yet. The record blamed the research when the problem was the citation's
   * timing, which is exactly the kind of quiet inaccuracy this dataset is
   * supposed to refuse.
   */
  const on = canonicalDate(r);
  const stale = on && primary
    .filter((x) => x.retrieved)
    .every((x) => x.retrieved < on);

  /**
   * A release from the last fortnight has not had time to be archived.
   *
   * The stale-snapshot sentence below describes a defect, and for a model added
   * days after it shipped that is simply wrong — archive.org has not caught up,
   * which is a wait rather than a fault. Telling someone who added the record
   * this morning that "a capture would settle it" reads as an accusation of
   * sloppy work, when provenance is meant to describe the state of the evidence
   * and not imply blame for it.
   */
  const ageDays = on
    ? Math.round((Date.now() - Date.parse(`${on}T00:00:00Z`)) / 86400000)
    : Infinity;

  if (stale && ageDays <= 14) {
    return `${cited}. ${list(unproven.map((f) => FIELD_PHRASE[f] ?? f))} `
      + `could not be traced yet: this release is ${ageDays} day${ageDays === 1 ? '' : 's'} old `
      + `and archive.org has not captured the announcement since it went up. That is a `
      + `wait, not a gap — re-running the archive pass will settle it.`;
  }

  if (stale) {
    const newest = primary.map((x) => x.retrieved).filter(Boolean).sort().pop();
    return `${cited}. Not verified because ${list(unproven.map((f) => FIELD_PHRASE[f] ?? f))} `
      + `could not be traced: every archived snapshot of those sources predates the `
      + `release — the newest is ${newest}, captured before the page announced it — `
      + `so the archived copy does not contain the figure. A capture from on or after `
      + `${on} would settle it.`;
  }

  return `${cited}. Not verified because ${list(unproven.map((f) => FIELD_PHRASE[f] ?? f))} `
    + `could not be found in any cited primary source — the value may be correct, `
    + `but this dataset cannot yet show where it came from.`;
}

let written = 0, skipped = 0;
const preview = [];

/**
 * The placeholder add-model.mjs seeds on a brand-new record.
 *
 * It is true when written and false the moment enrichment runs, and nothing
 * was clearing it — reasons are never overwritten, so a seeded record kept
 * saying its sources were unarchived. MiniMax M3 shipped that sentence next to
 * two archived links and a licence traced to one of them. A record that
 * contradicts its own evidence is worse than one with no reason at all.
 */
const PLACEHOLDER = /Newly added\.\s*Sources are not archived and no value has been traced to one yet[^.]*\./;

for (const r of data.releases) {
  if (r.provenance.status === 'verified') continue;
  const stale = PLACEHOLDER.test(r.provenance.reason ?? '') && r.sources.some((s) => s.archived_url);
  if (r.provenance.reason && !FORCE && !stale) { skipped++; continue; }
  // detect-modalities.mjs appends how a record's modalities were established.
  // That is provenance a regeneration must not throw away, so it is carried
  // across rather than overwritten.
  // Everything from the first "Modalities …" sentence to the end, not just that
  // sentence: the explanation of HOW the modalities were established follows it
  // and is the part worth keeping.
  // Drop the placeholder but keep whatever enrichment appended after it —
  // those sentences say where a value came from, which is the reason itself.
  const prior = (r.provenance.reason ?? '').replace(PLACEHOLDER, '').trim();
  const at = prior.search(/(?:^|\s)Modalities /);
  const carried = at >= 0 ? prior.slice(at).trim() : (stale ? prior : '');

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
  saveDataset(data);
  console.log(`wrote ${FILE}`);
} else {
  console.log(`dry run — pass --write to apply`);
}
