#!/usr/bin/env node
/**
 * What each lab has dated since we last looked, read from the lab's own pages.
 *
 *   node scripts/sweep-changelogs.mjs              last 30 days, every source
 *   node scripts/sweep-changelogs.mjs --days=14    a shorter window
 *   node scripts/sweep-changelogs.mjs --lab=OpenAI one lab
 *   node scripts/sweep-changelogs.mjs --json       machine-readable
 *
 * WHY THIS EXISTS
 *
 * Almost every release added in September 2026 was found the same way: open
 * each lab's dated changelog, read the entries newer than our newest record,
 * and check each against the dataset. Opus 5.5 from Anthropic's API release
 * notes, GPT-6 Sol and Luna from OpenAI's API changelog, DeepSeek-V4.1-Flash
 * from DeepSeek's change log, the MiMo line from Xiaomi's model updates, Hy4
 * from Tencent's newsroom. That sweep was rewritten by hand every session and
 * never committed. This is it, committed.
 *
 * The other scanners answer different questions. scan-labs lists the model ids
 * a docs page serves; check-feeds reads RSS; hf-new-orgs finds labs we do not
 * track. None of them asks "what did this lab DATE since last time", and a
 * dated entry is the one thing that also hands you the release date.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not decide anything and writes nothing. Changelogs mix model launches
 * with API features, deprecations and pricing, so every entry is printed with a
 * hint — whether a record already covers it — and a person (or an agent) reads
 * the list. A candidate still needs the usual record: the lab's own statement,
 * the date it gives, an archived snapshot.
 *
 * It does not cover every lab. Five that matter publish nothing a plain fetch
 * can date — ByteDance, Qwen, Moonshot, MiniMax and Microsoft serve client-
 * rendered or undated pages — and openai.com and x.ai newsrooms refuse bots.
 * Those are listed at the end of every run as the part that still needs a web
 * search or a browser, so a quiet sweep is never mistaken for a quiet week.
 */

import { readFileSync } from 'node:fs';
import { sourceText } from '../lib/source-text.mjs';

if (process.argv.includes('--limit=0')) process.exit(0);

