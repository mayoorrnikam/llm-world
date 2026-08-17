#!/usr/bin/env node
/**
 * Revisits records whose evidence was incomplete ON PURPOSE when they were added.
 *
 *   node scripts/follow-up.mjs            report what is outstanding
 *   node scripts/follow-up.mjs --write    record what can now be settled
 *
 * WHY THIS EXISTS
 *
 * A release is most worth adding on the day it is announced, and that is
 * precisely the day two things cannot be true yet:
 *
 *   1. ARCHIVE. archive.org has not captured the announcement, so R1 is unmet
 *      and the record carries a warning that reads like sloppiness when it is
 *      really just a wait.
 *   2. WEIGHTS. Labs increasingly announce a model and ship the weights days
 *      or weeks later — Alibaba said "next week" for Qwen3.8-Max and delivered
 *      on day five; Zhipu says "two weeks" for GLM-5.3. `access.open_weights`
 *      describes CURRENT state, so it is correctly false on announcement day
 *      and correctly true later, and nothing was checking for later.
 *
 * Both are the same shape of problem: a fact that will become available, on a
 * record that has already been published. Without something that comes back,
 * "not yet" silently becomes "never" — the dataset stops at whatever was
 * knowable the morning it was written.
 *
 * Grok-1 is the case that shows why this matters: announced 4 November 2023,
 * weights released 17 March 2024. Four and a half months. A record that only
 * ever holds the announcement date describes half the release.
 *
 * WHAT IT WILL NOT DO
 *
 * It never flips open_weights on its own. Finding a repository named after a
 * model is not proof the lab shipped THAT model's weights — the name may be a
 * fine-tune, a quantisation, a mirror, or somebody else's upload. It reports
 * the candidate and the person decides, which is the same bar every other
 * discovery script here holds to.
 */

import { readFileSync } from 'node:fs';
import { canonicalDate } from '../lib/record.mjs';
import { saveDataset } from '../lib/dataset.mjs';

const WRITE = process.argv.includes('--write');
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const R = data.releases;

