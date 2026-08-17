#!/usr/bin/env node
/**
 * Dates when a model's weights actually became downloadable.
 *
 *   node scripts/weights-events.mjs           report what the announcements say
 *   node scripts/weights-events.mjs --write   record the unambiguous ones
 *
 * `access` describes the current state; `events[]` records when it changed
 * (METHODOLOGY §3). 76 of 77 open-weight records assert open_weights: true and
 * date nothing, so "was this model open in November 2023?" — a question about
 * events, not flags — has no answer for almost the whole dataset.
 *
 * WHY NOT HUGGING FACE'S createdAt, WHICH WOULD HAVE ANSWERED ALL 77
 *
 * The API hands over a repo creation timestamp equal to its initial commit, and
 * it is systematically EARLIER than the release:
 *
 *   BLOOM         announced 2022-07-12, repo created 2022-05-19   54 days early
 *   Mistral 7B    announced 2023-09-27, repo created 2023-09-20    7 days early
 *   Llama 3       announced 2024-04-18, repo created 2024-04-17    1 day early
 *
 * Labs create the repo private and flip it public on launch day. Writing
 * createdAt would publish "the weights were downloadable before the model was
 * announced" — 76 fabricated claims, all wrong in the same direction, each
 * looking perfectly plausible. It is the archived-capture-predating-the-release
 * bug with a different data source.
 *
 * WHAT COUNTS AS EVIDENCE
 *
 * The lab saying so. A weights_availability event is written only where the
 * announcement states the weights are out, and only with the sentence that says
 * it — printed for review, because "available today" and "will be available in
 * the coming weeks" sit one paragraph apart in the same post. GLM-5.3 is the
 * live example: announced as the most capable open-weights coding model, with
 * the weights promised two weeks later. Its access flag and its event date are
 * different facts and this dataset keeps them different.
 *
 * Anything ambiguous is reported and left alone. An unanswered question is a
 * gap; a guessed date is a lie with a citation.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import { canonicalDate } from '../lib/record.mjs';
import { sourceText } from '../lib/source-text.mjs';

const WRITE = process.argv.includes('--write');
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/**
 * The weights are out, now.
 *
 * These were much looser on the first pass and matched six false positives out
 * of eleven — a safety paragraph ("Once an open-weight model IS RELEASED,
 * adversaries may…"), a sentence about parameter sizes ("open-weight models
 * ARE dense … AVAILABLE in various sizes"), and an evaluation-score sentence
 * that contained none of it. Prose regexes cannot tell a claim from a
 * hypothetical about the same words, so these now demand the shape of an actual
 * distribution statement: a thing that is downloadable, and somewhere to get
 * it. Recall drops; a wrong date is worse than a missing one.
 */
const OUT = [
  /\b(?:weights|checkpoints)\b[^.]{0,60}\b(?:are|is)\s+(?:now\s+)?(?:available|downloadable|released)\b[^.]{0,50}\b(?:on|from|via|at)\s+(?:hugging\s*face|huggingface|github|ollama)/i,
  /\b(?:available|downloadable)\s+(?:now|today)\b[^.]{0,50}\b(?:on|from|via)\s+(?:hugging\s*face|huggingface|github)/i,
  /\bwe(?:'re|\s+are)\s+(?:open[- ]sourcing|releasing|publishing)\b[^.]{0,70}\b(?:weights|checkpoints)\b/i,
  /\b(?:download|grab)\s+the\s+(?:model\s+)?(?:weights|checkpoints)\b/i,
  /\b(?:weights|checkpoints)\b[^.]{0,40}\b(?:are|is)\s+(?:openly\s+)?(?:available|released)\s+(?:today|now)\b/i,
];

/**
 * Words that make a sentence a hypothetical, a caveat or a comparison rather
 * than a claim about this model. Any of these disqualifies the sentence, which
 * is blunt and deliberate: the cost of dropping a real match is a gap, and the
 * cost of keeping a fake one is a fabricated date on a published record.
 */
const NOT_A_CLAIM = /\b(?:once|if|whether|unless|may|might|could|would|should|adversar\w+|risk\w*|threat\w*|assume|suppose|hypothetic\w+|other\s+(?:labs|models))\b/i;
/** The weights are promised. Never a date. */
const LATER = [
  /\bwill\s+be\s+(?:available|released|open[- ]sourced)/i,
  /\bcoming\s+(?:soon|weeks?|days?)/i,
  /\bin\s+the\s+(?:coming|next)\s+(?:weeks?|days?|months?)/i,
  /\bplan\s+to\s+(?:release|open[- ]source)/i,
  /\bsoon\b[^.]{0,30}\bhugging\s*face/i,
];

const sentences = (t) => t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);

