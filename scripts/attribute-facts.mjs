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
import { saveDataset } from '../lib/dataset.mjs';
// One reader for every script: HTML, PDF and client-rendered pages, cached on
// disk so a full pass fetches each source once rather than five times.
import { sourceText, FAILED } from '../lib/source-text.mjs';
import { canonicalDate, assertedValue, EVIDENCED_FIELDS } from '../lib/record.mjs';
// The project's one date vocabulary. This script generates the written forms of
// a date it already holds; draft-from-url.mjs reads dates out of prose with the
// same module, so a form one of them knows is a form the other knows.
import { dateForms, scanDates } from '../lib/dates.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
// Recording a conflict forces provenance.status to "conflicting", which
// downgrades a record. A date scanner over prose should not do that on its own
// — the same class of matcher read a safety hypothetical as a release
// statement earlier today — so it is opt-in and reported by default.
const RECORD = process.argv.includes('--record-conflicts');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every plausible written form of a value, so a match is not missed. */
function formsFor(field, v) {
  // Zero-padded day as well as bare, "14 August 2026" as well as "August 14,
  // 2026", and 2026年8月14日 for the Chinese pages Qwen, Zhipu and ByteDance
  // publish. blog.google datelines read "Jun 03, 2026", so Gemma 4 12B's date
  // sat in its own archived announcement unmatched, and the record stayed
  // partially_verified for a formatting difference rather than a missing fact.
  // Every one of those forms now lives in lib/dates.mjs, once.
  if (field === 'release_date') return dateForms(String(v));

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
//
// --redo also revisits records whose attribution is incomplete — a field the
// record asserts but has traced to nothing. Without it, "has any evidence at
// all" means done forever, so improving the matcher cannot help the records it
// was improved for. Gemma 4 12B is the case: it traced its parameter count,
// which retired it, and its release date went untraced because blog.google
// writes "Jun 03, 2026" and the padded form was missing. Fixing the form
// changed nothing until this flag existed.
const REDO = process.argv.includes('--redo');
const incomplete = (r) => EVIDENCED_FIELDS
  .some((f) => assertedValue(r, f) != null && !r.evidence?.[f]?.length);
const pending = data.releases.filter((r) => !r.evidence || (REDO && incomplete(r)));
console.log(`${data.releases.length} records · ${data.releases.length - pending.length} already attributed`
  + ` · ${Math.min(pending.length, LIMIT)} to do now\n`);

let attributed = 0, skipped = 0, unproven = 0;
const conflicts = [];
const recordable = [];
const conflicted = new Set();
const skippedIds = [];

for (const r of pending.slice(0, LIMIT)) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  if (!archived.length) { skipped++; skippedIds.push(`${r.id} (no archived primary source)`); continue; }

  const corpus = [];
  let failed = false;
  for (const s of archived) {
    const t = await sourceText(s.archived_url);
    if (t === FAILED) { failed = true; break; }
    corpus.push({ id: s.id, type: s.type, text: t });
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
      // Falls through to the disagreement scan below rather than continuing.
      // It used to `continue` here, and that is why this dataset held zero
      // conflicting values across 186 records: the scan only ever ran when the
      // record's own value had NO source, which is the one shape the schema
      // cannot store — evidence must contain the value the record publishes
      // (validate-data §evidence), so "nobody backs us and someone contradicts
      // us" has nowhere to go. The case the schema is built for — our value is
      // backed by source A and source B says otherwise — was never looked for.
    }

    /**
     * The source states a DIFFERENT date. Report it; never resolve it.
     *
     * "Could not be traced" covers two very different situations and this
     * script could not tell them apart: the page says nothing about the date,
     * or the page says a different date. Three records are the second kind —
     * Anthropic dates the Claude 3.5 Sonnet announcement 21 June 2024 where the
     * record says the 20th, and both Grok records differ from x.ai by a day or
     * two. Timezones and publication-versus-announcement explain most of that,
     * which is exactly why a person has to look: this project publishes
     * disagreement rather than silently picking a side (METHODOLOGY §8).
     *
     * Nothing is written. A near-miss is a prompt to read the page, not a
     * licence to overwrite a date somebody sourced.
     */
    if (field === 'release_date') {
      // Dates that belong to the artefact rather than the announcement: arXiv
      // submission and revision stamps, git commit dates. OPT-175B tripped this
      // on "[v1] Mon, 2 May 2022" and "Initial commit May 3, 2022" — neither is
      // a claim about when the model was released.
      const NOT_AN_ANNOUNCEMENT = /submitted on|last revised|view email|\[v\d\]|initial commit|commit\b|released just|\b[0-9a-f]{7}\b/i;
      // Where a page stops being the article and starts being a list of links
      // to other articles.
      const RELATED_START = /related stories|keep reading|view all|more from|you might also|recommended for you|read next/i;
      // Only sources that carry a DATELINE. A repository shows commit dates and
      // a paper shows submission stamps; both look like dates near a model name
      // and neither is a claim about when the model was released. OPT-175B kept
      // surfacing on "Initial commit May 3, 2022" for exactly that reason.
      const DATED = new Set(['official_announcement', 'official_documentation', 'news']);
      const near = [];
      for (const c of corpus) {
        if (!DATED.has(c.type)) continue;
        // Everything past "Related stories" / "Keep reading" is a list of OTHER
        // articles, each with its own byline and date, and every conflict this
        // scanner has ever reported came from there. Gemini 1.5 Pro looked like
        // it disagreed with itself by two days: its dateline says Feb 15 2024
        // and the sidebar below carries a Pixel announcement from the 13th and
        // an industry-partnership post from the 14th. GPT-5.6-Cyber was the
        // same shape, its "Keep reading" list supplying Aug 7. A date under
        // somebody else's headline is not this page disagreeing with us.
        const body = c.text.split(RELATED_START)[0];
        // Every form the shared scanner knows, not just "Month D, YYYY" — a
        // page that datelines "14 August 2026" or "2026年8月14日" disagrees with
        // the record just as loudly, and the old pattern could not see either.
        // Ambiguous numeric forms carry a null iso and are skipped: a date we
        // refuse to read cannot be evidence that a source disagrees with us.
        for (const h of scanDates(body)) {
          if (h.ambiguous || h.iso === value) continue;
          const around = body.slice(Math.max(0, h.index - 70), h.index + 30);
          if (NOT_AN_ANNOUNCEMENT.test(around)) continue;
          const gap = Math.abs(Date.parse(h.iso) - Date.parse(value)) / 86400000;
          if (gap <= 3) near.push({ iso: h.iso, id: c.id });
        }
      }
      if (near.length) {
        const seen = [...new Map(near.map((x) => [x.iso, x])).values()];
        conflicts.push(`${r.id}: record says ${value}, ${seen.map((x) =>
          `${x.id} says ${x.iso}`).join(' · ')}`);

        /**
         * RECORD the disagreement, do not just print it.
         *
         * This block found conflicts and pushed them to a console.log. The
         * evidence written a few lines below held only the value that agreed
         * with the record, so a source stating a different date was detected,
         * reported to a terminal nobody keeps, and dropped. Across 186 records
         * the dataset held zero conflicting values — not because the labs
         * agree, but because disagreement had nowhere to live.
         *
         * METHODOLOGY §8 says both values are recorded when credible sources
         * disagree, and evidence[] already has the shape for it: a list of
         * {value, sources}. Nothing needed inventing; the second entry simply
         * was never written.
         *
         * The STATUS is deliberately not changed here. Marking a record
         * `conflicting` is a claim about the sources, and this detection is a
         * date scanner over prose — the same class of machinery that read a
         * safety hypothetical as a release statement earlier today. It reports
         * what it found and a person decides; see reconcile-status.
         */
        // Record it only when the record's own value is also backed. Two
        // claims is the shape the schema means by "conflicting"; one claim
        // that contradicts the published value is a validation error, not a
        // conflict, and writing it would break the build to make a point.
        if (evidence[field]?.length) {
          if (RECORD) {
            for (const x of seen) evidence[field].push({ value: x.iso, sources: [x.id] });
            conflicted.add(r.id);
          } else {
            recordable.push(`${r.id}: ${value} (backed) vs ${seen.map((x) => `${x.iso} (${x.id})`).join(', ')}`);
          }
        }
      }
    }
  }

  if (!Object.keys(evidence).length) unproven++;
  attributed++;
  if (WRITE) {
    r.evidence = evidence;
    // Two claims on a field is exactly what "conflicting" means, and the
    // validator errors unless the status says so.
    if (conflicted.has(r.id)) {
      r.provenance.status = 'conflicting';
      r.provenance.reason = 'Sources state different dates for this release; both are '
        + 'recorded in evidence[] rather than one being chosen (METHODOLOGY §8, R4).';
    }
    // Flush as we go. Rule 2 says this is resumable, but a run that only saves
    // at the end is not resumable at all — rate limiting kills it and every
    // record read so far is thrown away. Each record costs several slow
    // fetches; none of them should have to be paid for twice.
    saveDataset(data);
  }
  process.stdout.write(`  ✓ ${r.id}  ${found.join('  ') || '(nothing matched)'}\n`);
}