const ageDays = (r) => Math.round((Date.now() - Date.parse(`${canonicalDate(r)}T00:00:00Z`)) / 864e5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 1. archives */

/**
 * Sources still without a snapshot, newest release first.
 *
 * Ordered by age because a three-day-old announcement is the one most likely
 * to have been captured since we last looked, and a two-year-old one that is
 * still missing is missing for a reason.
 */
const unarchived = R
  .filter((r) => r.sources.some((s) => !s.archived_url))
  .sort((a, b) => ageDays(a) - ageDays(b));

async function lookup(url) {
  try {
    const res = await fetch(
      `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'llm-world follow-up' } },
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const j = await res.json();
    const snap = j?.archived_snapshots?.closest;
    return snap?.available ? { url: snap.url, ts: snap.timestamp } : {};
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

/* ------------------------------------------------------------- 2. weights */

/** Announcement language that means "the weights are coming, but not yet". */
const PROMISES_WEIGHTS =
  /weights?[^.]{0,60}(will be|releas|follow|available|com(e|ing))|open-sourc[^.]{0,40}weights|coming soon/i;

const promised = R.filter((r) => !r.access.open_weights
  && PROMISES_WEIGHTS.test(`${r.note ?? ''} ${r.provenance?.reason ?? ''}`));

/**
 * The lab's repositories published SINCE the announcement.
 *
 * Not a name match, which is what the first version tried and why it found
 * nothing for the one case that had already resolved: Qwen3.8-Max's weights
 * shipped as `Qwen3.8-2.4T-A95B`, named for the architecture rather than the
 * product. Kimi, DeepSeek and Mistral all do the same thing. Matching on the
 * product name would keep reporting "nothing yet" about weights that are
 * already public — the most expensive kind of wrong, because it looks like an
 * answer.
 *
 * So this asks the question that can actually be answered: what has this lab
 * published since it made the promise? A short list a person can read beats a
 * confident empty one.
 */
async function weightsFor(model, org, since) {
  try {
    const res = await fetch(
      `https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=40`,
      { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'llm-world follow-up' } },
    );
    if (!res.ok) return [];
    return (await res.json())
      .filter((m) => m.createdAt && m.createdAt.slice(0, 10) >= since)
      .map((m) => ({ id: m.id, created: (m.createdAt ?? '').slice(0, 10), likes: m.likes ?? 0 }))
      .sort((a, b) => b.likes - a.likes);
  } catch { return []; }
}

/** Hugging Face org for a lab, where the name differs from the company. */
const HF_ORG = {
  'Alibaba Qwen': 'Qwen', 'Zhipu AI': 'zai-org', 'Meta AI': 'meta-llama',
  'Mistral AI': 'mistralai', 'Moonshot AI': 'moonshotai', DeepSeek: 'deepseek-ai',
  NVIDIA: 'nvidia', Microsoft: 'microsoft', 'Allen Institute for AI': 'allenai',
  MiniMax: 'MiniMaxAI', 'Black Forest Labs': 'black-forest-labs', 'Liquid AI': 'LiquidAI',
};

/* --------------------------------------------------------------- 3. gaps */

/**
 * Open-weight records that never recorded WHEN the weights appeared.
 *
 * Reported, never invented. The date is only knowable from a repository
 * timestamp or a second announcement, and guessing it would put a fabricated
 * event on a record whose whole worth is that its dates are traceable.
 */
const missingEvent = R.filter((r) => r.access.open_weights
  && !r.events.some((e) => e.type === 'weights_availability'));

/* ------------------------------------------------------------------ run */

console.log(`${R.length} records · ${unarchived.length} with an unarchived source · `
  + `${promised.length} awaiting promised weights\n`);

let found = 0;
if (unarchived.length) {
  console.log('SNAPSHOTS — re-checking archive.org, newest release first');
  for (const r of unarchived.slice(0, 25)) {
    for (const s of r.sources.filter((x) => !x.archived_url)) {
      const hit = await lookup(s.url);
      if (hit.error) { console.log(`  ~ ${r.id} — ${hit.error}`); continue; }
      if (!hit.url) continue;
      console.log(`  ✓ ${r.id.padEnd(24)} ${s.id} → ${hit.ts}`);
      if (WRITE) {
        s.archived_url = hit.url;
        s.retrieved = `${hit.ts.slice(0, 4)}-${hit.ts.slice(4, 6)}-${hit.ts.slice(6, 8)}`;
      }
      found++;
      await sleep(1200);
    }
  }
  if (!found) console.log('  none of them are captured yet');
}

if (promised.length) {
  console.log('\nWEIGHTS — records whose announcement promised them');
  for (const r of promised) {
    const org = HF_ORG[r.company] ?? r.company;
    const hits = await weightsFor(r.model, org, canonicalDate(r));
    console.log(`  ${r.id.padEnd(24)} announced ${canonicalDate(r)} · ${ageDays(r)}d ago`);
    if (!hits.length) { console.log('      nothing on Hugging Face under ' + org + ' yet'); continue; }
    for (const h of hits.slice(0, 4)) {
      console.log(`      → ${h.id} (created ${h.created}, ${h.likes} likes)`);
    }
    console.log('      Published since the announcement — NOT proof any of these are'
      + ' this model. Read the repository, then set open_weights and add a'
      + ' weights_availability event by hand.');
  }
}

if (missingEvent.length) {
  console.log(`\nGAPS — ${missingEvent.length} of ${R.filter((x) => x.access.open_weights).length}`
    + ' open-weight records have no weights_availability event, so the dataset'
    + '\n  says the weights are open but not when they appeared. Grok-1 shows why that'
    + '\n  matters: announced 2023-11-04, weights 2024-03-17 — four and a half months.');
}

if (WRITE && found) {
  saveDataset(data);
  console.log(`\nwrote data/llm-releases.json — ${found} snapshot(s) recorded`);
} else if (!WRITE) {
  console.log('\ndry run — pass --write to record the snapshots found');
}
