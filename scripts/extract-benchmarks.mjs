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
import { saveDataset } from '../lib/dataset.mjs';
// One reader for every script: HTML, PDF and client-rendered pages, cached on
// disk so a full pass fetches each source once rather than five times.
import { sourceText, FAILED } from '../lib/source-text.mjs';
import { rowValues, cellScore, columnFor } from '../lib/benchmark-table.mjs';

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
  { name: 'MMLU-Redux', re: /MMLU-?Redux/i, cap: null },
  { name: 'MMLU', re: /\bMMLU\b(?!-)/, cap: null },

  /**
   * Names that only ever appear inside a comparison table.
   *
   * The list above was built from prose, where a lab names two or three
   * benchmarks in a sentence. A table names fifteen, and the table reader needs
   * at least three rows before it will trust a column count — so a list tuned
   * for prose falls under the threshold and the whole table is skipped. Muse
   * Glimmer's model card was doing exactly that: four readable rows, none of
   * them a name this list knew.
   */
  { name: 'SWE-bench Pro', re: /SWE-?bench\s+Pro/i, cap: 'coding' },
  { name: 'DeepSWE', re: /DeepSWE(?:\s*\d+(?:\.\d+)?)?/i, cap: 'coding' },
  { name: 'FrontierSWE', re: /FrontierSWE/i, cap: 'coding' },
  { name: 'MLS-Bench-Lite', re: /MLS-Bench-Lite/i, cap: null },
  { name: 'SciCode', re: /SciCode/i, cap: 'coding' },
  { name: 'OSWorld-Verified', re: /OSWorld-Verified/i, cap: 'agentic' },
  { name: 'ScreenSpot Pro', re: /ScreenSpot\s*Pro/i, cap: 'vision' },
  { name: 'AndroidWorld', re: /AndroidWorld/i, cap: 'agentic' },
  { name: 'WebArena-Verified', re: /WebArena-Verified/i, cap: 'agentic' },
  { name: 'MathVision', re: /MathVision/i, cap: 'vision' },
  { name: 'IFBench', re: /IFBench/i, cap: null },
  { name: 'C-Eval', re: /\bC-Eval\b/i, cap: 'multilingual' },
  { name: 'HealthBench', re: /HealthBench/i, cap: null },
  { name: 'ZeroBench', re: /ZeroBench/i, cap: 'vision' },
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
  const ok = (n) => (n > 0 && n <= 100 ? n : null);

  // BACKWARD FIRST, because ordinary prose puts the score before the name:
  // "74.9% on SWE-bench Verified, 88% on Aider Polyglot".
  //
  // Looking only forward reads that sentence off by one — it pairs SWE-bench
  // with Aider's 88, Aider with MMMU's 84.2, and MMMU with a health score of
  // 46.2. It did exactly that on eleven records, and every number would have
  // been published as the lab's own claim. Grok-1's "HumanEval 73" was MMLU's
  // score by the same slip.
  // The connector is what separates the two layouts, and it has to be present:
  // prose reads "74.9% ON SWE-bench Verified", while a benchmark TABLE reads
  // "20.8% LiveCodeBench v6 80" — where the 20.8 belongs to the row above and
  // 80 is this benchmark's score. Accepting a bare percentage before the name
  // reads every table backwards.
  const before = text.slice(Math.max(0, m.index - 30), m.index);
  const b = /(\d{1,3}(?:\.\d+)?)\s*%\s+(?:on|for|in)\s+(?:the\s+)?$/.exec(before);
  if (b) return ok(Number(b[1]));

  // FORWARD SECOND, for the table and spec-sheet form: "SWE-bench Verified 74.9%".
  // The window stops at any punctuation that could put the number with a
  // different benchmark — a comma is exactly what separates them in the list
  // above, so crossing one is how the off-by-one happened.
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const a = /^[^.,;:)\n]{0,20}?(\d{1,3}(?:\.\d+)?)\s*%/.exec(after);
  return a ? ok(Number(a[1])) : null;
}

