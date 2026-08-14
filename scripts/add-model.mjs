#!/usr/bin/env node
/**
 * Adds a model record from a small spec, then hands off to the enrichment pass.
 *
 *   node scripts/add-model.mjs spec.json          check the spec, change nothing
 *   node scripts/add-model.mjs spec.json --write  add the record(s)
 *   npm run enrich                                archive → evidence → modalities
 *
 * Adding Ai2's Olmo 3 took six manual steps and one correction. This encodes
 * the steps so the next twenty labs cost a spec file rather than a session, and
 * so the parts that are easy to get wrong are refused rather than remembered.
 *
 * A spec carries only what a human must decide. Everything derivable is left to
 * the enrichment scripts, which read the sources and record what they say:
 *
 *   {
 *     "company": "MiniMax",
 *     "family": "MiniMax",
 *     "models": [
 *       { "id": "minimax-m3", "model": "MiniMax M3", "date": "2026-01-15",
 *         "note": "…",
 *         "sources": [
 *           { "url": "https://…", "type": "official_announcement" },
 *           { "url": "https://huggingface.co/…", "type": "official_model_card" }
 *         ],
 *         "open_weights": true,
 *         "license": "Apache-2.0",
 *         "parameter_count": 456000000000,
 *         "primary_type": "language",
 *         "capabilities": ["reasoning"]
 *       }
 *     ]
 *   }
 *
 * WHAT IT REFUSES, and why each one has already gone wrong here at least once:
 *
 *   - No primary source. A record that cites only news can never be verified,
 *     and five such records are still stuck in the dataset.
 *   - modalities. Never guessed at spec time; detect-modalities reads the
 *     sources. Writing "text" by hand is how a multimodal model gets published
 *     as text-only.
 *   - A licence on a proprietary record, which is a category error.
 *   - A family-shaped name with several sizes in one record. Nova, Phi-3,
 *     Gemini 1, Llama 4, GPT-OSS and Mistral 3 all had to be split afterwards.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';

const specPath = process.argv[2];
const WRITE = process.argv.includes('--write');
const FILE = 'data/llm-releases.json';

if (!specPath || specPath.startsWith('--')) {
  console.error('usage: node scripts/add-model.mjs spec.json [--write]');
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const data = JSON.parse(readFileSync(FILE, 'utf8'));

const PRIMARY_TYPES = new Set(['official_announcement', 'official_documentation',
  'official_model_card', 'official_repository', 'technical_paper']);
const SECONDARY_TYPES = new Set(['independent_benchmark', 'independent_analysis', 'news']);

const problems = [];
const warn = [];
const built = [];

for (const m of spec.models ?? []) {
  const where = m.id || m.model || '<unnamed>';

  if (!m.id) problems.push(`${where}: needs an id`);
  if (!m.model) problems.push(`${where}: needs a model name`);
  if (data.releases.some((r) => r.id === m.id)) problems.push(`${where}: id already exists`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date ?? '')) problems.push(`${where}: date must be YYYY-MM-DD`);

  const sources = m.sources ?? [];
  if (!sources.length) problems.push(`${where}: needs at least one source`);
  if (!sources.some((s) => PRIMARY_TYPES.has(s.type))) {
    problems.push(`${where}: needs a PRIMARY source — the lab's own announcement, `
      + `model card, repository or paper. A record citing only news can never be verified.`);
  }
  for (const s of sources) {
    if (!/^https?:\/\//.test(s.url ?? '')) problems.push(`${where}: source url must be http(s)`);
    if (!PRIMARY_TYPES.has(s.type) && !SECONDARY_TYPES.has(s.type)) {
      problems.push(`${where}: unknown source type "${s.type}"`);
    }
  }

  if ('modalities' in m) {
    problems.push(`${where}: do not set modalities by hand — run \`npm run enrich\`, which `
      + `reads the sources. Guessing here is how a multimodal model gets published as text-only.`);
  }
  if (m.license && m.open_weights === false) {
    problems.push(`${where}: a licence on a proprietary record is a category error`);
  }

  // The mistake this project has made six times.
  if (/\b(family|series)\b/i.test(m.note ?? '') || /\d+B\s*(?:,|and|\/)\s*\d+B/i.test(m.note ?? '')) {
    warn.push(`${where}: the note reads like a family. One record per separately named, `
      + `separately shipped model — split the sizes now rather than later.`);
  }

  const type = m.primary_type ?? 'language';
  built.push({
    id: m.id,
    model: m.model,
    company: spec.company,
    family: m.family ?? spec.family ?? m.model,
    classification: { primary_type: type, subtype: type === 'language' ? (m.subtype ?? 'llm') : null },
    // Left for detect-modalities; never asserted from a spec.
    modalities: null,
    capabilities: m.capabilities ?? [],
    tags: m.tags ?? [],
    note: m.note ?? '',
    events: [{ type: 'announcement', date: m.date, sources: sources.map((_, i) => `${m.id}-s${i + 1}`) }],
    specifications: type === 'language'
      ? { language: { context_window: m.context_window ?? null, parameter_count: m.parameter_count ?? null } }
      : {},
    access: { open_weights: Boolean(m.open_weights), license: m.license ?? null },
    sources: sources.map((s, i) => ({
      id: `${m.id}-s${i + 1}`,
      url: s.url,
      type: s.type,
      authority: PRIMARY_TYPES.has(s.type) ? 'primary' : 'secondary',
      archived_url: null,
      retrieved: null,
    })),
    provenance: {
      status: 'partially_verified',
      confidence: 60,
      reason: 'Newly added. Sources are not archived and no value has been traced to one yet — '
        + 'run `npm run enrich`.',
    },
  });
}

if (!built.length) problems.push('spec has no models');

for (const w of warn) console.log(`  WARN  ${w}`);
for (const p of problems) console.error(`  ERROR ${p}`);
if (problems.length) {
  console.error(`\nrefused — ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}

console.log(`\n${spec.company} — ${built.length} record${built.length === 1 ? '' : 's'}:`);
for (const r of built) {
  console.log(`  ${r.id.padEnd(20)} ${r.classification.primary_type.padEnd(17)} `
    + `${r.sources.length} sources (${r.sources.filter((s) => s.authority === 'primary').length} primary)`);
}

if (!WRITE) { console.log(`\ndry run — pass --write to add`); process.exit(0); }

data.releases.push(...built);
data.releases.sort((a, b) => a.events[0].date.localeCompare(b.events[0].date));
saveDataset(data);

console.log(`\nwrote ${FILE} — ${data.releases.length} releases`);
console.log(`\nNext: npm run enrich`);
console.log(`  archives the sources, traces each value to one, reads the modalities,`);
console.log(`  works out what the lab does not disclose, and restates the reasons.`);
console.log(`Then: npm run check`);
