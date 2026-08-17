#!/usr/bin/env node
/**
 * Folds manually-captured snapshots into the dataset.
 *
 *   node scripts/apply-archives.mjs captures.txt          check them
 *   node scripts/apply-archives.mjs captures.txt --write   record them
 *   ... --verified-by-hand    you opened the captures; skip only the fetch check
 *
 * Input is one line per capture, as ARCHIVE-WORKLIST.md asks for:
 *
 *   https://docs.z.ai/release-notes  ->  https://archive.md/20260817055142/https://docs.z.ai/release-notes
 *
 * WHY THIS VERIFIES RATHER THAN TRUSTS
 *
 * A snapshot URL that resolves is not the same as a snapshot that evidences
 * anything. This project has already shipped two flavours of hollow citation:
 * an archived 403 bot-block page, and a capture dated the day BEFORE the
 * release it was cited for — a page that had not said the thing yet. Both
 * render an "archived" badge and prove nothing.
 *
 * So every line is checked three ways before it is written:
 *
 *   1. the capture carries a date, and that date is on or after every record
 *      that cites the URL;
 *   2. the capture fetches, and is not an error or bot-block page;
 *   3. the original URL is actually cited by a record, unarchived.
 *
 * A short archive.ph URL (archive.ph/8VOnI) carries no date, so it is resolved
 * through the Memento TimeMap to its dated form before any of this.
 *
 * --verified-by-hand DROPS CHECK 2, AND ONLY CHECK 2
 *
 * archive.today began rate-limiting this project's capture fetches and then
 * escalated to a CAPTCHA. Completing that is not something to automate around —
 * the service is asking for a human, and the honest response is to send one
 * rather than to work out how not to.
 *
 * The flag exists because the person who made the capture already did check 2,
 * with their own eyes, in the browser that made it. That is a stronger check
 * than this script's, not a weaker one: it distinguishes an archived page from
 * an archived error the way a byte count never could. What it is not is
 * MACHINE-checkable, which is the whole difference and the reason it needs a
 * flag with an ugly name rather than a silent fallback.
 *
 * Checks 1 and 3 still run, and they are the ones this script is better at than
 * a person: nobody eyeballs whether a capture predates the release it is cited
 * for across thirteen records.
 *
 * The dataset shape does not change. Sources carry six fields and inventing a
 * seventh to mark these would be schema drift introduced by a workaround — so
 * which captures came in this way lives in git history, where the flag is in
 * the command and the reasoning is in the commit.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import { canonicalDate } from '../lib/record.mjs';

const WRITE = process.argv.includes('--write');
const BY_HAND = process.argv.includes('--verified-by-hand');
const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: node scripts/apply-archives.mjs <captures.txt> [--write] [--verified-by-hand]');
  process.exit(2);
}

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; llm-world archive apply)' };

/** YYYYMMDD out of a wayback or archive.today capture URL. */
const dateIn = (u) => /\/(\d{8})\d{0,6}\//.exec(u)?.[1] ?? null;
const iso = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/** archive.ph short links carry no date; the TimeMap has the dated form. */
async function resolve(archived, original) {
  if (dateIn(archived)) return archived;
  if (!/archive\.(ph|today|md|is|li|vn)/.test(archived)) return archived;
  const res = await fetch(`http://archive.ph/timemap/${original}`, {
    signal: AbortSignal.timeout(30000), headers: UA,
  });
  if (!res.ok) return archived;
  const found = [...(await res.text()).matchAll(/<([^>]*\/\d{14}\/[^>]*)>/g)].map((m) => m[1]);
  return found.length ? found[found.length - 1] : archived;
}

const lines = readFileSync(file, 'utf8').split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && l.includes('->'));

console.log(`${lines.length} capture${lines.length === 1 ? '' : 's'} to check\n`);
if (BY_HAND) {
  console.log('--verified-by-hand: the "is this a real page" check is YOURS on these.');
  console.log('Date order and citation are still checked here.\n');
}

let applied = 0, skipped = 0;
for (const [i, line] of lines.entries()) {
  if (i) await sleep(3000); // archive.today rate-limits; ask slowly.
  const [rawOrig, rawArch] = line.split('->').map((s) => s.trim());
  const original = rawOrig.replace(/[)\]]+$/, '');

  const users = data.releases.filter((r) => r.sources.some((s) => s.url === original));
  if (!users.length) { console.log(`  ✗ no record cites ${original}`); skipped++; continue; }

  const archived = (await resolve(rawArch, original)).replace(/^http:/, 'https:');
  const stamp = dateIn(archived);
  if (!stamp) { console.log(`  ✗ ${original}\n      capture URL carries no date: ${archived}`); skipped++; continue; }
  const capturedOn = iso(stamp);

  // A capture predating a release cannot evidence it.
  const tooEarly = users.filter((r) => { const on = canonicalDate(r); return on && capturedOn < on; });
  if (tooEarly.length) {
    console.log(`  ✗ ${original}\n      captured ${capturedOn}, before ${tooEarly.map((r) => `${r.id} (${canonicalDate(r)})`).join(', ')}`);
    skipped++; continue;
  }

  // And it must be a real page, not an archived error — unless a person has
  // already looked, which is the one substitute that is actually better.
  if (!BY_HAND) {
    let body = null;
    try {
      const res = await fetch(archived, { signal: AbortSignal.timeout(45000), headers: UA });
      if (res.status === 429) { console.log(`  ~ ${original}\n      archive rate-limited us — rerun later, or pass --verified-by-hand if you have opened it yourself`); skipped++; continue; }
      if (res.ok) body = await res.text();
    } catch { /* handled below */ }
    if (!body || body.length < 2000) {
      console.log(`  ✗ ${original}\n      capture did not fetch, or is too small to be the page`);
      skipped++; continue;
    }
  }

  console.log(`  ✓ ${original}`);
  console.log(`      ${capturedOn} · ${users.length} record${users.length === 1 ? '' : 's'} · ${archived}`);
  applied++;
  if (WRITE) {
    for (const r of users) {
      for (const s of r.sources) {
        if (s.url !== original || s.archived_url) continue;
        s.archived_url = archived;
        s.retrieved = capturedOn;
      }
    }
  }
}

console.log(`\n${applied} applied, ${skipped} skipped`);
if (BY_HAND && applied) {
  console.log('Applied on your inspection, not this script\'s. If any of those captures'
    + '\nshows an error page rather than the page, run archive-sources.mjs to clear it.');
}
if (WRITE && applied) { saveDataset(data); console.log('wrote data/llm-releases.json'); }
else if (!WRITE) console.log('dry run — pass --write to record');
