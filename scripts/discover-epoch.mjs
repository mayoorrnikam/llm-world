#!/usr/bin/env node
/**
 * Finds language models and labs this dataset is missing, using Epoch AI's
 * notable-models database as a map to primary sources.
 *
 *   node scripts/discover-epoch.mjs                report the gaps
 *   node scripts/discover-epoch.mjs --labs         just the missing labs
 *   node scripts/discover-epoch.mjs --since=2024   narrow the window
 *
 * WHAT THIS IS AND IS NOT
 *
 * Epoch AI is a research organisation, not a model lab, so under
 * docs/METHODOLOGY.md §5 its database is a SECONDARY source. It can never back
 * a value here. What it can do is tell us what exists — and, crucially, its
 * `Link` column points at each model's own paper or announcement, which is
 * exactly the primary source we would go on to cite.
 *
 * So: Epoch says where to look; the lab says what is true. Same rule applied to
 * release trackers and to a reader's blog link earlier.
 *
 * LEGALLY, this one is clean. Epoch publishes under CC BY 4.0 — the same
 * licence as this dataset — so it may be used and quoted with attribution.
 * That is not true of every tracker: llmgateway's catalogue is AGPL and
 * aireleasetracker is an EU database right, and CLAUDE.md forbids mirroring
 * either. Nothing from Epoch is copied into the dataset regardless; only the
 * primary links it points at are followed.
 */

import { readFileSync, existsSync } from 'node:fs';

const CSV = process.argv.find((a) => a.startsWith('--csv='))?.split('=')[1]
  ?? 'epoch-notable-models.csv';
const SINCE = Number(process.argv.find((a) => a.startsWith('--since='))?.split('=')[1] ?? 2023);
const LABS_ONLY = process.argv.includes('--labs');

if (!existsSync(CSV)) {
  console.error(`missing ${CSV}\n\nDownload it first (CC BY 4.0, attribute Epoch AI):`);
  console.error(`  curl -sL https://epoch.ai/data/notable_ai_models.csv -o ${CSV}`);
  process.exit(1);
}

/** Minimal RFC-4180 reader — fields are quoted and contain commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const have = data.releases;

/** Loose name match: "GPT-4o" vs "gpt 4o" vs "GPT‑4o". */
const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const haveNames = new Set(have.flatMap((r) => [flat(r.model), flat(r.id)]));
const haveLabs = new Set(have.map((r) => flat(r.company)));

/** Epoch's org names differ from ours; map the ones we already track. */
const LAB_ALIAS = {
  google: 'googledeepmind', googledeepmind: 'googledeepmind', deepmind: 'googledeepmind',
  metaai: 'metaai', meta: 'metaai', 'metaaifair': 'metaai',
  alibaba: 'alibabaqwen', qwen: 'alibabaqwen',
  microsoftresearch: 'microsoft', microsoft: 'microsoft',
  zhipuai: 'zhipuai', 'zhipuaitsinghuauniversity': 'zhipuai',
  mistralai: 'mistralai', moonshotai: 'moonshotai', ai21labs: 'ai21labs',
};
/**
 * Epoch writes lab names differently to us — "Moonshot" for Moonshot AI,
 * "Z.ai (Zhipu AI)" for Zhipu. Exact matching reported both as untracked, which
 * overstates the gap. Fall back to containment in either direction.
 */
const normLab = (s) => {
  const k = flat(s);
  if (LAB_ALIAS[k]) return LAB_ALIAS[k];
  for (const known of haveLabs) {
    if (known.length >= 4 && (k.includes(known) || known.includes(k))) return known;
  }
  return k;
};

const rows = parseCsv(readFileSync(CSV, 'utf8'))
  .filter((r) => /language/i.test(r.Domain))
  .filter((r) => {
    const y = Number(String(r['Publication date']).slice(0, 4));
    return Number.isFinite(y) && y >= SINCE;
  });

const missing = rows.filter((r) => !haveNames.has(flat(r.Model)));

/* ------------------------------------------------------------------ labs */

const labCounts = new Map();
for (const r of missing) {
  const lab = r.Organization.split(',')[0].trim();
  if (!lab) continue;
  const key = normLab(lab);
  if (haveLabs.has(key)) continue;
  const e = labCounts.get(lab) ?? { n: 0, newest: '', example: '', link: '' };
  e.n++;
  if (r['Publication date'] > e.newest) {
    e.newest = r['Publication date']; e.example = r.Model; e.link = r.Link;
  }
  labCounts.set(lab, e);
}

const labs = [...labCounts.entries()].sort((a, b) => b[1].n - a[1].n);

console.log(`Epoch notable models · language domain · ${SINCE}+`);
console.log(`  ${rows.length} in Epoch · ${have.length} tracked here · ${missing.length} not tracked\n`);

console.log(`LABS NOT TRACKED AT ALL (${labs.length}), by how many models Epoch lists:\n`);
for (const [lab, e] of labs.slice(0, 20)) {
  console.log(`  ${String(e.n).padStart(3)}  ${lab}`);
  console.log(`       latest: ${e.example} (${e.newest.slice(0, 10)})`);
  if (e.link) console.log(`       primary: ${e.link}`);
}

if (LABS_ONLY) process.exit(0);

/* ---------------------------------------------------- models from our labs */

const ours = missing
  .filter((r) => haveLabs.has(normLab(r.Organization.split(',')[0].trim())))
  .sort((a, b) => String(b['Publication date']).localeCompare(String(a['Publication date'])));

console.log(`\nMODELS FROM LABS WE ALREADY TRACK, not in the dataset (${ours.length}):\n`);
for (const r of ours.slice(0, 30)) {
  console.log(`  ${r['Publication date'].slice(0, 10)}  ${r.Model}  —  ${r.Organization.split(',')[0]}`);
  if (r.Link) console.log(`       primary: ${r.Link}`);
}

console.log(`\nEpoch AI, CC BY 4.0. Nothing here is copied into the dataset — the Link`);
console.log(`column is followed to each lab's own source, which is what gets cited.`);