console.log(`\nattributed: ${attributed}`);
console.log(`skipped:    ${skipped}`);
if (unproven) console.log(`of the attributed, ${unproven} had no field matched in any source`);
if (skippedIds.length) {
  if (recordable.length) {
    console.log(`\nRECORDABLE CONFLICTS — both values are sourced, so the schema can hold`
      + `\nboth (METHODOLOGY \u00a78). Pass --record-conflicts to write them, which sets`
      + `\nprovenance.status to "conflicting" on each (${recordable.length}):`);
    for (const c of recordable) console.log(`  ${c}`);
  }
  if (conflicted.size) {
    console.log(`\nrecorded ${conflicted.size} conflicting record${conflicted.size === 1 ? '' : 's'}`);
  }
  if (conflicts.length) {
  console.log(`\nSOURCE STATES A DIFFERENT DATE — read the page before changing anything (${conflicts.length}):`);
  for (const c of conflicts) console.log(`  ${c}`);
  console.log(`  Timezone and publication-versus-announcement explain most of these.`);
  console.log(`  Where they do not, record the disagreement rather than choosing quietly.`);
}

console.log(`\nskipped records:`);
  for (const s of skippedIds) console.log(`  ${s}`);
}

if (WRITE) {
  saveDataset(data);
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record`);
}
