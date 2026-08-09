#!/usr/bin/env node
/**
 * Merges researched technical specs into the dataset.
 *
 *   node scripts/apply-specs.mjs specs.json [...]
 *
 * Input shape:
 *   {"results":[{"id","context_window","parameter_count",
 *                "sources":[{"field","url"}]}]}
 *
 * A null value means "not publicly disclosed" and is written as null — it is
 * never guessed. Source URLs are folded into the release's sources[] so every
 * figure stays traceable (§7).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const DATA = 'data/llm-releases.json';
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const byId = new Map(data.releases.map((r) => [r.id, r]));

const typeFor = (url) =>
  /arxiv\.org/.test(url) ? 'paper'
  : /github\.com/.test(url) ? 'repository'
  : /huggingface\.co/.test(url) ? 'model_card'
  : /docs\.|\/docs\/|developers\./.test(url) ? 'documentation'
  : /artificialanalysis\.ai|wikipedia\.org/.test(url) ? 'secondary'
  : 'official_announcement';

let ctx = 0, par = 0, lic = 0, srcs = 0;
const missing = [], skippedLicense = [];

for (const file of process.argv.slice(2)) {
  for (const row of JSON.parse(readFileSync(file, 'utf8')).results ?? []) {
    const r = byId.get(row.id);
    if (!r) { missing.push(row.id); continue; }

    if (Number.isFinite(row.context_window) && row.context_window > 0) {
      r.technical.context_window = row.context_window; ctx++;
    }
    if (Number.isFinite(row.parameter_count) && row.parameter_count > 0) {
      r.technical.parameter_count = row.parameter_count; par++;
    }
    // Only open-weights models carry a licence; a licence on a proprietary
    // record would be a category error, so it is ignored rather than stored.
    if (typeof row.license === 'string' && row.license.trim()) {
      if (r.access.open_weights) { r.access.license = row.license.trim(); lic++; }
      else skippedLicense.push(row.id);
    }
    for (const s of row.sources ?? []) {
      if (!/^https?:\/\//.test(s.url ?? '')) continue;
      if (r.sources.some((x) => x.url === s.url)) continue;
      r.sources.push({ url: s.url, type: typeFor(s.url) });
      srcs++;
    }
  }
}

writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
const withCtx = data.releases.filter((r) => r.technical.context_window).length;
const withPar = data.releases.filter((r) => r.technical.parameter_count).length;
const withLic = data.releases.filter((r) => r.access.license).length;
const openW = data.releases.filter((r) => r.access.open_weights).length;
console.log(`applied: ${ctx} context windows, ${par} parameter counts, ${lic} licences, ${srcs} new sources`);
console.log(`coverage: ${withCtx}/${data.releases.length} context · ${withPar}/${data.releases.length} parameters · ${withLic}/${openW} licences (open-weights only)`);
if (missing.length) console.log(`unknown ids skipped: ${missing.join(', ')}`);
if (skippedLicense.length) console.log(`licence ignored on proprietary records: ${skippedLicense.join(', ')}`);
