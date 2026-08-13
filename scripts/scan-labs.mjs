#!/usr/bin/env node
/**
 * Watches each lab through whichever channel actually works for it.
 *
 *   node scripts/scan-labs.mjs              candidates not yet tracked
 *   node scripts/scan-labs.mjs --all        everything each channel lists
 *   node scripts/scan-labs.mjs --lab=xAI    one lab
 *
 * WHY THIS EXISTS
 *
 * The two discovery scripts before it share a blind spot, and Grok 4.6 fell
 * straight through it:
 *
 *   check-freshness  watches Hugging Face — blind to any lab that ships no
 *                    weights, which is xAI, OpenAI, Anthropic and Gemini
 *   check-feeds      watches RSS — xAI publishes no feed, and it is one of
 *                    nineteen labs listed in that script as having none
 *
 * Both say so honestly in their output, and saying so is not catching it. Grok
 * 4.6 and Grok 4.20 were both live and listed while this dataset's most recent
 * xAI record was Grok 4.5.
 *
 * The channel that works for a closed lab is its MODEL DOCUMENTATION. A docs
 * index lists every model the lab currently serves, it is maintained because
 * customers depend on it, and it stays fetchable when the newsroom does not:
 * x.ai/news returns 403 to an automated request while docs.x.ai/docs/models
 * returns the full list.
 *
 * WHAT THIS IS NOT
 *
 * A discovery source, never a source of truth (METHODOLOGY §5). A name here
 * means "look at this", not "add this". Nothing is written, and the record that
 * follows must still cite the lab's own announcement for the release.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { sourceText } from '../lib/source-text.mjs';

const ALL = process.argv.includes('--all');
const ONLY = process.argv.find((a) => a.startsWith('--lab='))?.split('=')[1];

/**
 * Extra channels for labs whose documentation this dataset does not yet cite.
 *
 * Everything else is DERIVED from the dataset's own sources — see channels()
 * below. A hand-maintained list of six labs was the first version, and it was
 * both narrower than the dataset and a second thing to keep current.
 */
const EXTRA = [
  // Documentation indexes this dataset does not yet cite.
  { lab: 'Google DeepMind', url: 'https://ai.google.dev/gemini-api/docs/models' },

  // News and blog indexes, for the twelve labs whose documentation is not cited
  // by any record — without these the scan reached six labs out of eighteen.
  // Every URL below was fetched before being added; a channel that 403s is
  // worse than no channel, because it reports silence as calm.
  { lab: 'Mistral AI', url: 'https://mistral.ai/news/' },
  { lab: 'Anthropic', url: 'https://www.anthropic.com/news' },
  { lab: 'Meta AI', url: 'https://ai.meta.com/blog/' },
  { lab: 'Alibaba Qwen', url: 'https://qwenlm.github.io/blog/' },
  { lab: 'Amazon', url: 'https://aws.amazon.com/blogs/machine-learning/' },
  { lab: 'Microsoft', url: 'https://azure.microsoft.com/en-us/blog/' },
  { lab: 'Cohere', url: 'https://cohere.com/blog' },
  { lab: 'Allen Institute for AI', url: 'https://allenai.org/blog' },
  { lab: 'AI21 Labs', url: 'https://www.ai21.com/blog/' },
  // developer.nvidia.com, not blogs.nvidia.com: model announcements live on the
  // developer blog, and the corporate one carries them late and partially.
  { lab: 'NVIDIA', url: 'https://developer.nvidia.com/blog/' },
  { lab: 'MiniMax', url: 'https://www.minimax.io/news' },
  { lab: 'Moonshot AI', url: 'https://moonshotai.github.io/' },
];

/**
 * Hosts that refuse an automated request, kept so a gap is visible.
 *
 * openai.com returns 403 to every path tried, investor.nvidia.com the same,
 * and z.ai serves an empty body. Their releases have to be noticed some other
 * way, and the report says so rather than letting silence read as calm.
 * OpenAI is covered by its developer documentation instead; NVIDIA by
 * blogs.nvidia.com; Zhipu by nothing yet.
 */
const BLOCKED = [
  { lab: 'OpenAI', url: 'https://openai.com/news/', covered: 'developer documentation' },
  { lab: 'NVIDIA', url: 'https://investor.nvidia.com/news/', covered: 'blogs.nvidia.com' },
  { lab: 'Zhipu AI', url: 'https://z.ai/blog', covered: null },
];


/**
 * Where a lab publishes one page per model, with a derivable URL.
 *
 * Absence is deliberate. A lab without an entry here is reported and never
 * drafted, because the only page we can reach for it lists many models at once
 * — and a draft built from that would mix their figures with a straight face.
 */
