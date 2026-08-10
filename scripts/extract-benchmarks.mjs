#!/usr/bin/env node
/**
 * Reads benchmark scores out of archived primary sources — and uses them to
 * evidence capabilities.
 *
 *   node scripts/extract-benchmarks.mjs             report
 *   node scripts/extract-benchmarks.mjs --write     record benchmarks[]
 *   node scripts/extract-benchmarks.mjs --limit=20  do 20 and stop
 *
 * TWO USES, AND ONLY ONE OF THEM RANKS ANYTHING
 *
 * 1. As dated claims. "GPT-5 scored 74.9% on SWE-bench Verified, vendor-reported,
 *    2025-08-07" is a fact about an assertion, not about the model
 *    (docs/METHODOLOGY.md §7). A later revision adds a row rather than replacing
 *    one, and no composite is ever computed — charter §26.
 *
 * 2. As evidence for capabilities, which is the more useful half. `coding` was
 *    recorded on 3 of 97 records, which is plainly wrong: nearly every modern
 *    model ships with coding benchmarks. The benchmark a lab CHOOSES to report
 *    is itself a claim about what the model is for, so reporting SWE-bench
 *    evidences coding, and τ-bench evidences agentic behaviour.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide a model is "good at" anything. A score evidences that the
 * lab measured and published the capability, nothing more. Scores are not
 * compared across models here: harnesses, prompting and effort settings differ,
 * and a table that puts two vendor-reported numbers side by side implies a
 * comparison neither lab agreed to.
 *
 * Only vendor_reported is produced. A lab's own announcement is a primary
 * source for what the lab claimed; an independent evaluation would need its own
 * sourcing pass and its own evaluation_type.
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
 * Benchmarks worth recording, with the capability each one evidences.
 *
 * `cap: null` means the benchmark is general knowledge or reasoning-adjacent in
 * a way that does not pin a specific capability — recorded as a score, but not
 * used to claim anything about what the model is for.
 */
const BENCHMARKS = [
  { name: 'SWE-bench Verified', re: /SWE-?bench\s+Verified/i, cap: 'coding' },
  { name: 'SWE-bench', re: /SWE-?bench(?!\s+Verified)/i, cap: 'coding' },
  { name: 'LiveCodeBench', re: /LiveCodeBench/i, cap: 'coding' },
  { name: 'HumanEval', re: /HumanEval/i, cap: 'coding' },
  { name: 'Aider Polyglot', re: /Aider\s+Polyglot/i, cap: 'coding' },
  { name: 'Terminal-Bench', re: /Terminal-?Bench/i, cap: 'agentic' },
  { name: 'tau-bench', re: /(?:τ|tau)-?bench/i, cap: 'agentic' },
  { name: 'OSWorld', re: /OSWorld/i, cap: 'agentic' },
  { name: 'WebArena', re: /WebArena/i, cap: 'agentic' },
  { name: 'GAIA', re: /\bGAIA\b/, cap: 'agentic' },
  { name: 'MMMU', re: /\bMMMU\b/, cap: 'vision' },
  { name: 'MathVista', re: /MathVista/i, cap: 'vision' },
  { name: 'DocVQA', re: /DocVQA/i, cap: 'vision' },
  { name: 'CharXiv', re: /CharXiv/i, cap: 'vision' },
  { name: 'GPQA Diamond', re: /GPQA\s+Diamond/i, cap: 'reasoning' },
  { name: 'GPQA', re: /GPQA(?!\s+Diamond)/i, cap: 'reasoning' },
  { name: 'AIME', re: /\bAIME\s*20\d{2}\b/i, cap: 'reasoning' },
  { name: 'Humanity’s Last Exam', re: /Humanity['’]s\s+Last\s+Exam/i, cap: 'reasoning' },
  { name: 'MGSM', re: /\bMGSM\b/, cap: 'multilingual' },
  { name: 'MMLU-Pro', re: /MMLU-?Pro/i, cap: null },
  { name: 'MMLU', re: /\bMMLU\b(?!-)/, cap: null },
];



/**
 * A score stated near the benchmark's name.
 *
 * Deliberately narrow: the number must sit within ~60 characters of the name
 * and read as a percentage or a 0-100 figure. Benchmark names appear in prose
 * far more often than they appear with a score ("strong results on SWE-bench"),
 * and a loose window happily attaches whatever digit is nearest.
 */
function scoreNear(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  // A percent sign within 40 characters, and nothing else. The first version
  // allowed a bare number in a 90-character window and produced "GPT-4 MMLU 14"
  // and "Gemini Ultra MMLU 57" — both wildly wrong, picked from a citation year
  // or a shot count sitting near the name. A benchmark name appears in prose far
  // more often than it appears with its score, so anything looser invents data.
  const win = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const s = /^[^.]{0,34}?(\d{1,3}(?:\.\d+)?)\s*%/.exec(win);
  if (!s) return null;
  const v = Number(s[1]);
  return v > 0 && v <= 100 ? v : null;
}

const pending = data.releases.filter((r) => !r.benchmarks);
console.log(`${pending.length} records without benchmarks · trying ${Math.min(pending.length, LIMIT)}\n`);

let withScores = 0, none = 0, skipped = 0, capsAdded = 0;

for (const r of pending.slice(0, LIMIT)) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  if (!archived.length) { skipped++; continue; }

  const corpus = [];
  let failed = false;
  for (const s of archived) {
    const t = await sourceText(s.archived_url);
    if (t === FAILED) { failed = true; break; }
    corpus.push({ id: s.id, text: t });
    await sleep(1000);
  }
  if (failed) { skipped++; process.stdout.write(`  ~ ${r.id} source unreadable\n`); continue; }

  const rows = [];
  const seen = new Set();
  for (const c of corpus) {
    for (const b of BENCHMARKS) {
      if (seen.has(b.name)) continue;
      const score = scoreNear(c.text, b.re);
      if (score == null) continue;
      seen.add(b.name);
      rows.push({
        name: b.name,
        score,
        evaluation_type: 'vendor_reported',
        reported_on: r.events[0].date,
        sources: [c.id],
        _cap: b.cap,
      });
    }
  }

  if (!rows.length) { none++; continue; }
  withScores++;

  // The capability a reported benchmark evidences. Additive only — nothing is
  // ever removed, because an unlisted capability means "not evidenced".
  const gained = [];
  for (const row of rows) {
    if (row._cap && !r.capabilities.includes(row._cap)) {
      gained.push(row._cap);
      if (WRITE) r.capabilities.push(row._cap);
    }
    delete row._cap;
  }
  capsAdded += gained.length;

  process.stdout.write(`  ${r.id.padEnd(20)} ${rows.map((x) => `${x.name} ${x.score}`).join(' · ')}`
    + `${gained.length ? `   →  +${gained.join(' +')}` : ''}\n`);

  if (WRITE) {
    r.benchmarks = rows;
    writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  }
}

console.log(`\nrecords with benchmarks: ${withScores}`);
console.log(`no benchmark score found: ${none}`);
console.log(`skipped (unreadable or no archived source): ${skipped}`);
console.log(`capabilities newly evidenced: ${capsAdded}`);
console.log(WRITE ? `\nwrote ${FILE}` : `\ndry run — pass --write to record`);
