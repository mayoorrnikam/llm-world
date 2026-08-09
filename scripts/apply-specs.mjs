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

let ctx = 0, par = 0, srcs = 0, missing = [];

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
console.log(`applied: ${ctx} context windows, ${par} parameter counts, ${srcs} new sources`);
console.log(`coverage: ${withCtx}/${data.releases.length} context · ${withPar}/${data.releases.length} parameters`);
if (missing.length) console.log(`unknown ids skipped: ${missing.join(', ')}`);
