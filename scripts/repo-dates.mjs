#!/usr/bin/env node
/**
 * Corroborates release dates against GitHub releases and arXiv submissions.
 *
 *   node scripts/repo-dates.mjs           report what they say
 *   node scripts/repo-dates.mjs --write   record the ones that agree
 *
 * WHAT THIS IS NOT ALLOWED TO DO
 *
 * An arXiv v1 submission date is when a PAPER was posted. A GitHub tag date is
 * when a REPOSITORY published a version. Neither is a model's release date, and
 * writing one into that field would repeat the mistake Hugging Face's createdAt
 * nearly caused — a plausible number from an authoritative place, describing a
 * different event, wrong by anything from a day to two months.
 *
 * So nothing here sets a date. It asks a narrower question: does this primary
 * source STATE the date the record already asserts? If yes, that is the
 * citation the record was missing, and release_date becomes traced. If it
 * states something else, that disagreement is reported and left in the open
 * (R4) rather than quietly resolved in either direction.
 *
 * The dataset's own history is why. OPT-175B is recorded at 2022-05-05 while
 * arXiv 2205.01068 was submitted 2022-05-02. One of those is the announcement
 * and one is the paper; a script cannot tell which the record means, and
 * guessing would launder a mismatch into a citation.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import { canonicalDate } from '../lib/record.mjs';

const WRITE = process.argv.includes('--write');
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'user-agent': 'llm-world repo-dates (+https://github.com/mayoorrnikam/llm-world)' };

const json = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: UA });
    return res.ok ? await res.json() : null;
  } catch { return null; }
};

/** Every dated GitHub release/tag on the repo, newest first. */
async function githubDates(owner, repo) {
  const rels = await json(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`);
  const out = [];
  for (const r of rels ?? []) {
    if (r.published_at) out.push({ date: r.published_at.slice(0, 10), what: `release ${r.tag_name}` });
  }
  return out;
}

/** arXiv v1 submission, from the Atom API. */
async function arxivDate(id) {
  try {
    const res = await fetch(`http://export.arxiv.org/api/query?id_list=${id}`, {
      signal: AbortSignal.timeout(25000), headers: UA,
    });
    if (!res.ok) return null;
    const m = /<published>([^<]+)<\/published>/.exec(await res.text());
    return m ? { date: m[1].slice(0, 10), what: `arXiv ${id} v1` } : null;
  } catch { return null; }
}

const untraced = data.releases.filter((r) => {
  const v = canonicalDate(r);
  return v && !(r.evidence?.release_date ?? []).some((e) => String(e.value) === String(v));
});

console.log(`${untraced.length} records with an untraced release date\n`);

let agreed = 0;
const disagree = [], nothing = [];

for (const [i, r] of untraced.entries()) {
  if (i) await sleep(700);
  const on = canonicalDate(r);
  const candidates = [];

  for (const s of r.sources) {
    if (s.authority !== 'primary') continue;
    const gh = /github\.com\/([\w.-]+)\/([\w.-]+)/.exec(s.url);
    if (gh) for (const d of await githubDates(gh[1], gh[2].replace(/\.git$/, ''))) candidates.push({ ...d, sid: s.id });
    const ax = /arxiv\.org\/(?:abs|pdf)\/([\d.]+)/.exec(s.url);
    if (ax) { const d = await arxivDate(ax[1]); if (d) candidates.push({ ...d, sid: s.id }); }
  }

  if (!candidates.length) { nothing.push(r.id); continue; }

  const match = candidates.find((c) => c.date === on);
  if (match) {
    console.log(`  ✓ ${r.id.padEnd(22)} ${on}  ${match.what}`);
    agreed++;
    if (WRITE) {
      ((r.evidence ??= {}).release_date ??= []).push({ value: on, sources: [match.sid] });
    }
    continue;
  }
  const near = candidates.sort((a, b) =>
    Math.abs(Date.parse(a.date) - Date.parse(on)) - Math.abs(Date.parse(b.date) - Date.parse(on)))[0];
  const days = Math.round((Date.parse(near.date) - Date.parse(on)) / 86400000);
  disagree.push(`${r.id.padEnd(22)} record ${on}  ${near.what} ${near.date}  (${days > 0 ? '+' : ''}${days}d)`);
}

if (disagree.length) {
  console.log(`\nDISAGREE — the repo dates a different event, not this record's release (${disagree.length}):`);
  for (const x of disagree.slice(0, 18)) console.log(`  ${x}`);
  if (disagree.length > 18) console.log(`  … and ${disagree.length - 18} more`);
  console.log('  Left alone. Which event a record means is a judgement, not a diff.');
}
console.log(`\nno github or arxiv primary source: ${nothing.length}`);
console.log(`\n${agreed} release date${agreed === 1 ? '' : 's'} corroborated`);
if (WRITE && agreed) { saveDataset(data); console.log('wrote data/llm-releases.json'); }
else if (!WRITE) console.log('dry run — pass --write to record');
