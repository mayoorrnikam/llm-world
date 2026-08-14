#!/usr/bin/env node
/**
 * Watches labs' own news feeds for anything release-shaped.
 *
 *   node scripts/check-feeds.mjs             recent items worth a look
 *   node scripts/check-feeds.mjs --days=30   widen the window
 *   node scripts/check-feeds.mjs --all       every item, not just matches
 *
 * The second discovery channel, next to check-freshness.mjs, and it answers a
 * different question. Hugging Face tells us a lab published weights; a feed
 * tells us a lab said something, which is the only signal available for the
 * labs that never publish weights at all — OpenAI, Anthropic, Google's Gemini
 * line, xAI. check-freshness is structurally blind to those.
 *
 * A feed item IS a primary source: it is the lab's own newsroom, at a stable
 * URL, archivable and machine-readable — everything a social post is not.
 *
 * WHAT THIS DOES NOT DO: add anything. It reports candidates for a human to
 * verify against the announcement itself, exactly like the Hugging Face scan.
 *
 * Every URL below was probed before being listed. Paths that returned HTML at
 * a .xml address — a single-page app serving its shell — are not feeds and were
 * dropped, which is why several large labs are absent rather than guessed at.
 */

import { readFileSync } from 'node:fs';

const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 21);
const ALL = process.argv.includes('--all');

/** Verified 2026-08-10: each returns real <item>/<entry> elements. */
const FEEDS = [
  ['OpenAI', 'https://openai.com/news/rss.xml'],
  // Two feeds, because Google splits its own announcements and the model
  // releases are NOT in the DeepMind one. "Introducing Gemini 3.7 Flash"
  // published to /innovation-and-ai/models-and-research/gemini-models/, which
  // surfaces in the Gemini product feed; the DeepMind feed that day carried a
  // roundtable piece instead. Gemini 3.6 Flash went the same way. Watching only
  // DeepMind means watching the section Gemini releases do not appear in.
  ['Google DeepMind', 'https://blog.google/products/gemini/rss/'],
  ['Google DeepMind', 'https://blog.google/technology/google-deepmind/rss/'],
  ['Mistral AI', 'https://mistral.ai/rss.xml'],
  ['Alibaba Qwen', 'https://qwenlm.github.io/blog/index.xml'],
  ['NVIDIA', 'https://developer.nvidia.com/blog/feed'],
  ['Microsoft Azure', 'https://azure.microsoft.com/en-us/blog/feed/'],
  ['Microsoft Research', 'https://www.microsoft.com/en-us/research/feed/'],
  ['Apple ML', 'https://machinelearning.apple.com/rss.xml'],
  ['Meta Engineering', 'https://engineering.fb.com/feed/'],
  ['Together AI', 'https://www.together.ai/blog/rss.xml'],
  ['Hugging Face', 'https://huggingface.co/blog/feed.xml'],
];

/**
 * Labs with no feed at all. Listed so a quiet report cannot be mistaken for a
 * quiet week — the same honesty check-freshness prints about closed labs.
 */
const NO_FEED = [
  'Anthropic', 'xAI', 'DeepSeek', 'Cohere', 'Zhipu / Z.ai', 'Moonshot AI',
  'AI21 Labs', 'Allen Institute (Ai2)', 'ByteDance Seed', 'Tencent',
  'IBM Research', 'TII (Falcon)', 'Upstage', 'LG AI Research', 'Baidu',
  'MiniMax', 'StepFun', 'Arcee AI', 'Sarvam AI',
];

/** Titles that read like a model shipping, rather than a hiring post. */
const RELEASE = /\b(introduc|announc|launch|releas|unveil|present|meet|now available|ship)/i;
const MODELISH = /\b(model|llm|gpt|claude|gemini|llama|qwen|mistral|phi|grok|nemotron|granite|olmo|command|jamba|solar|exaone|hunyuan|seed|minimax|step|kimi|glm|deepseek)\b/i;

const strip = (s) => String(s ?? '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#8217;|&rsquo;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** RSS <item> and Atom <entry>, without a parser. */
function items(xml) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)) {
    const block = m[0];
    const title = strip((/<title[^>]*>([\s\S]*?)<\/title>/.exec(block) ?? [])[1]);
    const link = strip((/<link[^>]*href="([^"]+)"/.exec(block) ?? [])[1])
      || strip((/<link[^>]*>([\s\S]*?)<\/link>/.exec(block) ?? [])[1]);
    const date = strip((/<(?:pubDate|published|updated)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated)>/.exec(block) ?? [])[1]);
    if (title) out.push({ title, link, date: Date.parse(date) || 0 });
  }
  return out;
}

