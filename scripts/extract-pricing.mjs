#!/usr/bin/env node
/**
 * Reads token pricing out of archived primary sources.
 *
 *   node scripts/extract-pricing.mjs             report
 *   node scripts/extract-pricing.mjs --write     record pricing[]
 *   node scripts/extract-pricing.mjs --limit=20  do 20 and stop
 *
 * Stage 7. Pricing is the field this project nearly refused to build, on the
 * grounds that a price changes silently and the citation rots. The answer was
 * rule R1: cite the dated snapshot, never the live page. So this reads only
 * `archived_url`, and the validator now REJECTS a pricing entry whose source
 * has no snapshot — the price is evidenced as of that capture or not at all.
 *
 * Patterns are high-precision and require BOTH an input and an output rate.
 * A page mentioning one number is not a price table, and half a price is worse
 * than none: it invites a comparison that was never stated.
 *
 * Resumable and incremental, like attribute-facts.mjs — archive.org rate-limits,
 * and no slow fetch should have to be paid for twice.
 */

import { readFileSync, writeFileSync } from 'node:fs';
// One reader for every script: HTML, PDF and client-rendered pages, cached on
// disk so a full pass fetches each source once rather than five times.
import { sourceText, FAILED } from '../lib/source-text.mjs';


const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Each pattern must yield an input rate and an output rate, in that order.
 *
 *   "$5 per million input tokens and $25 per million output tokens"   prose
 *   "Price $1.25 • $10 Input • Output"                                OpenAI docs
 *   "Input $3.00 Output $15.00"                                       tables
 */
const PRICE_PATTERNS = [
  /\$\s*([\d.]+)\s*per\s*million\s*input\s*tokens?[^.$]{0,40}?\$\s*([\d.]+)\s*per\s*million\s*output\s*tokens?/i,
  /input[^.$]{0,30}?\$\s*([\d.]+)\s*\/\s*(?:1M|million)[^.$]{0,40}?output[^.$]{0,30}?\$\s*([\d.]+)\s*\/\s*(?:1M|million)/i,
  /\$\s*([\d.]+)\s*[•·]\s*\$\s*([\d.]+)\s*Input\s*[•·]\s*Output/i,
  /\bInput\s*\$\s*([\d.]+)\s*(?:\/\s*1M\s*tokens?)?\s*(?:•|·|\|)?\s*Output\s*\$\s*([\d.]+)/i,
];



const pending = data.releases.filter((r) => !r.pricing);
console.log(`${pending.length} records without pricing · trying ${Math.min(pending.length, LIMIT)}\n`);

let found = 0, none = 0, skipped = 0;

for (const r of pending.slice(0, LIMIT)) {
  // R1: only a snapshot can evidence a past price.
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  if (!archived.length) { skipped++; continue; }

  let hit = null;
  let failed = false;

  for (const s of archived) {
    const text = await sourceText(s.archived_url);
    if (text === FAILED) { failed = true; break; }
    for (const p of PRICE_PATTERNS) {
      const m = p.exec(text);
      if (!m) continue;
      const input = Number(m[1]), output = Number(m[2]);
      // A model whose output costs less than its input is possible but rare
      // enough that it is far more likely the pattern matched the wrong pair.
      if (!(input > 0) || !(output > 0) || output < input) continue;
      hit = { input, output, source: s.id, quote: m[0].trim().slice(0, 90) };
      break;
    }
    if (hit) break;
    await sleep(1200);
  }

  if (failed) { skipped++; process.stdout.write(`  ~ ${r.id} source unreadable, skipped\n`); continue; }

  if (!hit) { none++; continue; }

  found++;
  process.stdout.write(`  $ ${r.id}  in ${hit.input} / out ${hit.output}  "${hit.quote}"\n`);

  if (WRITE) {
    r.pricing = [{
      unit: 'per_million_tokens',
      rates: { input: hit.input, output: hit.output },
      currency: 'USD',
      // The date the price was OBSERVED, which is the snapshot's date — not
      // the model's announcement date.
      //
      // These are often years apart, and conflating them invents a fact. A 2026
      // capture of OpenAI's docs shows GPT-4o at $2.5/$10; GPT-4o launched in
      // 2024 at $5/$15. Labelling that snapshot "from May 13, 2024" would
      // publish a launch price that was never charged. The snapshot proves what
      // the page said on the day it was captured, and nothing more.
      observed_on: archived.find((s) => s.id === hit.source)?.retrieved ?? null,
      sources: [hit.source],
    }];
    writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  }
}

console.log(`\npricing found: ${found}`);
console.log(`no price stated in any primary source: ${none}`);
console.log(`skipped (unreadable or no archived source): ${skipped}`);
console.log(WRITE ? `\nwrote ${FILE}` : `\ndry run — pass --write to record`);
