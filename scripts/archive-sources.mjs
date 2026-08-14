#!/usr/bin/env node
/**
 * Finds a Wayback Machine snapshot for every source and records it.
 *
 *   node scripts/archive-sources.mjs              report coverage, change nothing
 *   node scripts/archive-sources.mjs --write      fill archived_url + retrieved
 *   node scripts/archive-sources.mjs --only=docs  only official_documentation
 *
 * Why this exists (docs/METHODOLOGY.md §6, rule R1):
 *
 *   A live URL proves what a page says TODAY. It does not prove what it said
 *   when we read it. Citing a pricing or documentation page for a past fact is
 *   a citation that has already rotted — the page no longer contains the claim.
 *   A dated snapshot is permanently checkable, so it is a strictly better
 *   citation than the live URL it replaces.
 *
 * By default this only READS from archive.org's availability API.
 *
 *   --save    ask archive.org to CREATE snapshots for sources that have none
 *
 * `--save` writes to a third-party service, so it is opt-in and never runs as a
 * side effect of anything else. It submits public URLs that this dataset
 * already cites publicly; it does not touch the origin site and cannot delete
 * anything. Snapshots are permanent and public, which is the point. Some hosts
 * block the archiver, so a save can legitimately fail.
 *
 * Snapshots are preferred near the record's canonical date, because the claim
 * we are evidencing is a claim about that moment. Where no snapshot exists
 * before the fact was recorded, the closest later one is used and flagged.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import { canonicalDate } from '../lib/record.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const SAVE = process.argv.includes('--save');
const ONLY_DOCS = process.argv.includes('--only=docs');
const API = 'https://archive.org/wayback/available';

const data = JSON.parse(readFileSync(FILE, 'utf8'));

/** Wayback wants YYYYMMDDhhmmss; we ask for the record's own date. */
const stampFor = (date) => String(date).replace(/-/g, '').padEnd(8, '0') + '000000';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Three outcomes, deliberately distinguished:
 *   { hit }        a snapshot exists
 *   ABSENT         archive.org answered, and has nothing
 *   FAILED         we could not ask
 *
 * Collapsing FAILED into ABSENT would report "no evidence exists" when the
 * truth is "we did not manage to look" — the worst kind of error for a dataset
 * whose whole claim is that its gaps are honest. An earlier version of this
 * script did exactly that and under-reported archive coverage by 19 sources.
 */
const ABSENT = Symbol('absent');
const FAILED = Symbol('failed');

