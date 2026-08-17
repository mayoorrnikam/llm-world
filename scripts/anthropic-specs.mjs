#!/usr/bin/env node
/**
 * Reads Claude specifications from Anthropic's own model overview.
 *
 *   node scripts/anthropic-specs.mjs           report what the page states
 *   node scripts/anthropic-specs.mjs --write   record it
 *
 * THE TABLE IS TRANSPOSED, WHICH IS WHY THIS WAS LEFT UNTIL LAST
 *
 * Flattened to prose the overview reads:
 *
 *   Context window  1M tokens  1M tokens  1M tokens  200k tokens
 *   Max output      128k tokens  128k tokens  128k tokens  64k tokens
 *
 * Four values, four models, and nothing in the line saying which is which. That
 * is the same shape that made the benchmark reader dangerous — taking the first
 * number would give every Claude model Fable 5's figures.
 *
 * The markdown twin at the same path plus `.md` removes the problem entirely
 * rather than requiring the column-identification machinery in
 * benchmark-table.mjs. The table is transposed: the header row NAMES the
 * columns, and every row after it is one feature.
 *
 *   | Feature         | Claude Fable 5 | Claude Opus 5 | Claude Sonnet 5 | ...
 *   | Context window  | 1M tokens      | 1M tokens     | 1M tokens       | ...
 *   | Pricing         | $10 / input …  | $5 / input …  | $2 / input …    | ...
 *
 * So a model's column index comes from the header, by name, and every figure
 * for it is that index in each row. Explicit, not inferred — which is the whole
 * reason to prefer the .md over the page a person sees.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import {
  fetchText, mdRows, tokens, dollars, flat, applySpecs, untrackedIn, report,
} from '../lib/model-docs.mjs';

const WRITE = process.argv.includes('--write');
const SRC = 'https://platform.claude.com/docs/en/about-claude/models/overview.md';
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

const md = await fetchText(SRC);
if (!md) { console.error(`could not read ${SRC}`); process.exit(2); }

const rows = mdRows(md);
/** The header row is the one whose first cell labels the others. */
const header = rows.find((c) => /^feature$/i.test(c[0]?.replace(/\*/g, '').trim()));
if (!header) { console.error('no feature/model header row — the page shape changed'); process.exit(3); }

const models = header.slice(1).map((h) => h.replace(/\*/g, '').trim()).filter(Boolean);
const rowFor = (label) => rows.find((c) =>
  new RegExp(`^\\*{0,2}${label}\\*{0,2}\\d*$`, 'i').test(c[0]?.trim()));

const ctxRow = rowFor('Context window');
const priceRow = rowFor('Pricing');

const specs = new Map();
models.forEach((name, i) => {
  const cell = (row) => row?.[i + 1] ?? '';
  // Anthropic wraps the context figure in a <Tooltip> with prose inside; the
  // token count is the first "<n>k|M tokens" in the cell, and the tooltip text
  // is words and characters, never that shape.
  const ctxText = /([\d.,]+\s*[kM])\s*tokens/.exec(cell(ctxRow));
  const p = cell(priceRow);
  const inp = /\$\s*([\d.]+)\s*\/\s*input/i.exec(p);
  const out = /\$\s*([\d.]+)\s*\/\s*output/i.exec(p);
  specs.set(name, {
    context_window: ctxText ? tokens(ctxText[1]) : null,
    input_price: inp ? Number(inp[1]) : dollars(p),
    output_price: out ? Number(out[1]) : null,
  });
});

const records = data.releases.filter((r) => r.company === 'Anthropic');
console.log(`${records.length} Anthropic records · ${specs.size} models in the overview table\n`);

const results = applySpecs({
  records,
  specs,
  write: WRITE,
  today: new Date().toISOString().slice(0, 10),
  priceNote: 'Standard tier. Anthropic prices batch and cached tokens differently.',
  // One page describes every model, so every record cites the same URL — and it
  // is this page, not the announcement, that states the price being recorded.
  docsUrl: () => SRC,
  docsSuffix: 'adocs',
});

const filled = report('Anthropic', results, untrackedIn(specs, records), {
  write: WRITE,
  note: 'Modalities are not imported: the overview states vision support as a'
    + '\nYes/No feature row, and TAXONOMY §4 reads an unlisted capability as "not'
    + '\nevidenced" rather than "absent" — a "No" cell has no equivalent here.',
});

if (WRITE && filled) {
  saveDataset(data);
  console.log('wrote data/llm-releases.json');
}
