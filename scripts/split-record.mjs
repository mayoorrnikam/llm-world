#!/usr/bin/env node
/**
 * Splits a family-named record into the models a lab actually shipped.
 *
 *   node scripts/split-record.mjs spec.json           report
 *   node scripts/split-record.mjs spec.json --write   apply
 *
 * The generalisation of split-nova.mjs. Several records are named after a
 * family while holding one variant's specifications — `phi-3` carried Phi-3
 * Medium's 14B under the family's name, `llama-4` carries one of Scout,
 * Maverick and Behemoth, and so on. Under S6 each separately named, separately
 * shipped model is its own record.
 *
 * Spec shape:
 *
 *   {
 *     "from": "phi-3",
 *     "redirect_to": "families/phi",       // where the retired URL should land
 *     "into": [
 *       { "id": "phi-3-mini", "model": "Phi-3-mini",
 *         "parameter_count": 3800000000,   // omit a field to inherit it
 *         "context_window": null,          // explicit null clears it
 *         "note": "…",
 *         "evidence_quote": "…"            // required: why these values
 *       }
 *     ]
 *   }
 *
 * Anything not named on a part is inherited from the original record, so a
 * split cannot silently lose company, family, sources, access or modalities.
 * Every part must carry an evidence_quote — a split is a set of new claims, and
 * claims need a reason a reader can check.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'data/llm-releases.json';
const specPath = process.argv[2];
const WRITE = process.argv.includes('--write');

if (!specPath || specPath.startsWith('--')) {
  console.error('usage: node scripts/split-record.mjs spec.json [--write]');
  process.exit(1);
}

const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const data = JSON.parse(readFileSync(FILE, 'utf8'));

const original = data.releases.find((r) => r.id === spec.from);
if (!original) {
  console.log(`"${spec.from}" not found — already split?`);
  process.exit(0);
}
if (!Array.isArray(spec.into) || spec.into.length < 2) {
  console.error('spec.into must list at least two models');
  process.exit(1);
}

const parts = spec.into.map((p) => {
  if (!p.evidence_quote?.trim()) {
    console.error(`${p.id}: every part needs an evidence_quote`);
    process.exit(1);
  }

  // Inherit everything, then override only what the spec names. `in` is used
  // rather than truthiness so an explicit null can clear an inherited value.
  const language = { ...(original.specifications?.language ?? {}) };
  if ('context_window' in p) language.context_window = p.context_window;
  if ('parameter_count' in p) language.parameter_count = p.parameter_count;

  return {
    ...structuredClone(original),
    id: p.id,
    model: p.model,
    note: p.note ?? original.note,
    classification: p.classification ?? original.classification,
    modalities: 'modalities' in p ? p.modalities : original.modalities,
    capabilities: p.capabilities ?? original.capabilities,
    tags: p.tags ?? original.tags,
    specifications: Object.keys(language).length ? { language } : {},
    // Provenance is rewritten, not inherited: the old reason described the old
    // record's evidence, and these are new claims.
    provenance: {
      status: p.status ?? 'partially_verified',
      confidence: p.confidence ?? original.provenance.confidence,
      reason: `Split from the former "${original.id}" record, which was named for the `
        + `family while holding one variant's figures. Evidence: "${p.evidence_quote.trim()}"`,
    },
    // undisclosed[] is about the original's fields; re-state per part.
    ...(p.undisclosed ? { undisclosed: p.undisclosed } : { undisclosed: undefined }),
  };
}).map((r) => {
  if (r.undisclosed === undefined) delete r.undisclosed;
  // evidence[] referenced the old record's values and cannot survive a split.
  delete r.evidence;
  return r;
});

const idx = data.releases.indexOf(original);
data.releases.splice(idx, 1, ...parts);

if (spec.redirect_to) {
  data.redirects = [...(data.redirects ?? []), {
    from: `models/${spec.from}`,
    to: spec.redirect_to,
    reason: spec.redirect_reason
      ?? `The "${original.model}" record described a family and was split into the models `
        + `that shipped under it.`,
  }];
}

console.log(`split ${spec.from} → ${parts.length} records:`);
for (const r of parts) {
  const l = r.specifications.language ?? {};
  console.log(`  ${r.id.padEnd(16)} ${String(l.parameter_count ?? '—').padEnd(14)} `
    + `ctx ${l.context_window ?? '—'}`);
}
console.log(`\nreleases: ${data.releases.length - parts.length + 1} → ${data.releases.length}`);
console.log(`evidence[] cleared on each part — it referenced the old record's values`);

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to apply`);
}