const open = data.releases.filter((r) => r.access?.open_weights === true
  && !r.events?.some((e) => e.type === 'weights_availability'));

console.log(`${open.length} open-weight records with no weights_availability event\n`);

let wrote = 0;
const promised = [], silent = [], unreadable = [];

for (const r of open) {
  const on = canonicalDate(r);
  // The announcement is what we read; documentation describes today, not launch.
  const src = r.sources.find((s) => s.type === 'official_announcement')
    ?? r.sources.find((s) => s.type === 'official_documentation')
    ?? r.sources[0];
  if (!src) { unreadable.push(`${r.id} — no source`); continue; }

  let text = null;
  try { text = await sourceText(src.archived_url ?? src.url, { cache: true }); } catch { /* below */ }
  // sourceText hands back a FAILED symbol, not a falsy value, when it gives up.
  if (typeof text !== 'string' || !text.trim()) { unreadable.push(`${r.id} — ${src.url}`); continue; }

  // Match against the text and quote the MATCHING REGION, not the start of the
  // "sentence" it fell in. Flattened HTML has almost no full stops, so a
  // sentence can be thousands of characters and the evidence printed for review
  // was showing an unrelated opening clause while the match sat far later. If
  // the quote is not the thing that matched, the review is theatre.
  const flatText = text.replace(/\s+/g, ' ');
  const hits = [];
  for (const re of OUT) {
    const m = new RegExp(re.source, re.flags.replace('g', '')).exec(flatText);
    if (!m) continue;
    const window = flatText.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
    if (NOT_A_CLAIM.test(window)) continue;
    hits.push({ match: m[0].trim(), window: window.trim() });
  }
  const waits = sentences(text).filter((s) => LATER.some((re) => re.test(s)));

  if (!hits.length) {
    (waits.length ? promised : silent).push(
      `${r.id.padEnd(22)} ${waits[0]?.slice(0, 96) ?? '(no statement about weights)'}`);
    continue;
  }
  // A page that says both is not evidence of either; a human reads that one.
  if (waits.length) {
    promised.push(`${r.id.padEnd(22)} says both — ${hits[0].match.slice(0, 66)} / ${waits[0].slice(0, 56)}`);
    continue;
  }

  console.log(`  ✓ ${r.id.padEnd(22)} ${on}`);
  console.log(`      matched: "${hits[0].match.slice(0, 104)}"`);
  wrote++;
  if (WRITE) {
    (r.events ??= []).push({ type: 'weights_availability', date: on, sources: [src.id] });
    r.events.sort((a, b) => a.date.localeCompare(b.date));
  }
}

const block = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n${title} (${rows.length}):`);
  for (const x of rows.slice(0, 14)) console.log(`  ${x}`);
  if (rows.length > 14) console.log(`  … and ${rows.length - 14} more`);
};
block('PROMISED, NOT SHIPPED — needs the follow-up post, not this announcement', promised);
block('SILENT — the announcement never mentions weights', silent);
block('UNREADABLE — source did not fetch', unreadable);

console.log(`\n${wrote} record${wrote === 1 ? '' : 's'} with a datable weights release`);
if (WRITE && wrote) { saveDataset(data); console.log('wrote data/llm-releases.json'); }
else if (!WRITE) console.log('dry run — pass --write to record');
