#!/usr/bin/env node
/**
 * Re-cuts one field's history for the places a post actually goes.
 *
 *   node scripts/post.mjs --company="Anthropic" --field=context_window
 *   node scripts/post.mjs --company="OpenAI" --field=context_window --out=posts/
 *
 * The history itself is computed in lib/history.mjs, which the build also reads,
 * so a page and a thread can never disagree about when a value changed.
 *
 * WHAT THIS TOOL WILL NOT DO
 *
 * 1. It does not post anything. Hacker News and Reddit both penalise identical
 *    cross-posted text, and every subreddit has its own rules. The output is
 *    meant to be read, edited and pasted by a person who knows the room.
 *
 * 2. It does not write the take. A fully machine-written newsletter reads as
 *    one, gets filtered as one, and halves its own open rate. What is generated
 *    here is the research; the judgement on top of it is a person's job.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  fieldHistory, historyTable, historySources, historyCaveats,
  openWeightsByYear, openWeightsTable, openWeightsFrontier, openWeightsFrontierTable,
  frontierUnsourced, frontierLevel, LEVEL_TOLERANCE, short, pretty,
} from '../lib/history.mjs';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const COMPANY = arg('company', 'Anthropic');
const FIELD = arg('field', 'context_window');
const OUT = arg('out');
const SITE = (process.env.SITE_URL ?? 'https://mayoorrnikam.github.io/llm-world').replace(/\/+$/, '');

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/* ------------------------------------------------------- open-weights variant
 *
 *   node scripts/post.mjs --open-weights
 *
 * Both tables, always. The release count on its own reads as a scoreboard and
 * points the opposite way to the frontier — the first draft of this post was
 * headlined "open weights lost badly in 2026" on the strength of the count
 * alone, which the frontier table flatly contradicts. Shipping one without the
 * other is how a true number becomes a false post.
 */
if (process.argv.includes('--open-weights')) {
  const ow = openWeightsByYear(data.releases);
  const fr = openWeightsFrontier(data.releases);
  const unsourced = frontierUnsourced(fr);
  const level = frontierLevel(fr);
  const last = fr.at(-1);
  const postUrl = `${SITE}/posts/open-weights-by-year/`;

  const headline = level.some((r) => r.year === last.year)
    ? 'Open weights ship less often, and match the frontier anyway'
    : `Open weights are ${Math.round((ow.rows.at(-1).share) * 100)}% of releases tracked in ${last.year}`;

  const canonical = `# ${headline}

Across the ${ow.tracked} releases tracked here, open weights are ${
  Math.round((ow.totals.open / ow.tracked) * 100)}% of the total — but the yearly
share swings hard, and the count disagrees with the frontier.

## How many releases, by licence

${openWeightsTable(ow)}

## The largest context window on each side

${openWeightsFrontierTable(fr)}

## What this does not claim

- **Release count is not capability.** The first table counts how often a model
  shipped, not how good it was.
- These are releases this dataset tracks, not every release that happened.
- Context window is one axis, and the only capability recorded on both sides here.${
  level.length ? ` Open weights led it, or came within ${LEVEL_TOLERANCE * 100}%, in ${level.map((r) => r.year).join(', ')}.` : ''}${
  unsourced.length
    ? `\n- Marked ⚠︎: ${unsourced.map((u) => `${u.model} (${u.year})`).join(', ')} — in the
  dataset, but not yet traced to a primary source. Any comparison resting on those
  is provisional.`
    : ''}

---

Data: [LLM World](${SITE}), CC BY 4.0.
`;

  const tweets = [
    `${headline}.\n\nIn ${last.year}: ${ow.rows.at(-1).open} open-weights releases tracked vs ${
      ow.rows.at(-1).closed} proprietary.\n\nBut release count isn't capability. 🧵`,
    `Largest context window, by licence:\n\n${fr.slice(-3).map((r) =>
      `${r.year}  open ${short(r.open?.value ?? 0)} · closed ${short(r.closed?.value ?? 0)}`).join('\n')}\n\nThe count and the frontier point opposite ways.`,
    unsourced.length
      ? `Caveat I won't bury: ${unsourced.map((u) => u.model).join(', ')} ${
        unsourced.length === 1 ? 'is' : 'are'} in the dataset without a traced source for that number yet.\n\nSo treat the newest comparison as provisional.`
      : 'Every value above traces to the lab that published it.',
    `Full tables, every source:\n\n${postUrl}\n\nCC BY 4.0 — take the data.`,
  ];

  const out = {
    'canonical.md': canonical,
    'hacker-news.txt': `TITLE (max 80 chars — currently ${headline.length}):\n${headline}\n\nURL:\n${postUrl}\n\nFIRST COMMENT (post this yourself):\nI maintain the dataset. The thing that surprised me: counting releases and\nchecking the frontier give opposite answers. Open weights are a shrinking share\nof releases tracked and not a shrinking share of the largest context window.\n\nCaveats are on the page, including which values aren't sourced yet.`,
    'reddit.md': `TITLE:\n${headline}\n\nBODY:\n${
      canonical.split('\n').slice(1).join('\n').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()}`,
    'x-thread.txt': tweets.map((t, i) =>
      `--- tweet ${i + 1}/${tweets.length} (${t.length}/280)${t.length > 280 ? '  ⚠︎ TOO LONG' : ''}\n${t}`).join('\n\n'),
  };

  if (OUT) {
    const dir = join(OUT, 'open-weights-by-year');
    mkdirSync(dir, { recursive: true });
    for (const [n, b] of Object.entries(out)) writeFileSync(join(dir, n), b);
    console.log(`Wrote ${Object.keys(out).length} files to ${dir}/`);
  } else {
    for (const [n, b] of Object.entries(out)) {
      console.log(`\n${'='.repeat(72)}\n${n}\n${'='.repeat(72)}\n${b}`);
    }
  }
  process.exit(0);
}

