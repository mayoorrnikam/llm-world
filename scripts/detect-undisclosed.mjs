#!/usr/bin/env node
/**
 * Works out which missing values the lab actually withholds.
 *
 *   node scripts/detect-undisclosed.mjs           report
 *   node scripts/detect-undisclosed.mjs --write   record undisclosed[]
 *
 * `null` on its own is ambiguous: it can mean "the lab does not publish this"
 * or "nobody has looked yet". The first is a complete record; the second is a
 * gap. Rendering both as "Not disclosed" claims something about the lab that
 * nobody established (docs/METHODOLOGY.md §1).
 *
 * The test is evidence-based and narrow. For each null field it reads the
 * record's archived primary sources and looks for ANY statement of that kind of
 * figure — any parameter count, any context window, any licence name. Then:
 *
 *   ALL sources read, no such figure anywhere  → undisclosed. The lab's own
 *                                                announcement and docs do not
 *                                                state it.
 *   a figure IS present                        → NOT undisclosed. We are simply
 *                                                missing a value that exists —
 *                                                reported so it can be filled.
 *   some source unread                         → partial. Left alone.
 *   no readable source                         → unknown. Left alone.
 *
 * The middle case is the useful one: it finds gaps we can close, rather than
 * excusing them.
 *
 * "All" is load-bearing, and was not always required. "Undisclosed" is a claim
 * about the LAB — that it publishes no such figure — so it cannot be drawn from
 * a subset of that lab's own sources. Gemma 4 12B was marked as having an
 * undisclosed context window on the strength of its announcement alone, while
 * its model card, the obvious place to publish one, sat unarchived and unread.
 * A source with no snapshot is unread exactly like one that will not parse.
 */

import { readFileSync, writeFileSync } from 'node:fs';
// One reader for every script: HTML, PDF and client-rendered pages, cached on
// disk so a full pass fetches each source once rather than five times.
import { sourceText, FAILED } from '../lib/source-text.mjs';
import { fieldState } from '../lib/record.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const CONCURRENCY = 5;

const data = JSON.parse(readFileSync(FILE, 'utf8'));

/** Does this text state a figure of the given kind, for any model? */
const PATTERNS = {
  parameter_count: [
    /\b\d[\d.,]*\s*(?:billion|trillion|million)\s+(?:total\s+|active\s+)?parameters?\b/i,
    /\b\d[\d.,]*\s*[BTM]\s+(?:total\s+|active\s+)?parameters?\b/i,
    /\bparameters?\s*[:=]\s*\d/i,
    /\b(?:total|active)\s+parameters?\s*[:=]?\s*\d/i,
  ],
  context_window: [
    /\b\d[\d.,]*\s*[KMk]?\s*(?:token)?\s*context\s*(?:window|length)\b/i,
    /\bcontext\s*(?:window|length)\s*[:=]?\s*\d/i,
    /\b\d[\d.,]*\s*(?:tokens?)\s+of\s+context\b/i,
  ],
  license: [
    /\b(?:Apache|MIT|BSD|GPL|LGPL|MPL|CC[- ]BY|OpenRAIL)\b/i,
    /\blicen[cs]e\s*[:=]\s*\S/i,
    /\bunder the\b.{0,40}\blicen[cs]e\b/i,
  ],
};



/** Only fields that are currently unresearched are candidates. */
const candidates = data.releases
  .map((r) => ({
    record: r,
    fields: ['parameter_count', 'context_window', 'license'].filter((f) => {
      // A licence only applies to open-weights releases; on a proprietary
      // record its absence is a category fact, not a disclosure question.
      if (f === 'license' && !r.access.open_weights) return false;
      return fieldState(r, f) === 'unresearched';
    }),
  }))
  .filter((c) => c.fields.length)
  .slice(0, LIMIT);

console.log(`${candidates.length} records have at least one unresearched field\n`);

const undisclosed = [], fillable = [], unknown = [], partial = [];
let done = 0;

async function examine(c) {
  const primary = c.record.sources.filter((s) => s.authority === 'primary');
  const archived = primary.filter((s) => s.archived_url);
  const texts = [];
  // A primary source with no snapshot is a source nobody read, exactly like one
  // whose snapshot will not parse. Both count against inferring from silence.
  let unread = primary.length - archived.length;
  for (const s of archived) {
    const t = await sourceText(s.archived_url);
    if (t) texts.push(t); else unread++;
  }

  done++;
  process.stderr.write(`  ${done}/${candidates.length} ${c.record.id}\n`);

  if (!texts.length) {
    unknown.push(`${c.record.id}: ${c.fields.join(', ')} (no readable primary source)`);
    return;
  }

  for (const f of c.fields) {
    const stated = texts.some((t) => PATTERNS[f].some((p) => p.test(t)));
    if (stated) fillable.push(`${c.record.id}: ${f} IS stated in a primary source — value missing from our record`);
    // "Undisclosed" is a claim about the LAB — that it publishes no such
    // figure — so it cannot be drawn from a subset of the lab's own sources.
    // detect-modalities.mjs has required a complete read since it was written;
    // this script did not, and it showed: Gemma 4 12B was marked as having an
    // undisclosed context window while its model card sat unarchived and
    // unread. A positive finding above needs only one source and is exempt;
    // an inference from absence is not.
    else if (unread) {
      partial.push(`${c.record.id}: ${f} (${unread} of ${primary.length} primary sources unread)`);
    } else {
      undisclosed.push({ id: c.record.id, field: f });
      if (WRITE) {
        (c.record.undisclosed ??= []).push(f);
        c.record.undisclosed = [...new Set(c.record.undisclosed)].sort();
      }
    }
  }
}

const queue = [...candidates];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) await examine(queue.shift());
}));

const byField = undisclosed.reduce((a, u) => { (a[u.field] ??= []).push(u.id); return a; }, {});

console.log(`\nEVIDENCED AS UNDISCLOSED — primary sources state no such figure:`);
for (const [f, ids] of Object.entries(byField)) console.log(`  ${f}: ${ids.length}`);

console.log(`\nGAPS WE CAN CLOSE — the source states it, our record does not (${fillable.length}):`);
for (const x of fillable) console.log(`  ${x}`);

if (partial.length) {
  console.log(`\nPARTIAL READ — not every primary source was read, so silence proves nothing (${partial.length}):`);
  for (const x of partial) console.log(`  ${x}`);
}

if (unknown.length) {
  console.log(`\nLEFT UNKNOWN — nothing readable to judge from (${unknown.length}):`);
  for (const x of unknown) console.log(`  ${x}`);
}

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record undisclosed[]`);
}