async function lookup(url, near, attempts = 3) {
  const q = `${API}?url=${encodeURIComponent(url)}&timestamp=${near}`;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(q, {
        signal: AbortSignal.timeout(25000),
        headers: { 'user-agent': 'llm-world archive-check (+https://github.com/mayoorrnikam/llm-world)' },
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) return FAILED;
      const j = await res.json();
      const snap = j?.archived_snapshots?.closest;
      if (!snap?.available || !snap.url) return ABSENT;
      // Timestamp is YYYYMMDDhhmmss → the date that content was captured.
      const t = String(snap.timestamp ?? '');
      return {
        url: snap.url.replace(/^http:/, 'https:'),
        captured: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`,
      };
    } catch {
      await sleep(2000 * (i + 1));
    }
  }
  return FAILED;
}

const jobs = [];
for (const r of data.releases) {
  const near = stampFor(canonicalDate(r) ?? '2024-01-01');
  for (const s of r.sources) {
    if (s.archived_url) continue;
    if (ONLY_DOCS && s.type !== 'official_documentation') continue;
    jobs.push({ record: r, source: s, near });
  }
}

jobs.length = Math.min(jobs.length, LIMIT);
console.log(`checking ${jobs.length} sources against the Wayback Machine…\n`);

let found = 0, absent = 0, failed = 0, early = 0;
const gaps = [], errors = [];

// Sequential on purpose: archive.org is a donated public service and this is
// not urgent work. Hammering it in parallel would be rude.
for (const [i, job] of jobs.entries()) {
  const hit = await lookup(job.source.url, job.near);
  const label = `${job.record.id}/${job.source.id} (${job.source.type}) ${job.source.url}`;

  // A snapshot captured BEFORE the release cannot evidence it. Mistral Medium
  // 3.5 was cited to a capture from the day before its announcement: the page
  // existed, named the model, and carried no date at all, so attribute-facts
  // could not trace the release date and the record stayed partially_verified
  // for what read like a research gap and was really a citation pointing one
  // day early. An earlier capture is not "fine — the page predates our record";
  // it is a page that had not said the thing yet.
  if (hit && hit !== FAILED && hit !== ABSENT) {
    const on = canonicalDate(job.record);
    if (on && hit.captured < on) {
      const later = await lookup(job.source.url, stampFor(on), 2);
      if (later && later !== FAILED && later !== ABSENT && later.captured >= on) {
        hit.url = later.url;
        hit.captured = later.captured;
      }
    }
  }

  if (hit === FAILED) {
    failed++;
    errors.push(label);
  } else if (hit === ABSENT) {
    absent++;
    gaps.push(label);
  } else {
    found++;
    const recordDate = canonicalDate(job.record);
    if (recordDate && hit.captured < recordDate) early++;
    if (WRITE) {
      job.source.archived_url = hit.url;
      job.source.retrieved = hit.captured;
    }
  }
  if ((i + 1) % 25 === 0) process.stdout.write(`  …${i + 1}/${jobs.length}\n`);
}

console.log(`\nsnapshots found:   ${found}`);
console.log(`no snapshot:       ${absent}`);
console.log(`lookup failed:     ${failed}${failed ? '  ← unknown, NOT a confirmed gap' : ''}`);
if (early) {
  console.log(`captured before the recorded date: ${early}`);
  console.log(`  These cannot evidence the release — the page had not announced it yet.`);
  console.log(`  Re-run with --save to request a capture from on or after the date.`);
}

if (gaps.length && !SAVE) {
  console.log(`\nconfirmed to have no snapshot — cannot satisfy R1 until one exists:`);
  for (const g of gaps) console.log(`  ${g}`);
  console.log(`\nTo fix: re-run with --save, which asks archive.org to capture them.`);
  console.log(`That writes to a third-party service, so it is opt-in.`);
}

/* ------------------------------------------------------- create (opt-in) */

if (gaps.length && SAVE) {
  console.log(`\nasking archive.org to capture ${gaps.length} URL(s) — this writes to a`);
  console.log(`third-party public archive, and each capture can take a minute.\n`);

  for (const job of jobs) {
    const s = job.source;
    if (s.archived_url) continue;
    // Only the ones confirmed absent; a failed lookup is not a licence to save.
    if (!gaps.some((g) => g.includes(`${job.record.id}/${s.id} `))) continue;

    process.stdout.write(`  ${job.record.id}/${s.id} … `);
    try {
      const res = await fetch(`https://web.archive.org/save/${s.url}`, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(180000),
        headers: { 'user-agent': 'llm-world archive-save (+https://github.com/mayoorrnikam/llm-world)' },
      });
      if (!res.ok) { console.log(`refused (HTTP ${res.status})`); continue; }
      await res.text();
    } catch (e) {
      console.log(`failed (${e.name === 'TimeoutError' ? 'timed out' : e.message})`);
      continue;
    }

    // Confirm through the availability API rather than trusting the save call:
    // a 200 from Save Page Now does not guarantee a retrievable snapshot.
    await sleep(5000);
    const check = await lookup(s.url, stampFor(canonicalDate(job.record) ?? '2024-01-01'));
    if (check && check !== ABSENT && check !== FAILED) {
      console.log(`captured ${check.captured}`);
      if (WRITE) { s.archived_url = check.url; s.retrieved = check.captured; }
      found++;
    } else {
      console.log(`saved, but not yet retrievable — re-run later to pick it up`);
    }
  }
}

if (errors.length) {
  console.log(`\ncould not be checked — re-run to resolve these:`);
  for (const e of errors) console.log(`  ${e}`);
}

if (WRITE) {
  saveDataset(data);
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record the snapshots found`);
}
