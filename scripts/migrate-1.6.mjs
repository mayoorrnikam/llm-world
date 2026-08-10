#!/usr/bin/env node
/**
 * One-shot migration: schema 1.5 → 1.6.
 *
 *   node scripts/migrate-1.6.mjs           report what would change
 *   node scripts/migrate-1.6.mjs --write   rewrite data/llm-releases.json
 *
 * Kept in the repo after running because it documents exactly how every value
 * moved. "Where did this field go" is answerable by reading this file.
 *
 * The six structural changes (see docs/EXECUTION-ORDER.md):
 *
 *   S1  + classification.primary_type / subtype
 *   S2  tags[] → capabilities[] + access; editorial judgements stay in tags[]
 *   S3  sources[] entries gain id, authority, archived_url, retrieved
 *   S4  year/month/day → events[]
 *   S5  technical → specifications.language
 *   S6  one record per separately named model (merges the Grok-1 pair)
 *
 * EVERY transformation here is mechanical and lossless. Where a 1.6 field
 * cannot be derived from existing data it is written as null and reported as
 * research owed — never guessed. That is why `modalities` comes out null: the
 * 1.5 dataset records *that* a model is multimodal, never *which* modalities,
 * and inventing them would breach the never-estimate rule.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');

const data = JSON.parse(readFileSync(FILE, 'utf8'));

/* ------------------------------------------------------------------- S2/S3 */

/** tags[] that are really capability claims. Exact 1:1, no interpretation. */
const TAG_TO_CAPABILITY = { reasoning: 'reasoning', agentic: 'agentic' };

/** tags[] that are really access facts — already stored in access{}. */
const TAG_IS_ACCESS = new Set(['open-weights']);

/** tags[] that are this project's own judgement. These stay in tags[].
 *  `multimodal` is here on purpose: until modalities are researched it is our
 *  claim, not a derived fact. It moves out the moment modalities exist. */
const EDITORIAL_TAGS = new Set(['flagship', 'small-efficient', 'multimodal']);

/** 1.5 source types → 1.6 type + default authority (METHODOLOGY §5). */
const SOURCE_MAP = {
  official_announcement: ['official_announcement', 'primary'],
  model_card: ['official_model_card', 'primary'],
  documentation: ['official_documentation', 'primary'],
  repository: ['official_repository', 'primary'],
  // Papers in this dataset are lab-authored; a third-party paper about a model
  // is secondary. Flagged for review rather than assumed correct.
  paper: ['technical_paper', 'primary'],
  secondary: ['news', 'secondary'],
};

const owed = { modalities: [], subtype: [], paper_authority: [], archive: [] };

/* --------------------------------------------------------------- transform */