const MODEL_URL = {
  xAI: (id) => `https://docs.x.ai/docs/models/${id.replace(/[. ]/g, '-')}`,
  OpenAI: (id) => `https://developers.openai.com/api/docs/models/${id.replace(/ /g, '-')}`,
};

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/**
 * Matching a docs identifier to a record, which is the hard half.
 *
 * Labs expose dated API ids — `mistral-small-2506`, `claude-haiku-4-5-20251001`
 * — where this dataset holds the name the lab announced. A plain diff called 58
 * models untracked when three were, because every Mistral snapshot id since
 * 2023 looked new. Fifty-eight candidates is worse than none: a list nobody
 * reads is a list that hides the three that matter.
 *
 * So the date stamp and the channel suffixes come off, and a candidate counts
 * as known when it shares a prefix with something already tracked for that lab,
 * in EITHER direction — `gemini-3.5-flash-lite` is a variant of a tracked
 * `gemini-3-5-flash`, and `gpt-5.6` is the series behind a tracked
 * `gpt-5-6-sol`.
 */
const flat = (s) => String(s).toLowerCase().replace(/[\s._-]/g, '');

const base = (id) => flat(String(id)
  .replace(/-+$/, '')                        // regex artifacts like "…-4-5-20251001-"
  .replace(/-(?:20\d{6}|\d{4})$/, '')        // -20251001, -2506
  .replace(/-(?:preview|latest|exp)$/, ''));

const trackedByLab = new Map();
for (const r of data.releases) {
  const k = r.company;
  if (!trackedByLab.has(k)) trackedByLab.set(k, []);
  trackedByLab.get(k).push(base(r.id), base(r.model));
}

/** Known if any tracked name for this lab is a prefix of it, or it of them. */
const isKnown = (lab, id) => {
  const b = base(id);
  if (!b) return true;
  return (trackedByLab.get(lab) ?? []).some((t) => t && (t.startsWith(b) || b.startsWith(t)));
};

/**
 * Identifiers already surfaced by a previous scan.
 *
 * "Untracked" and "new" are different questions, and a scan running twice a day
 * only usefully answers the second. Most of what a docs page lists that this
 * dataset lacks is old — sixteen Gemini variants going back to 2.0 — and
 * reporting them every twelve hours buries the one model that shipped this
 * morning. That backlog is worth knowing once; it is not worth knowing 730
 * times a year.
 *
 * So the seen list is small, tracked in git, and updated by the same PR that
 * proposes the record. --backlog prints everything untracked regardless.
 */
const SEEN_FILE = 'data/seen-candidates.json';
const BACKLOG = process.argv.includes('--backlog');
let seen = [];
try { seen = JSON.parse(readFileSync(SEEN_FILE, 'utf8')).candidates ?? []; } catch { /* first run */ }
const seenSet = new Set(seen);

/**
 * The channels, taken from the sources this dataset already cites.
 *
 * Every record carries its lab's own documentation, vetted as a primary source
 * and legally clean to read because we already cite it publicly. That is a
 * better channel list than one maintained by hand: it covers every lab tracked
 * rather than the six somebody remembered, and it cannot drift from the data.
 *
 * The identifier pattern is derived the same way — from the ids already tracked
 * for that lab. We hold grok-1, grok-3 and grok-4-5, so the prefix is "grok"
 * and the pattern is grok followed by a version. Nothing to configure.
 */
function channels() {
  const byLab = new Map();
  for (const r of data.releases) {
    if (!byLab.has(r.company)) byLab.set(r.company, { docs: new Map(), ids: [] });
    const e = byLab.get(r.company);
    e.ids.push(r.id);
    for (const src of r.sources) {
      if (src.type !== 'official_documentation') continue;
      // Scan the docs INDEX, not one model's page: a per-model URL only ever
      // lists the model already tracked.
      const index = src.url.replace(/\/[^/]*$/, '');
      e.docs.set(index, (e.docs.get(index) ?? 0) + 1);
    }
  }

  const out = [];
  for (const [lab, e] of byLab) {
    // The alphabetic stem shared by this lab's ids — "grok", "gpt", "claude".
    const stems = e.ids.map((id) => /^[a-z]+/.exec(id)?.[0]).filter(Boolean);
    const stem = [...new Set(stems)].sort((a, b) =>
      stems.filter((x) => x === b).length - stems.filter((x) => x === a).length)[0];
    if (!stem || stem.length < 2) continue;

    // The index cited by the most records is the one the lab actually maintains.
    const url = [...e.docs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!url) continue;

    out.push({
      lab,
      url,
      models: new RegExp(`\\b${stem}(?:[-. ][a-z]+){0,2}[-. ][\\d][\\d.]*(?:-[a-z]+)*\\b`, 'gi'),
      post: () => url,
      // A per-model page, where the lab has a predictable one. This is the only
      // input safe to draft from: a docs INDEX names every model the lab
      // serves, so extracting a context window from it would take whichever
      // figure appeared first and attach another model's number to this record.
      modelUrl: MODEL_URL[lab],
    });
  }

  for (const x of EXTRA) {
    // A lab can have both a docs index and a news index; both are worth reading.
    if (out.some((c) => c.url === x.url)) continue;
    const ids = data.releases.filter((r) => r.company === x.lab).map((r) => r.id);
    const stem = /^[a-z]+/.exec(ids[0] ?? '')?.[0];
    if (!stem) continue;
    out.push({ lab: x.lab, url: x.url,
      models: new RegExp(`\\b${stem}(?:[-. ][a-z]+){0,2}[-. ][\\d][\\d.]*(?:-[a-z]+)*\\b`, 'gi'), post: () => x.url });
  }
  return out;
}

