#!/usr/bin/env node
/**
 * One-shot: move products out of the model dataset into data/milestones.json.
 *
 *   node scripts/migrate-milestones.mjs           report
 *   node scripts/migrate-milestones.mjs --write   apply
 *
 * Kept in the repo so the move is auditable, like migrate-1.6.mjs.
 *
 * WHY (docs/TAXONOMY.md §7): the dataset holds models — sets of weights a lab
 * names and ships, with parameters, a context window and a licence. ChatGPT is
 * not a model; it is a product served by GPT-3.5. Filing it as a model gives it
 * a row where every specification is null, and inflates OpenAI's model count
 * with something that was never a model.
 *
 * Deleting it would be worse. ChatGPT's launch is one of the most significant
 * dated events in this history. So it becomes a MILESTONE: a dated event that
 * mattered, whether or not it was a model release.
 *
 * With products gone, every record in llm-releases.json is a model, so `kind`
 * has nothing left to discriminate and is dropped. Which file a record lives in
 * is now the discriminator.
 *
 * Old URLs keep resolving: /models/chatgpt/ redirects to /milestones/chatgpt/.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const RELEASES = 'data/llm-releases.json';
const MILESTONES = 'data/milestones.json';
const WRITE = process.argv.includes('--write');

const data = JSON.parse(readFileSync(RELEASES, 'utf8'));

/** What kind of moment this was. Only types with a record are listed. */
const TYPE_FOR = { chatgpt: 'product_launch', bard: 'product_launch' };

/** Why this event mattered — the thing a model record has no field for. */
const SIGNIFICANCE = {
  chatgpt: 'The moment large language models reached the general public. '
    + 'Everything in this timeline after November 2022 happens in a market ChatGPT created.',
  bard: "Google's first consumer answer to ChatGPT, and the start of the "
    + 'assistant race between the two largest labs.',
};

const moving = data.releases.filter((r) => r.kind && r.kind !== 'model');

if (!moving.length) {
  console.log('no product records left to move — already migrated');
  process.exit(0);
}

const milestones = moving.map((r) => ({
  id: r.id,
  title: `${r.model} launches`,
  // A milestone is one dated event, so it carries a date rather than events[].
  date: r.events[0].date,
  type: TYPE_FOR[r.id] ?? 'product_launch',
  company: r.company,
  note: r.note,
  significance: SIGNIFICANCE[r.id] ?? null,
  // The model line this product was served by, where we track it.
  related_family: r.family ?? null,
  sources: r.sources,
  provenance: {
    status: r.provenance.status,
    confidence: r.provenance.confidence,
    // The old reason talks about specifications a milestone does not have.
    reason: `Date confirmed in an archived primary source. A milestone records a `
      + `dated event, so it carries no specifications.`,
  },
}));

const kept = data.releases
  .filter((r) => !moving.includes(r))
  .map((r) => {
    // `kind` discriminated models from products. With products gone it always
    // reads "model", so it stops carrying information (METHODOLOGY §4).
    const { kind, ...rest } = r;
    return rest;
  });

console.log(`moving ${moving.length} product record(s) to ${MILESTONES}:`);
for (const m of milestones) console.log(`  ${m.id} — ${m.title} (${m.date})`);
console.log(`\nreleases: ${data.releases.length} → ${kept.length}`);
console.log(`dropping "kind" from ${kept.length} model records — every record is now a model`);

if (!WRITE) {
  console.log('\ndry run — pass --write to apply');
  process.exit(0);
}

if (existsSync(MILESTONES)) {
  console.error(`\nREFUSING: ${MILESTONES} already exists. Merge by hand rather than overwrite.`);
  process.exit(1);
}

writeFileSync(MILESTONES, JSON.stringify({
  updated: data.updated,
  schema_version: '1.6',
  milestones,
}, null, 2) + '\n');

writeFileSync(RELEASES, JSON.stringify({
  updated: data.updated,
  schema_version: data.schema_version,
  releases: kept,
}, null, 2) + '\n');

console.log(`\nwrote ${MILESTONES} and ${RELEASES}`);