const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1]) || 30;
const ONLY = process.argv.find((a) => a.startsWith('--lab='))?.split('=')[1];
const JSON_OUT = process.argv.includes('--json');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const LONG = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const SHORT = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}${d ? `-${String(d).padStart(2, '0')}` : ''}`;
const monthIndex = (name) => MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3))) + 1;

/** "September 22, 2026" | "Sep 22, 2026" | "2026-09-22" → "2026-09-22". */
function toIso(s) {
  let m = /^(20\d\d)-(\d\d)-(\d\d)$/.exec(s);
  if (m) return s;
  m = new RegExp(`^(${LONG}|${SHORT})\\.? (\\d{1,2}),? (20\\d\\d)$`).exec(s);
  return m ? iso(m[3], monthIndex(m[1]), m[2]) : null;
}

/**
 * Where each lab dates its own releases.
 *
 * `order` says which side of the date the entry's text sits on. A changelog
 * prints the date and then what happened; a news index prints the headline
 * and then the date. Reading the wrong side attaches each date to the NEXT
 * entry's text, which is a silent off-by-one in exactly the field that
 * matters.
 *
 * `keep` narrows a general newsroom to what could be a model.
 */
const SOURCES = [
  { lab: 'Anthropic', company: 'Anthropic', url: 'https://platform.claude.com/docs/en/release-notes/api', dates: 'long', order: 'after' },
  { lab: 'Google', company: 'Google DeepMind', url: 'https://ai.google.dev/gemini-api/docs/changelog', dates: 'long', order: 'after' },
  { lab: 'OpenAI', company: 'OpenAI', url: 'https://developers.openai.com/api/docs/changelog', dates: 'openai', order: 'after' },
  { lab: 'DeepSeek', company: 'DeepSeek', url: 'https://api-docs.deepseek.com/updates', dates: 'iso', order: 'after' },
  { lab: 'Zhipu', company: 'Zhipu AI', url: 'https://docs.z.ai/release-notes', dates: 'iso', order: 'after' },
  { lab: 'Xiaomi', company: 'Xiaomi', url: 'https://mimo.mi.com/docs/en-US/updates/model', dates: 'iso', order: 'after' },
  { lab: 'xAI', company: 'xAI', url: 'https://docs.x.ai/developers/release-notes.md', dates: 'xai-md', order: 'after' },
  { lab: 'Tencent', company: 'Tencent', url: 'https://www.tencent.com/en-us/media/news.html', dates: 'long', order: 'before',
    keep: /\bHy\b|Hy\d|Hunyuan|model|open[- ]sourc|\bAI\b/i },
  { lab: 'Meta', company: 'Meta AI', url: 'https://research.meta.ai/blog/', dates: 'long', order: 'before' },
];

/** Labs this sweep cannot read, said out loud on every run. */
const BLIND = [
  ['ByteDance', 'seed.bytedance.com is client-rendered'],
  ['Qwen', 'qwen.ai/blog is client-rendered; each post is readable, the index is not'],
  ['Moonshot', 'platform.moonshot.ai changelog carries no dates'],
  ['MiniMax', 'its release notes stopped in 2025'],
  ['Microsoft', 'microsoft.ai/news carries no dates'],
  ['OpenAI newsroom', 'openai.com refuses bots — products like ChatGPT Images reach it, not the API changelog'],
  ['xAI newsroom', 'x.ai refuses bots — its release notes date only the month'],
];

/** Every dated entry on a page, as { date, text }. */
function entries(src, text) {
  const out = [];
  const push = (date, from, to) => {
    const body = text.slice(from, to).replace(/\s+/g, ' ').trim().slice(0, 260);
    // A date inside a sentence ("served until September 30, 2026. To get
    // started…") is not an entry heading, and a table of contents repeats each
    // heading with nothing after it. Neither is a release.
    if (body.length < 20 || /^[.,;:)]/.test(body)) return;
    out.push({ date, text: body });
  };

  if (src.dates === 'xai-md') {
    // "## September" sections with "### Title" entries. A month without a year is
    // the current one; xAI adds the year only to past years ("## December 2025").
    const now = new Date().getFullYear();
    let year = now, month = null;
    for (const line of text.split('\n')) {
      const h2 = new RegExp(`^##\\s+(${LONG})(?:\\s+(20\\d\\d))?\\s*$`).exec(line);
      if (h2) { month = monthIndex(h2[1]); year = h2[2] ? Number(h2[2]) : now; continue; }
      const h3 = /^###\s+(.+)$/.exec(line);
      if (h3 && month) out.push({ date: iso(year, month), text: h3[1].trim() });
    }
    return out;
  }

  if (src.dates === 'openai') {
    // "September, 2026" headers, then "Sep 22" entries beneath them.
    const headers = [...text.matchAll(new RegExp(`(${LONG}), (20\\d\\d)`, 'g'))]
      .map((m) => ({ at: m.index, year: Number(m[2]) }));
    const days = [...text.matchAll(new RegExp(`\\b(${SHORT}) (\\d{1,2})\\b(?!,? 20\\d\\d)`, 'g'))];
    days.forEach((m, i) => {
      const h = headers.filter((x) => x.at < m.index).pop();
      if (!h) return;
      push(iso(h.year, monthIndex(m[1]), m[2]), m.index, days[i + 1]?.index ?? m.index + 400);
    });
    return out;
  }

  const re = src.dates === 'iso'
    ? /\b(20\d\d-\d\d-\d\d)\b/g
    : new RegExp(`\\b(${LONG} \\d{1,2},? 20\\d\\d)\\b`, 'g');
  const hits = [...text.matchAll(re)];
  hits.forEach((m, i) => {
    const date = toIso(m[1]);
    if (!date) return;
    // A news index prints the headline BEFORE its date, so the entry is the
    // text since the previous date. Taking a fixed window instead bled each
    // headline into its neighbour's.
    if (src.order === 'before') {
      const prev = hits[i - 1];
      push(date, prev ? prev.index + prev[0].length : Math.max(0, m.index - 220), m.index);
    } else {
      push(date, m.index + m[0].length, hits[i + 1]?.index ?? m.index + 400);
    }
  });
  return out;
}

/* ---------------------------------------------------------- what we hold */

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
/**
 * Two keys per record, matched on word boundaries.
 *
 * Substring matching on flattened names was the first version, and it hid the
 * very thing this script exists to find: "claudesonnet5" is inside
 * "claudesonnet55", so Claude Sonnet 5.5 came back "tracked: Claude Sonnet 5",
 * and Lyria 3.5 as Lyria 3. A version that extends another is a new model.
 */
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').replace(/\.(?!\d)/g, ' ').trim();
const slug = (s) => String(s).toLowerCase().replace(/[._\s]+/g, '-');
const nameKeys = data.releases.map((r) => [words(r.model), r.model]).filter(([k]) => k.length >= 4);
const trackedIds = new Set(data.releases.map((r) => slug(r.id)));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nameRe = new Map(nameKeys.map(([k]) => [k, new RegExp(`(?:^| )${esc(k)}(?= |$)`)]));

/** Records an entry names, by display name. A hint, not a verdict. */
function tracked(text) {
  const t = words(text);
  return [...new Set(nameKeys.filter(([k]) => nameRe.get(k).test(t)).map(([, m]) => m))].slice(0, 3);
}

