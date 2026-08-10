#!/usr/bin/env node
/**
 * Merges researched values into the dataset.
 *
 *   node scripts/apply-specs.mjs specs.json [...]
 *
 * Input shape — every key optional except `id`:
 *   {"results":[{
 *      "id": "gpt-4o",
 *      "context_window": 128000,
 *      "parameter_count": null,
 *      "license": "Apache-2.0",
 *      "modalities": { "input": ["text","image"], "output": ["text"] },
 *      "capabilities": ["vision"],            // merged, never replaced
 *      "subtype": "reasoning",
 *      "provenance": { "status": "verified", "confidence": 90, "reason": "…" },
 *      "sources": [{ "field": "modalities", "url": "…" }]
 *   }]}
 *
 * A null value means "not publicly disclosed" and is written as null — it is
 * never guessed. Source URLs are folded into the release's sources[] so every
 * value stays traceable (docs/METHODOLOGY.md §1, §5).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DATA = 'data/llm-releases.json';
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const byId = new Map(data.releases.map((r) => [r.id, r]));

// Schema 1.6 source types, with the authority each implies (METHODOLOGY §5).
const typeFor = (url) =>
  /arxiv\.org/.test(url) ? 'technical_paper'
  : /github\.com/.test(url) ? 'official_repository'
  : /huggingface\.co/.test(url) ? 'official_model_card'
  : /docs\.|\/docs\/|developers\./.test(url) ? 'official_documentation'
  : /artificialanalysis\.ai|wikipedia\.org/.test(url) ? 'news'
  : 'official_announcement';

const AUTHORITY_FOR = {
  official_announcement: 'primary', official_documentation: 'primary',
  official_model_card: 'primary', official_repository: 'primary',
  technical_paper: 'primary', independent_benchmark: 'secondary',
  independent_analysis: 'secondary', news: 'secondary',
};

/** Source ids are stable and per-record, so events[] can reference them. */
const nextSourceId = (r) => {
  let n = r.sources.length + 1;
  while (r.sources.some((s) => s.id === `${r.id}-s${n}`)) n++;
  return `${r.id}-s${n}`;
};

const VALID_MODALITY = new Set(['text', 'image', 'audio', 'video', '3d', 'sensor', 'environment']);

let ctx = 0, par = 0, lic = 0, srcs = 0, mods = 0, caps = 0, subs = 0, provs = 0;
const missing = [], skippedLicense = [], badModality = [];

for (const file of process.argv.slice(2)) {
  for (const row of JSON.parse(readFileSync(file, 'utf8')).results ?? []) {
    const r = byId.get(row.id);
    if (!r) { missing.push(row.id); continue; }

    const spec = (r.specifications ??= {}).language ??= {};
    if (Number.isFinite(row.context_window) && row.context_window > 0) {
      spec.context_window = row.context_window; ctx++;
    }
    if (Number.isFinite(row.parameter_count) && row.parameter_count > 0) {
      spec.parameter_count = row.parameter_count; par++;
    }
    // Only open-weights models carry a licence; a licence on a proprietary
    // record would be a category error, so it is ignored rather than stored.
    if (typeof row.license === 'string' && row.license.trim()) {
      if (r.access.open_weights) { r.access.license = row.license.trim(); lic++; }
      else skippedLicense.push(row.id);
    }
    // Modalities are recorded only when a source enumerates them. "Multimodal"
    // on its own is not enough — it says that there is more than one, not which.
    if (row.modalities) {
      const { input, output } = row.modalities;
      const all = [...(input ?? []), ...(output ?? [])];
      if (!input?.length || !output?.length || all.some((m) => !VALID_MODALITY.has(m))) {
        badModality.push(row.id);
      } else {
        r.modalities = { input: [...input], output: [...output] };
        // Once modalities exist, "multimodal" is derived from them. Leaving the
        // editorial tag would store the same fact twice (METHODOLOGY §4), and
        // the validator rejects it.
        r.tags = r.tags.filter((t) => t !== 'multimodal');
        mods++;
      }
    }

    // Capabilities are merged, never replaced: an existing evidenced capability
    // is not dropped because this batch happened not to mention it.
    for (const c of row.capabilities ?? []) {
      if (!r.capabilities.includes(c)) { r.capabilities.push(c); caps++; }
    }

    if (typeof row.subtype === 'string' && row.subtype.trim()) {
      r.classification.subtype = row.subtype.trim(); subs++;
    }

    if (row.provenance) {
      const p = row.provenance;
      if (p.status) r.provenance.status = p.status;
      if (Number.isInteger(p.confidence)) r.provenance.confidence = p.confidence;
      if (typeof p.reason === 'string') r.provenance.reason = p.reason.trim();
      provs++;
    }

    for (const s of row.sources ?? []) {
      if (!/^https?:\/\//.test(s.url ?? '')) continue;
      // One URL, one id — a second id for the same page would read as a second
      // independent corroboration.
      if (r.sources.some((x) => x.url === s.url)) continue;
      const type = typeFor(s.url);
      r.sources.push({
        id: nextSourceId(r),
        url: s.url,
        type,
        authority: AUTHORITY_FOR[type],
        archived_url: null,
        retrieved: null,
      });
      srcs++;
    }
  }
}

writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
const withCtx = data.releases.filter((r) => r.specifications?.language?.context_window).length;
const withPar = data.releases.filter((r) => r.specifications?.language?.parameter_count).length;
const withLic = data.releases.filter((r) => r.access.license).length;
const openW = data.releases.filter((r) => r.access.open_weights).length;
console.log(`applied: ${ctx} context windows, ${par} parameter counts, ${lic} licences, ${srcs} new sources`);
console.log(`         ${mods} modality sets, ${caps} capabilities, ${subs} subtypes, ${provs} provenance updates`);
if (badModality.length) console.log(`rejected malformed modalities: ${badModality.join(', ')}`);
console.log(`coverage: ${withCtx}/${data.releases.length} context · ${withPar}/${data.releases.length} parameters · ${withLic}/${openW} licences (open-weights only)`);
if (missing.length) console.log(`unknown ids skipped: ${missing.join(', ')}`);
if (skippedLicense.length) console.log(`licence ignored on proprietary records: ${skippedLicense.join(', ')}`);
