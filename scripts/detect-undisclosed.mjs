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
 *   sources readable, no such figure anywhere  → undisclosed. The lab's own
 *                                                announcement and docs do not
 *                                                state it.
 *   sources readable, a figure IS present      → NOT undisclosed. We are simply
 *                                                missing a value that exists —
 *                                                reported so it can be filled.
 *   no readable source                         → unknown. Left alone.
 *
 * The middle case is the useful one: it finds gaps we can close, rather than
 * excusing them.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fieldState } from '../lib/record.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
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

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world undisclosed-check)' },
    });
    if (!res.ok) return null;
    return textOf(await res.text());
  } catch {
    return null;
  }
}

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
  .filter((c) => c.fields.length);

console.log(`${candidates.length} records have at least one unresearched field\n`);

const undisclosed = [], fillable = [], unknown = [];
let done = 0;

async function examine(c) {
  const archived = c.record.sources.filter((s) => s.archived_url && s.authority === 'primary');
  const texts = [];
  for (const s of archived) {
    const t = await fetchText(s.archived_url);
    if (t) texts.push(t);
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
    else {
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