/**
 * AI newsletters, read for ONE job: finding labs this project has never heard of.
 *
 * They are never sources. A newsletter is third-hand — it summarises reporting
 * that summarises the lab's announcement — and this dataset already refuses to
 * mark a date verified on second-hand reporting alone. They are also edited,
 * copyrighted works, so a headline and its link is the whole of what is used
 * here; nothing is stored or reproduced.
 *
 * Nor are they much use as a general discovery channel any more. scan-labs.mjs
 * reads sixteen labs' own announcement pages directly, so a newsletter reports
 * the same release later, with less precision and an editor's selection on top.
 *
 * What they cover that nothing else here can is the blind spot every other
 * channel shares. check-freshness has a whitelist of Hugging Face orgs,
 * check-feeds has a list of labs, scan-labs derives its patterns from ids
 * already tracked — all three are keyed on what this dataset already knows, so
 * NONE of them can surface a lab that is not in it. Ai2, MiniMax and Moonshot
 * each had to be noticed by a person first.
 *
 * So items mentioning a lab already tracked are dropped, and what is left is
 * the interesting half: a release from somebody new.
 */
const NEWSLETTERS = [
  ['Import AI', 'https://importai.substack.com/feed'],
  ['Interconnects', 'https://www.interconnects.ai/feed'],
  ['Ahead of AI', 'https://magazine.sebastianraschka.com/feed'],
  ['TLDR AI', 'https://tldr.tech/api/rss/ai'],
];

/** Labs already tracked, so an item about one of them is not news here. */
const KNOWN = (() => {
  const d = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
  const names = new Set();
  for (const r of d.releases) {
    names.add(r.company.toLowerCase());
    names.add(String(r.family).toLowerCase());
    const stem = /^[a-z]+/.exec(r.id)?.[0];
    if (stem && stem.length > 2) names.add(stem);
  }
  return [...names].filter((n) => n.length > 2);
})();

const mentionsKnown = (title) => {
  const t = title.toLowerCase();
  return KNOWN.some((n) => t.includes(n));
};

const cutoff = Date.now() - DAYS * 86400000;
const found = [];
const failed = [];

for (const [lab, url] of FEEDS) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world feed-check)' },
    });
    if (!res.ok) { failed.push(`${lab} — HTTP ${res.status}`); continue; }
    const recent = items(await res.text())
      .filter((i) => i.date && i.date >= cutoff)
      .filter((i) => ALL || (RELEASE.test(i.title) && MODELISH.test(i.title)));
    for (const i of recent) found.push({ lab, ...i });
  } catch (e) {
    // A feed we could not read is unknown, never "nothing happened".
    failed.push(`${lab} — ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  await new Promise((r) => setTimeout(r, 200));
}

/* --------------------------------------------- newsletters: unknown labs */

const novel = [];
for (const [name, url] of NEWSLETTERS) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world feed-check)' },
    });
    if (!res.ok) { failed.push(`${name} (newsletter) — HTTP ${res.status}`); continue; }
    const recent = items(await res.text())
      .filter((i) => i.date && i.date >= cutoff)
      .filter((i) => RELEASE.test(i.title) && MODELISH.test(i.title))
      .filter((i) => !mentionsKnown(i.title));
    for (const i of recent) novel.push({ lab: name, ...i });
  } catch (e) {
    failed.push(`${name} (newsletter) — ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
  }
  await new Promise((r) => setTimeout(r, 200));
}

found.sort((a, b) => b.date - a.date);
novel.sort((a, b) => b.date - a.date);

console.log(`## Lab newsroom feeds — last ${DAYS} days\n`);
if (!found.length) {
  console.log('Nothing release-shaped.\n');
} else {
  console.log(`${found.length} item${found.length === 1 ? '' : 's'} worth a look. `
    + `Candidates only — verify against the announcement before adding.\n`);
  for (const f of found) {
    console.log(`- **${f.lab}** — [${f.title}](${f.link})`);
    console.log(`  ${new Date(f.date).toISOString().slice(0, 10)}`);
  }
  console.log('');
}

console.log(`## Possibly a lab we do not track\n`);
if (!novel.length) {
  console.log('Nothing from the newsletters that is not about a lab already tracked.\n');
} else {
  console.log(`${novel.length} item${novel.length === 1 ? '' : 's'} naming no lab in this dataset. `
    + `Newsletters are a discovery channel only — never a source — so each still needs `
    + `the lab's own announcement before it becomes a record.\n`);
  for (const n of novel) {
    console.log(`- **${n.lab}** — [${n.title}](${n.link})`);
    console.log(`  ${new Date(n.date).toISOString().slice(0, 10)}`);
  }
  console.log('');
}

if (failed.length) {
  console.log(`## Could not read (unknown, not empty)\n`);
  for (const f of failed) console.log(`- ${f}`);
  console.log('');
}

console.log(`## No feed published\n`);
console.log(`These labs have no usable feed, so this scan cannot see them at all:\n`);
console.log(NO_FEED.join(' · '));
console.log(`\nAnthropic and xAI matter most there — they publish no weights either, `
  + `so neither this nor the Hugging Face scan can see them. Check by hand.`);