const targets = channels().filter((c) => !ONLY || c.lab.toLowerCase() === ONLY.toLowerCase());

const findings = [];
const unreachable = [];

for (const c of targets) {
  const text = await sourceText(c.url, { cache: false });
  if (!text) { unreachable.push(c); continue; }

  /**
   * An identifier mentioned ONCE is prose, not a listing.
   *
   * xAI's docs say "logprobs and top_logprobs are not supported by models
   * grok-4.20 and newer" — a version threshold in an API caveat, and there is
   * no Grok 4.20. The first version of this scan proposed it as a release. A
   * model the lab actually serves appears repeatedly: in its card, its heading
   * and its alias. grok-4.6 appears four times on the same page.
   */
  const counts = new Map();
  for (const m of text.matchAll(c.models)) {
    const k = m[0].toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const seen = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  // Collapse snapshot ids of the same model to one candidate.
  const byBase = new Map();
  for (const m of seen) if (!byBase.has(base(m))) byBase.set(base(m), m);
  const untracked = [...byBase.values()].filter((m) => !isKnown(c.lab, m));
  const fresh = BACKLOG ? untracked : untracked.filter((m) => !seenSet.has(base(m)));
  findings.push({ ...c, seen, fresh });
}

/* -------------------------------------------------------------- report */

const total = findings.reduce((n, f) => n + f.fresh.length, 0);

console.log(`## Lab documentation scan\n`);
// The backlog is what is untracked; `total` is what is untracked AND unreported.
// Saying "everything is tracked" when thirty models are merely already-reported
// would be the scan lying about the thing it exists to measure.
const backlog = findings.reduce((n, f) =>
  n + f.seen.filter((m) => !isKnown(f.lab, m)).length, 0);

console.log(total
  ? `${total} model${total === 1 ? '' : 's'} newly listed by a lab and not in this dataset. `
    + `Candidates only — each needs the lab's own announcement and an archived snapshot before it becomes a record.\n`
  : backlog
    ? `Nothing NEW since the last scan. ${backlog} documented model${backlog === 1 ? ' is' : 's are'} `
      + `still untracked from earlier scans — run with \`--backlog\` to list them.\n`
    : `Nothing new listed, and nothing outstanding. Every model these labs document is tracked.\n`);

for (const f of findings) {
  if (!f.fresh.length && !ALL) continue;
  console.log(`**${f.lab}** — ${f.seen.length} documented, ${f.fresh.length} untracked`);
  for (const m of f.fresh) console.log(`- \`${m}\` — start from ${f.post(m)}`);
  if (ALL && !f.fresh.length) console.log(`- all ${f.seen.length} already tracked`);
  console.log();
}

if (BLOCKED.length && !ONLY) {
  console.log(`### Hosts that refuse an automated request\n`);
  for (const b of BLOCKED) {
    console.log(`- **${b.lab}** — ${b.url}${b.covered ? ` (covered instead by ${b.covered})` : ' — **no channel yet**'}`);
  }
  console.log(`\nSilence from these is not evidence of a quiet week.\n`);
}

if (unreachable.length) {
  console.log(`### Channels that did not answer\n`);
  for (const c of unreachable) console.log(`- **${c.lab}** — ${c.url}`);
  console.log(`\nA channel that cannot be read is not a quiet week. These labs need checking by hand.\n`);
}

if (process.argv.includes('--json')) {
  const rows = findings.flatMap((f) => f.fresh.map((id) => ({
    lab: f.lab,
    id,
    // null means "report only" — see MODEL_URL.
    url: f.modelUrl ? f.modelUrl(id) : null,
  })));
  console.log(JSON.stringify(rows, null, 2));
}

if (process.argv.includes('--record')) {
  const all = [...new Set([...seen,
    ...findings.flatMap((f) => f.fresh.map((m) => base(m)))])].sort();
  writeFileSync(SEEN_FILE, JSON.stringify({
    note: 'Docs identifiers already surfaced by scripts/scan-labs.mjs. Presence here '
      + 'means "reported once", never "tracked" — the dataset is the record of what is tracked.',
    candidates: all,
  }, null, 2) + '\n');
  console.log(`\n_Recorded ${all.length} surfaced identifiers, so the next scan reports only what is new._`);
}

console.log(`_Documentation is a discovery source, never a source of truth. A name here means "look at this"._`);