/**
 * The model names this dataset knows, used to identify table columns by name.
 *
 * Headers abbreviate — Anthropic's "Claude Opus 4.8" prints as "Opus4.8" — so
 * each name also contributes its tail, which is what a header usually keeps.
 */
const LEXICON = [...new Set(data.releases.flatMap((r) => {
  const w = r.model.split(/\s+/);
  return [r.model, w.slice(1).join(' '), w.slice(2).join(' ')];
}))].filter((x) => x && x.length > 3);

/**
 * Scores read from a comparison table, keyed by benchmark name.
 *
 * See lib/benchmark-table.mjs for why the column is identified by name rather
 * than by position. Everything here is conservative on purpose:
 *
 *   - A table is only trusted when at least three rows agree on a width. One
 *     row proves nothing, and a stray match inside prose produces exactly one.
 *   - Rows that disagree with that width are DROPPED, not realigned. This is
 *     what handles a versioned name: `/Terminal-?Bench/` matches
 *     "Terminal-Bench 2.1" and leaves "2.1" to be read as the first cell,
 *     giving the row one column too many. Realigning it would be a guess about
 *     which number is the version; dropping it costs one benchmark.
 */
function tableScores(text, model) {
  const rows = [];
  for (const b of BENCHMARKS) {
    const re = new RegExp(b.re.source, b.re.flags.includes('g') ? b.re.flags : `${b.re.flags}g`);
    for (const m of text.matchAll(re)) {
      const { values } = rowValues(text, m.index + m[0].length);
      if (values.length >= 2) rows.push({ b, at: m.index, values });
    }
  }
  if (rows.length < 3) return new Map();

  const tally = {};
  for (const r of rows) tally[r.values.length] = (tally[r.values.length] ?? 0) + 1;
  const [width, n] = Object.entries(tally)
    .map(([w, c]) => [Number(w), c])
    .sort((a, b) => b[1] - a[1])[0];
  if (n < 3) return new Map();

  const group = rows.filter((r) => r.values.length === width).sort((a, b) => a.at - b.at);
  const header = text.slice(Math.max(0, group[0].at - 320), group[0].at);
  const col = columnFor(header, model, width, LEXICON);
  if (!col) return new Map();

  const out = new Map();
  for (const r of group) {
    if (out.has(r.b.name)) continue;
    const score = cellScore(r.values[col.index]);
    if (score != null) out.set(r.b.name, { score, cap: r.b.cap, columns: col.columns });
  }
  return out;
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

    // Prose first, table second. The prose reader is the proven one and its
    // matches are unambiguous; the table reader exists because modern
    // announcements state scores nowhere else.
    for (const [name, hit] of tableScores(c.text, r.model)) {
      if (seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        score: hit.score,
        evaluation_type: 'vendor_reported',
        reported_on: r.events[0].date,
        sources: [c.id],
        // The table this was read from, so a reader can check the column was
        // the right one rather than take the parser's word for it.
        compared_against: hit.columns,
        _cap: hit.cap,
      });
    }
  }

  if (!rows.length) { none++; continue; }
  withScores++;

  // The capability a reported benchmark evidences. Additive only — nothing is
  // ever removed, because an unlisted capability means "not evidenced".
  // Two benchmarks can evidence the same capability — GPT-5 reports both
  // SWE-bench and Aider Polyglot, and both mean `coding`. Without the gained
  // check the report reads "+coding +coding" and a --write run pushes the token
  // twice, so dedupe against what has already been gained this record, not just
  // against what the record started with.
  const gained = [];
  for (const row of rows) {
    if (row._cap && !r.capabilities.includes(row._cap) && !gained.includes(row._cap)) {
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
    saveDataset(data);
  }
}

console.log(`\nrecords with benchmarks: ${withScores}`);
console.log(`no benchmark score found: ${none}`);
console.log(`skipped (unreadable or no archived source): ${skipped}`);
console.log(`capabilities newly evidenced: ${capsAdded}`);
console.log(WRITE ? `\nwrote ${FILE}` : `\ndry run — pass --write to record`);