const h = fieldHistory(data.releases, COMPANY, FIELD);

if (h.insufficient) {
  console.error(
    `${COMPANY}: ${h.records.length} records, ${h.known.length} with a recorded ${h.label}.\n`
      + 'A history needs two points. This is a real gap, not a bug — try another field.',
  );
  process.exit(1);
}

const slug = `${COMPANY.toLowerCase().replace(/\s+/g, '-')}-${FIELD}`;
const postUrl = `${SITE}/posts/${slug}/`;
const times = (n) => (n % 1 ? n.toFixed(1) : String(n));
const caveats = historyCaveats(h);

// ------------------------------------------------------------------ the pages

const canonical = `# ${h.headline}

${COMPANY} has shipped ${h.records.length} models this dataset tracks. Their ${h.label} went from
${short(h.first.value)} (${h.first.model}, ${pretty(h.first.date)}) to ${short(h.last.value)}
(${h.last.model}, ${pretty(h.last.date)}) over ${h.months} months.

It did not climb steadily. It moved ${h.changes.length} time${h.changes.length === 1 ? '' : 's'}.${
  h.notable
    ? ` The longest flat stretch ran ${h.span(h.notable)} months
across ${h.notable.length} consecutive releases, all at exactly ${short(h.notable[0].value)}:
${h.notable.map((x) => x.model).join(', ')}.`
    : ''
}

${historyTable(h, (x) => `${SITE}/models/${x.id}/`)}

## Every change, and the document behind it

${historySources(h)}
${caveats.length ? `\n## What this does not claim\n\n${caveats.map((c) => `- ${c}`).join('\n')}\n` : ''}
---

Data: [LLM World](${SITE}), CC BY 4.0. Every value above traces to the lab's own
announcement, paper or model card.
`;

// Hacker News takes a title and a link. Promotional text in the submission body
// reads as a pitch; context belongs in a first comment, from the author, plainly.
const hn = `TITLE (max 80 chars — currently ${h.headline.length}):
${h.headline}

URL:
${postUrl}

FIRST COMMENT (post this yourself, right after submitting):
I maintain the dataset behind this. Every ${h.label} value traces to the lab's own
announcement or model card${
  h.gaps.length
    ? `, and the ${h.gaps.length} releases where I could not find a figure are marked as gaps rather than guessed`
    : ''
}.

The bit I did not expect: ${
  h.notable
    ? `${h.notable.length} consecutive releases at exactly ${short(h.notable[0].value)}, over ${h.span(h.notable)} months.`
    : `it only changed ${h.changes.length} times in ${h.months} months.`
}

Happy to be corrected on any number — the sources are all linked.`;

// Reddit punishes link-only posts. The body goes in the post; links come out.
const reddit = `TITLE:
${h.headline} — every value sourced

BODY:
${canonical.split('\n').slice(1).join('\n').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()}

(Suggested: r/LocalLLaMA, r/MachineLearning [check rules — many ban self-promotion],
r/singularity. Read each sidebar first. Do not post the same text to more than one
in a day.)`;

const tweets = [
  `${h.headline}.\n\n${short(h.first.value)} → ${short(h.last.value)} in ${h.months} months, but it only moved ${h.changes.length} times.\n\nEvery value traced to ${COMPANY}'s own docs. 🧵`,
  ...(h.notable
    ? [`${h.notable.length} releases in a row shipped at exactly ${short(h.notable[0].value)}:\n\n${
      h.notable.map((x) => x.model).join('\n')}\n\n${h.span(h.notable)} months, no change.`]
    : []),
  ...h.changes.map((c) =>
    `${pretty(c.to.date)} — ${c.to.model}\n${short(c.from.value)} → ${short(c.to.value)} (${times(c.factor)}×)\n\n${c.to.sources[0]?.url ?? ''}`),
  h.gaps.length
    ? `Full table, every source, and the ${h.gaps.length} gaps I won't guess at:\n\n${postUrl}\n\nCC BY 4.0 — take the data.`
    : `Full table with every source:\n\n${postUrl}\n\nCC BY 4.0 — take the data.`,
];

const x = tweets
  .map((t, i) => `--- tweet ${i + 1}/${tweets.length} (${t.length}/280)${t.length > 280 ? '  ⚠︎ TOO LONG' : ''}\n${t}`)
  .join('\n\n');

// Medium duplicates your page, so it needs the canonical link or it competes
// with you in search for your own writing.
const medium = `${canonical}

---

BEFORE PUBLISHING ON MEDIUM:
Settings → Advanced settings → "Canonical link" → ${postUrl}
Without it, Medium outranks your own page for your own words.`;

// ------------------------------------------------------------------- delivery

const files = {
  'canonical.md': canonical,
  'hacker-news.txt': hn,
  'reddit.md': reddit,
  'x-thread.txt': x,
  'medium.md': medium,
};

if (OUT) {
  const dir = join(OUT, slug);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  console.log(`Wrote ${Object.keys(files).length} files to ${dir}/`);
} else {
  for (const [name, body] of Object.entries(files)) {
    console.log(`\n${'='.repeat(72)}\n${name}\n${'='.repeat(72)}\n${body}`);
  }
}
