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

const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 21);
const ALL = process.argv.includes('--all');

/** Verified 2026-08-10: each returns real <item>/<entry> elements. */
const FEEDS = [
  ['OpenAI', 'https://openai.com/news/rss.xml'],
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

found.sort((a, b) => b.date - a.date);

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