/**
 * API identifiers the entry prints that no record carries.
 *
 * The strongest signal in a changelog. An entry announcing GPT-6.1 Sol also
 * mentions GPT-6 Astra by name ("at a lower cost than GPT-6 Astra"), so a name
 * match calls it tracked; the identifier it prints, gpt-6.1-sol, is not.
 * Endpoints, beta headers and dated snapshots are not model ids.
 */
function newIds(text) {
  const t = String(text).toLowerCase();
  // Bare ids must carry a digit, or every hyphenated word ("long-running",
  // "service-account") would qualify. An id the lab puts in parentheses after
  // a model's name is trusted without one: "GPT-Rosalind ( gpt-rosalind-research )".
  const bare = (t.match(/\b[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+\b/g) ?? []).filter((id) => /\d/.test(id));
  const quoted = [...t.matchAll(/\(\s*([a-z][a-z0-9]*(?:[-.][a-z0-9]+)+)\s*\)/g)].map((m) => m[1]);
  return [...new Set([...bare, ...quoted])]
    .filter((id) => /[a-z]{2}/.test(id) && id.length >= 6)
    .filter((id) => !/^v\d|beta|\d{4}-\d\d-\d\d|^api\.|\.(?:com|ai|io)$|^ipv/.test(id))
    // A dated snapshot of a tracked model is that model: claude-sonnet-4-5-20250929.
    .map((id) => slug(id).replace(/-(?:20\d{6}|\d{4})$/, ''))
    .filter((id) => !trackedIds.has(id))
    // "mimo-v2.6" from "MiMo-V2.6 Series" is a prefix of tracked ids, not a model.
    .filter((id) => ![...trackedIds].some((k) => k.startsWith(`${id}-`)));
}

/** A headline that announces something and names nothing we hold. */
const ANNOUNCES = /\b(?:introduc\w*|launch\w*|releas\w*|now available|generally available)\b/i;

/* ------------------------------------------------------------------- run */

const today = new Date().toISOString().slice(0, 10);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
const results = [];
const unreadable = [];

for (const src of SOURCES) {
  if (ONLY && src.lab.toLowerCase() !== ONLY.toLowerCase()) continue;
  const text = src.dates === 'xai-md'
    ? await fetch(src.url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world source-reader)' } })
      .then((r) => (r.ok ? r.text() : null)).catch(() => null)
    : await sourceText(src.url, { cache: false });
  if (typeof text !== 'string' || !text.length) { unreadable.push(src); continue; }

  const seen = new Set();
  const fresh = entries(src, text)
    // Changelogs announce FUTURE dates — deprecations, price changes — and a
    // month-precision entry compares on its first day.
    .filter((e) => e.date <= today && (e.date.length === 7 ? `${e.date}-31` : e.date) >= since)
    .filter((e) => !src.keep || src.keep.test(e.text))
    .filter((e) => { const k = `${e.date}|${e.text.slice(0, 80)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((e) => ({ ...e, tracked: tracked(e.text), newIds: newIds(e.text) }));
  results.push({ lab: src.lab, company: src.company, url: src.url, entries: fresh });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ since, today, results, unreadable: unreadable.map((s) => s.lab), blind: BLIND }, null, 2));
  process.exit(0);
}

console.log(`## Lab changelogs, ${since} to ${today}\n`);
let fresh = 0;
for (const r of results) {
  if (!r.entries.length) { console.log(`**${r.lab}** — nothing dated in the window\n`); continue; }
  console.log(`**${r.lab}** — ${r.url}`);
  for (const e of r.entries.sort((a, b) => b.date.localeCompare(a.date))) {
    // An untracked API id outranks any name match: the entry is about that id.
    const looksNew = !e.newIds.length && !e.tracked.length && ANNOUNCES.test(e.text);
    const hint = e.newIds.length ? `NEW ID? ${e.newIds.join(', ')}`
      : e.tracked.length ? `tracked: ${e.tracked.join(', ')}`
        : looksNew ? 'NEW? announces something, names no tracked model' : 'no model named';
    if (e.newIds.length || looksNew) fresh++;
    console.log(`- ${e.date}  [${hint}]  ${e.text}`);
  }
  console.log();
}

if (unreadable.length) {
  console.log('### Did not answer\n');
  for (const s of unreadable) console.log(`- **${s.lab}** — ${s.url}`);
  console.log('\nA source that cannot be read is not a quiet week.\n');
}

console.log('### Not covered by this sweep — check by web search\n');
for (const [lab, why] of BLIND) console.log(`- **${lab}** — ${why}`);
console.log(`\n_${fresh} entr${fresh === 1 ? 'y looks' : 'ies look'} new. Changelogs mix launches with `
  + 'API features, so read each one: a candidate still needs the lab\'s own statement, its date, and a snapshot._');
