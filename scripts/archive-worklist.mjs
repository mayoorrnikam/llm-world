#!/usr/bin/env node
/**
 * Lists every unarchived source as a worklist a person can actually work through.
 *
 *   node scripts/archive-worklist.mjs    writes ARCHIVE-WORKLIST.md
 *
 * WHY A HUMAN IS IN THIS LOOP AT ALL
 *
 * archive.org has been down for days — the availability API answers 502, the
 * CDX index 503, and the /save endpoint 404 — so this project cannot create a
 * snapshot at all right now. arquivo.pt and archive.today can only report what
 * they already hold. That leaves one route to a capture: a person at a browser,
 * where Save Page Now still works when its API does not.
 *
 * Grouped by URL rather than by record, because one capture of a page cited by
 * thirteen records fixes thirteen records — and the worklist should put the
 * thirteen-for-one job at the top where it belongs.
 *
 * The output is generated; ARCHIVE-WORKLIST.md is gitignored.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalDate } from '../lib/record.mjs';

const d = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

const groups = new Map();
for (const r of d.releases) {
  for (const s of r.sources) {
    if (s.archived_url) continue;
    if (!groups.has(s.url)) groups.set(s.url, []);
    groups.get(s.url).push({ id: r.id, model: r.model, sid: s.id, date: canonicalDate(r), type: s.type });
  }
}
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
const total = sorted.reduce((n, [, v]) => n + v.length, 0);

let out = `# Unarchived sources — manual worklist

${total} source entries across ${sorted.length} distinct URLs, most-reused first.

## How to capture one

Open this in a browser — Save Page Now still works interactively while the API
is down:

    https://web.archive.org/save/<the URL>

Wait for it to finish, then copy the dated URL from the address bar. It looks
like \`https://web.archive.org/web/20260817120000/https://…\`.

If archive.org refuses, use https://archive.ph/ — paste the URL into the red
"My url is alive" box. Its captures look like \`https://archive.md/20260817120000/https://…\`.

## What to send back

One line per URL. Nothing else — the capture date comes from the URL itself:

    <original url>  ->  <archived url>

---

`;

for (const [url, uses] of sorted) {
  const dates = uses.map((u) => u.date).filter(Boolean).sort();
  const latest = dates[dates.length - 1];
  out += `## ${url}\n\n`;
  out += `Cited by ${uses.length} record${uses.length === 1 ? '' : 's'}`;
  if (dates.length) out += `, released ${dates[0]}${dates.length > 1 ? ` … ${latest}` : ''}`;
  out += `.\n\n`;
  for (const u of uses) out += `  - ${u.model} (${u.id})\n`;
  out += `\nCapture must be dated **on or after ${latest ?? '?'}** — an earlier capture is a\n`
    + `page that had not said the thing yet.\n\n`;
  out += `    ${url}  ->  \n\n---\n\n`;
}

writeFileSync('ARCHIVE-WORKLIST.md', out);
console.log(`${sorted.length} URLs, ${total} source entries → ARCHIVE-WORKLIST.md`);
for (const [url, uses] of sorted.slice(0, 6)) console.log(`  ${String(uses.length).padStart(2)}  ${url}`);
