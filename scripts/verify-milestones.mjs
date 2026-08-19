#!/usr/bin/env node
/**
 * Checks that each milestone's date is actually stated by the source it cites.
 *
 *   node scripts/verify-milestones.mjs            check every milestone
 *   node scripts/verify-milestones.mjs --drafts   only the unpublished ones
 *   node scripts/verify-milestones.mjs --strict   exit 1 if any fails
 *
 * WHY MILESTONES NEED THEIR OWN CHECK
 *
 * Model records must cite a primary source; milestones may not. A harness
 * launch is often dated only by Import AI, The Batch or a Hacker News thread,
 * and that is accepted here — recorded as `partially_verified`, never
 * `verified`, with a reason saying what is missing.
 *
 * Relaxing WHO may state a fact makes it more important, not less, to check
 * that the fact was stated at all. attribute-facts.mjs does this for model
 * records by reading archived primary sources; nothing did it for milestones,
 * so a date could be typed in and cite a page that never mentions it. That is
 * the failure mode this project keeps finding: four prices once cited Wikipedia
 * articles carrying no price, and two "conflicts" turned out to be dates from a
 * Related-stories sidebar.
 *
 * WHAT IT DOES NOT DO
 *
 * It never changes a date and never publishes a draft. It reads each source and
 * answers one question — does this page state this date, in any of the forms
 * lib/dates.mjs knows? A page that cannot be fetched is reported as unreadable,
 * never as disagreement: "we could not look" and "the page says otherwise" are
 * different answers and only one of them is evidence.
 */

import { readFileSync } from 'node:fs';
import { sourceText } from '../lib/source-text.mjs';
import { dateForms } from '../lib/dates.mjs';

const DRAFTS_ONLY = process.argv.includes('--drafts');
const STRICT = process.argv.includes('--strict');

let all = [];
try {
  all = JSON.parse(readFileSync('data/milestones.json', 'utf8')).milestones ?? [];
} catch (e) {
  console.error(`cannot read data/milestones.json — ${e.message}`);
  process.exit(2);
}

const list = DRAFTS_ONLY ? all.filter((m) => m.draft === true) : all;
if (!list.length) {
  console.log(DRAFTS_ONLY ? 'no milestone drafts to verify.' : 'no milestones.');
  process.exit(0);
}

console.log(`${list.length} milestone${list.length === 1 ? '' : 's'} to check\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let confirmed = 0, absent = 0, unread = 0;
const problems = [];

for (const [i, m] of list.entries()) {
  if (i) await sleep(1200);
  const forms = dateForms(m.date);
  let hit = null;
  let readAny = false;

  for (const s of m.sources ?? []) {
    // The archived copy first where one exists: it is what a reader checking
    // this in a year will actually be able to open.
    let t = null;
    try { t = await sourceText(s.archived_url ?? s.url, { cache: true }); } catch { /* below */ }
    // sourceText signals failure with a Symbol, which is truthy — a string
    // check is the only correct guard (this has bitten three other scripts).
    if (typeof t !== 'string' || !t.trim()) continue;
    readAny = true;
    // Case-insensitive on purpose. Newsrooms set datelines in caps —
    // SiliconANGLE prints "UPDATED 19:59 EDT / MARCH 12 2024" — and a
    // case-sensitive compare reported that page as not stating a date it states
    // plainly. Lowercasing both sides is cheaper and safer than doubling every
    // entry in dateForms, which every other caller shares.
    const flat = t.replace(/\s+/g, ' ').toLowerCase();
    const f = forms.find((x) => flat.includes(x.toLowerCase()));
    if (f) { hit = { form: f, src: s }; break; }
  }

  const media = !(m.sources ?? []).some((s) => s.authority === 'primary');
  const tag = `${m.draft ? 'DRAFT ' : ''}${media ? '[media] ' : ''}`;

  if (hit) {
    confirmed++;
    console.log(`  ok      ${tag}${m.date}  ${m.title}`);
    console.log(`            "${hit.form}" on ${hit.src.url.replace(/^https?:\/\//, '').slice(0, 62)}`);
  } else if (!readAny) {
    unread++;
    console.log(`  unread  ${tag}${m.date}  ${m.title} — no source could be fetched`);
    problems.push(`${m.id}: sources unreadable`);
  } else {
    absent++;
    console.log(`  ABSENT  ${tag}${m.date}  ${m.title} — read the source(s); none states this date`);
    problems.push(`${m.id}: date not found on any readable source`);
  }

  // A milestone claiming `verified` without a primary source is a schema error
  // the validator already catches; this catches the softer version — claiming
  // verified while the only readable evidence is secondary.
  if (m.provenance?.status === 'verified' && media) {
    problems.push(`${m.id}: marked verified with no primary source`);
  }
}

console.log(`\n${confirmed} confirmed · ${absent} not stated by any source · ${unread} unreadable`);
if (problems.length) {
  console.log(`\nNeeds a person:`);
  for (const p of problems) console.log(`  ${p}`);
}
if (STRICT && (absent || problems.length)) process.exit(1);