function migrate(r) {
  const capabilities = r.tags.map((t) => TAG_TO_CAPABILITY[t]).filter(Boolean);
  const tags = r.tags.filter((t) => EDITORIAL_TAGS.has(t));

  for (const t of r.tags) {
    if (!TAG_TO_CAPABILITY[t] && !TAG_IS_ACCESS.has(t) && !EDITORIAL_TAGS.has(t)) {
      throw new Error(`${r.id}: unmapped tag "${t}" — add it to one of the three buckets above`);
    }
  }

  const sources = r.sources.map((s, i) => {
    const [type, authority] = SOURCE_MAP[s.type] ?? ['news', 'secondary'];
    if (s.type === 'paper') owed.paper_authority.push(`${r.id}-s${i + 1}`);
    if (type === 'official_documentation') owed.archive.push(`${r.id}-s${i + 1}`);
    return {
      id: `${r.id}-s${i + 1}`,
      url: s.url,
      type,
      authority,
      archived_url: null,
      retrieved: null,
    };
  });

  // S1 — every record in this dataset is a language model by construction, so
  // primary_type is evidenced, not inferred. subtype beyond slm is research.
  const subtype = r.tags.includes('small-efficient') ? 'slm' : 'llm';
  if (r.tags.includes('reasoning')) owed.subtype.push(r.id);
  if (r.tags.includes('multimodal')) owed.modalities.push(r.id);

  return {
    id: r.id,
    model: r.model,
    company: r.company,
    family: r.family,
    kind: r.kind,
    classification: { primary_type: 'language', subtype },
    // S2 (partial) — which modalities is not recorded in 1.5. Stage 2 research.
    modalities: null,
    capabilities,
    tags,
    note: r.note,
    // S4 — a single 1.5 date is an announcement date (METHODOLOGY §3).
    events: [{
      type: 'announcement',
      date: iso(r.year, r.month, r.day),
      sources: sources.map((s) => s.id),
    }],
    // S5 — one bucket. Others are added when a record needs them.
    specifications: { language: { ...r.technical } },
    access: { ...r.access },
    sources,
    provenance: { ...r.provenance },
  };
}

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}` + (d ? `-${String(d).padStart(2, '0')}` : '');

/* ------------------------------------------------------------------ S6 merge */

/**
 * Grok-1 shipped closed in Nov 2023 and its weights were published in Mar 2024.
 * 1.5 recorded that as two models, which double-counts xAI's output. One record,
 * two events (METHODOLOGY §2).
 */
function mergeGrok(list) {
  const base = list.find((r) => r.id === 'grok-1');
  const open = list.find((r) => r.id === 'grok-1-open');
  if (!base || !open) return list;

  // Both records cite the same repository. Merging naively would give one URL
  // two ids, which would then look like two independent corroborations.
  const byUrl = new Map(base.sources.map((s) => [s.url, s.id]));
  const weightsSources = open.sources.map((s) => {
    const existing = byUrl.get(s.url);
    if (existing) return existing;
    base.sources.push(s);
    byUrl.set(s.url, s.id);
    return s.id;
  });

  base.events.push({
    type: 'weights_availability',
    date: open.events[0].date,
    sources: weightsSources,
  });
  base.events.sort((a, b) => a.date.localeCompare(b.date));

  // access describes current state; the event dates the change.
  base.access = { ...open.access };

  // Fill gaps from the open record without overwriting anything already known.
  for (const [k, v] of Object.entries(open.specifications.language)) {
    if (base.specifications.language[k] == null) base.specifications.language[k] = v;
  }
  base.tags = [...new Set([...base.tags, ...open.tags])];
  base.capabilities = [...new Set([...base.capabilities, ...open.capabilities])];
  // Two records merged: keep the more conservative confidence.
  base.provenance.confidence = Math.min(base.provenance.confidence, open.provenance.confidence);
  // Old URL must keep resolving.
  base.previous_ids = ['grok-1-open'];

  return list.filter((r) => r.id !== 'grok-1-open');
}

/* -------------------------------------------------------------------- run */

const migrated = mergeGrok(data.releases.map(migrate));

const out = {
  updated: data.updated,
  schema_version: '1.6',
  releases: migrated,
};

console.log(`schema 1.5 → 1.6`);
console.log(`  ${data.releases.length} records in, ${migrated.length} out (Grok-1 pair merged)`);
console.log(`  ${migrated.reduce((a, r) => a + r.sources.length, 0)} sources given ids and authority`);
console.log(`  ${migrated.reduce((a, r) => a + r.events.length, 0)} events`);
console.log(`  ${migrated.reduce((a, r) => a + r.capabilities.length, 0)} capabilities split out of tags`);

console.log(`\nresearch owed (Stage 2) — written as null, never guessed:`);
console.log(`  modalities:  ${owed.modalities.length} records tagged multimodal with no per-modality evidence`);
console.log(`  subtype:     ${owed.subtype.length} reasoning-tagged records need the subtype-vs-capability call`);
console.log(`  authority:   ${owed.paper_authority.length} paper sources defaulted to primary; verify lab authorship`);
console.log(`  archive:     ${owed.archive.length} documentation sources need an archived snapshot (R1)`);

if (!WRITE) {
  console.log(`\ndry run — pass --write to apply`);
} else {
  writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
}
