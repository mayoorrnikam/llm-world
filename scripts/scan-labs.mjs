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
import { sourceText, sourceHtml, htmlToText } from '../lib/source-text.mjs';

const ALL = process.argv.includes('--all');
const ONLY = process.argv.find((a) => a.startsWith('--lab='))?.split('=')[1];

/**
 * `--limit=0` means "start, then stop" — the smoke test's contract.
 *
 * checkScriptsRun() launches every script this way with a 30-second timeout to
 * prove it can still start; a script gutted by a bad edit fails there rather
 * than at 6am in CI. Every other script honours it. This one never read the
 * flag at all, so the check ran a FULL live scan of every channel and passed
 * only because that happened to finish in time.
 *
 * Adding three channels in one day took it past thirty seconds, and CI failed
 * with "exit null" — killed by the timeout, which reads like a broken script
 * rather than a slow one. The check was never meant to measure how fast the
 * network is.
 */
if (process.argv.includes('--limit=0')) process.exit(0);

/**
 * Extra channels for labs whose documentation this dataset does not yet cite.
 *
 * Everything else is DERIVED from the dataset's own sources — see channels()
 * below. A hand-maintained list of six labs was the first version, and it was
 * both narrower than the dataset and a second thing to keep current.
 */
const EXTRA = [
  // Documentation indexes this dataset does not yet cite.
  { lab: 'Google DeepMind', url: 'https://ai.google.dev/gemini-api/docs/models', docs: true },
  // Documentation LAGS the announcement, which is a different failure from
  // documentation being unreachable. On the day Gemini 3.7 Flash shipped, this
  // docs page listed up to gemini-3.6-flash and never mentioned 3.7 — so the
  // scan ran twice, succeeded twice, and reported nothing. A docs-only channel
  // reports a same-day release as a quiet day.
  { lab: 'Google DeepMind', url: 'https://blog.google/products/gemini/rss/' },
  // The best Google channel of the three: dated release notes naming the API
  // id, updated the day a model ships. It carried "August 13, 2026 — Gemini 3.7
  // Flash generally available" while the models page still stopped at 3.6.
  //
  // ?hl=en is required, not cosmetic. Without it this page is served in
  // whatever locale Google picks — it came back in Bengali — and every pattern
  // here expects English.
  { lab: 'Google DeepMind', url: 'https://ai.google.dev/gemini-api/docs/changelog?hl=en', docs: true },

  // News and blog indexes, for the twelve labs whose documentation is not cited
  // by any record — without these the scan reached six labs out of eighteen.
  // Every URL below was fetched before being added; a channel that 403s is
  // worse than no channel, because it reports silence as calm.
  { lab: 'Mistral AI', url: 'https://mistral.ai/news/' },
  { lab: 'Anthropic', url: 'https://www.anthropic.com/news' },
  { lab: 'Meta AI', url: 'https://ai.meta.com/blog/' },
  { lab: 'Alibaba Qwen', url: 'https://qwenlm.github.io/blog/' },
  { lab: 'Amazon', url: 'https://aws.amazon.com/blogs/machine-learning/' },
  // microsoft.ai, not the Azure blog: the MAI line ships on the former and the
  // latter names none of it. Eight MAI models were live and undiscoverable.
  { lab: 'Microsoft', url: 'https://microsoft.ai/news/' },
  { lab: 'Microsoft', url: 'https://azure.microsoft.com/en-us/blog/' },
  { lab: 'Cohere', url: 'https://cohere.com/blog' },
  { lab: 'Allen Institute for AI', url: 'https://allenai.org/blog' },
  { lab: 'AI21 Labs', url: 'https://www.ai21.com/blog/' },
  // developer.nvidia.com, not blogs.nvidia.com: model announcements live on the
  // developer blog, and the corporate one carries them late and partially.
  { lab: 'NVIDIA', url: 'https://developer.nvidia.com/blog/' },
  { lab: 'MiniMax', url: 'https://www.minimax.io/news' },
  { lab: 'Moonshot AI', url: 'https://moonshotai.github.io/' },
  // Zhipu was listed as having no channel at all: z.ai/blog now 404s and the
  // homepage is client-rendered down to 53 characters. Its DEVELOPER docs carry
  // dated release notes for every GLM model, which is the one surface the lab
  // maintains in readable HTML.
  //
  // z.ai answers 200 for paths that do not exist — /blog/glm-5.3 and an
  // invented control both return a body no reader can use — so this channel was
  // confirmed by reading 8,711 characters of it, never by its status code.
  { lab: 'Zhipu AI', url: 'https://docs.z.ai/release-notes', docs: true },
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
  { lab: 'Zhipu AI', url: 'https://z.ai/blog', covered: 'docs.z.ai release notes' },
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
  // A cloud marketplace prefixes the lab's own id: Bedrock serves
  // `anthropic.claude-opus-5`, Vertex `google.gemini-3-pro`, and a regional
  // copy adds `us.` or `eu.` on top. Twenty-one Anthropic "candidates" were
  // models we already hold, wearing a reseller's prefix.
  .replace(/^(?:us|eu|apac|global)\./i, '')
  .replace(/^(?:anthropic|google|meta|amazon|mistral|cohere|ai21|openai|deepseek)\./i, '')
  .replace(/-+$/, '')                        // regex artifacts like "…-4-5-20251001-"
  .replace(/-(?:20\d{6}|\d{4})$/, '')        // -20251001, -2506
  .replace(/-(?:preview|latest|exp)$/, ''));

const releasesByLab = new Map();
for (const r of data.releases) {
  if (!releasesByLab.has(r.company)) releasesByLab.set(r.company, []);
  releasesByLab.get(r.company).push(r);
}

const trackedByLab = new Map();
for (const r of data.releases) {
  const k = r.company;
  if (!trackedByLab.has(k)) trackedByLab.set(k, []);
  trackedByLab.get(k).push(base(r.id), base(r.model));
}

/**
 * Display name → API id, read from a docs page that prints both.
 *
 * Google's model list is two columns: "Nano Banana 2" and
 * `gemini-3.1-flash-image` are the same model. The scan only ever read the id
 * column, so it reported gemini-3.1-flash-image as untracked while the dataset
 * held Nano Banana 2 — a candidate that is not a candidate, which is the worst
 * thing a discovery report can contain, because chasing it costs the same as
 * chasing a real one and teaches you to trust the list less.
 *
 * The pairs are only believed when the id looks like an id (lowercase, hyphen
 * or dot separated) and the name does not, so ordinary prose cannot be read as
 * a mapping.
 */
const ALIAS_PAIR = /([A-Z][\w.\- ]{2,28}?)\s+((?:gemini|imagen|veo|lyria|gemma)-[a-z0-9.\-]{3,40})(?=\s|$)/g;

function aliasesIn(text) {
  const out = new Map();
  for (const m of text.matchAll(ALIAS_PAIR)) {
    const name = m[1].trim();
    if (/^(model|endpoint|preview|new|all)$/i.test(name)) continue;
    out.set(flat(m[2]), name);
  }
  return out;
}

/** Known if any tracked name for this lab is a prefix of it, or it of them. */
const isKnown = (lab, id, aliases) => {
  const b = base(id);
  if (!b) return true;
  // An id whose display name we already track is not a candidate.
  const shown = aliases?.get(flat(id));
  if (shown && (trackedByLab.get(lab) ?? []).some((t) => t && flat(shown).startsWith(t))) return true;
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

/* ------------------------------------------------- structural extraction
 *
 * WHY NOT A NAME PATTERN
 *
 * This scan used to build a regex per lab out of the ids it already tracked —
 * "we hold grok-1 and grok-4-5, so look for grok followed by a version". That
 * can only ever find more of what we already have. Measured against this
 * dataset it was worse than it sounds:
 *
 *   19 records in our own history opened a product line the pattern could not
 *      have matched — Gemma, Imagen, Veo, Lyria, Sora, Muse, MAI, QwQ,
 *      Ministral, Seedream, CogVideoX
 *   50 of 192 tracked models do not match their own lab's pattern TODAY,
 *      because it demands a separator then a digit: DeepSeek-R1, GPT-4o,
 *      Kimi K2, Command R, Nova Micro, Gemma, PaLM, BLOOM. The o-series has no
 *      stem at all — the code needs two letters and "o1" has one.
 *
 * And the same regex invented models out of prose: `gemini youtube article 13`
 * and `gemini team 5` were both proposed as releases from a blog index.
 *
 * So read the page's STRUCTURE instead. A docs index marks each model up as a
 * code span, a table cell or an option value, because the reader is meant to
 * copy it into an API call. A news index marks each release up as a headline.
 * Neither depends on knowing the name in advance, which is the whole point: a
 * lab is free to call the next one anything it likes.
 */

/** Tags whose text content is a value the reader is meant to copy. */
const CODE_SLOT = /<(code|kbd|samp|tt)\b[^>]*>([\s\S]{1,120}?)<\/\1>/gi;
const CELL_SLOT = /<td\b[^>]*>([\s\S]{1,160}?)<\/td>/gi;
const OPT_SLOT = /<option\b[^>]*\bvalue\s*=\s*["']([^"']{2,80})["']/gi;
/**
 * The payload behind a docs page, which is where the list usually is now.
 *
 * A modern docs site is a React app: docs.x.ai renders 427KB of markup with 351
 * mentions of "grok", no table cells and fourteen code spans, none of them a
 * model. The actual list is a JS object in a script tag —
 * `globalThis.__XAI_PUBLIC_MODELS__={"clusterConfigs":[{"languageModels":
 * [{"name":"grok-4.3",...`. Reading only the visible markup finds nothing,
 * which reads exactly like a quiet week.
 *
 * Both quote styles, because a streamed RSC chunk escapes its own: the same
 * field arrives as "name":"x" in one script tag and \"name\":\"x\" in the next.
 */
const JSON_ID = /\\?"(?:id|model|model_name|modelId|model_id)\\?"\s*:\s*\\?"([^"\\]{2,64})\\?"/gi;

/**
 * `"name"` is where xAI keeps its models and where everyone keeps everything
 * else.
 *
 * Taking it unconditionally added 131 candidates from Zhipu alone — meta tag
 * names (`application-name`, `msapplication-tilecolor`) and the docs platform's
 * own feature flags (`self-serve-sso`, `dashboard-editor-theseus`), all shaped
 * exactly like ids.
 *
 * So the key is only believed when the object around it DESCRIBES a model. An
 * entry for a served model says what it costs, what it accepts or how much
 * context it has; a feature flag says `enabled: true`. That test needs no
 * knowledge of what the model is called, which is the property being defended
 * here.
 */
const JSON_NAME = /\\?"name\\?"\s*:\s*\\?"([^"\\]{2,64})\\?"/gi;
const MODELISH = /(?:input|output)?modalit|context.?(?:window|length)|max.?(?:output.?)?tokens|token.?price|"?pricing|capabilit|aliases|\\?"version\\?"|knowledge.?cut|training.?cut|parameters?.?count|"?deprecat/i;

/**
 * API vocabulary, which lives in exactly the same code spans as model ids.
 *
 * This is the cost of reading structure instead of a name pattern: a docs page
 * puts `temperature` and `claude-opus-4-5` in identical markup. The stoplist is
 * the honest way to pay it — a fixed, inspectable list of words that are never
 * model names, rather than a pattern that decides in advance what a model may
 * be called.
 */
const API_VOCAB = new Set(`
temperature top_p top_k max_tokens max_output_tokens stop stop_sequences stream
messages model models prompt system user assistant tool tools tool_choice role
content type text image audio video json object array string number boolean null
true false function functions parameters properties required input output usage
prompt_tokens completion_tokens total_tokens finish_reason id object created
choices delta index logprobs seed n frequency_penalty presence_penalty
response_format api_key authorization bearer post get put delete patch http https
endpoint url base_url version curl python javascript typescript node npm pip
error code message status request response header headers body data result
thinking reasoning reasoning_effort verbosity cache_control ephemeral
metadata name description schema enum items default example examples
generatecontent streamgeneratecontent counttokens embedcontent batchembedcontents
completions chat responses embeddings moderations files batches
`.trim().split(/\s+/));

/**
 * Two kinds of token that live in the same fields as model names.
 *
 * Framework internals: a Next.js payload puts "viewport", "next.metadata" and
 * "docs-content" under the same `name` key that holds "grok-4.3".
 *
 * Heading slugs: a docs page anchors its sections, so
 * `which-model-should-i-choose` and `additional-information-regarding-models`
 * arrive shaped exactly like hyphenated ids. What separates them is English —
 * no lab has ever named a model with a preposition in it.
 */
const FRAMEWORK = /^(?:next[.-]|__|data-|aria-|ms-?application|apple-mobile|og-|twitter-)|mintlify|theme-color|application-name|^(?:viewport|metadata|outlet|robots|favicon|charset|canonical|sitemap|layout|template|locale|theme|slot|root|main|nav|footer|header)$/i;

/**
 * What a comparison table puts in its other columns.
 *
 * Reading <td> is what finds a model list; it also finds every cell beside it.
 * Anthropic's model table yielded "effort", "high", "no" and "yes" as
 * candidate models — each one costing a reader exactly as much to check as a
 * real lead, which is how a discovery list stops being read.
 */
const CELL_VALUE = new Set(`
yes no true false none all any some n/a na tbd unknown unlimited
high medium low mini micro small large standard basic premium
effort enabled disabled available unavailable supported unsupported
beta alpha stable preview legacy deprecated retired new latest current
input output text image audio video vision tokens token free paid
max min auto off on default enabled_only only mode modes type
`.trim().split(/\s+/));

const SLUG_WORDS = new Set(`
which what why how when where who should would could must can will
about regarding information additional further more other another
choose choosing chosen using use used getting get start started
guide overview reference changelog pricing limits quotas errors faq
the and for with from into your our their this that these those
aliases content section page docs doc api comparison migrating migrate
snippet snippets billing dashboard editor profile sso workflows robotics
quickstart tutorial example samples pricing peak
`.trim().split(/\s+/));

/**
 * Does this token look like something a lab would serve, rather than a word?
 *
 * Deliberately permissive about SHAPE and strict about vocabulary. Requiring a
 * digit is what broke the old pattern — Gemma, PaLM, BLOOM, Whisper and
 * Command R are all real models with no version number in the name — so shape
 * is not allowed to be the discriminator here.
 */
function looksLikeModelId(raw) {
  const t = String(raw).trim().replace(/^[`'"([]+|[`'".,;:)\]]+$/g, '');
  if (t.length < 2 || t.length > 64) return false;
  if (/\s{2,}|[\n\r]/.test(t)) return false;
  if (/^https?:|[/\\@{}<>|$]/.test(t)) return false;      // urls, paths, templates
  if (!/[a-z]/i.test(t)) return false;                     // must have a letter
  if (/^[\d.]+$/.test(t)) return false;                    // bare versions
  if (API_VOCAB.has(t.toLowerCase())) return false;
  if (/^[A-Z_]+$/.test(t) && t.length > 3) return false;   // CONSTANT_NAMES
  // A model id is one token, or a short display name of at most four words.
  if (t.split(/\s+/).length > 4) return false;
  if (FRAMEWORK.test(t)) return false;
  // A UUID is a content id, never a model name. Cohere's site yields dozens.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(t)) return false;
  // A month-year is a training cutoff read out of a comparison table.
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{0,4}\s*\d*$/i.test(t)) return false;
  // A <td> holds VALUES as well as ids: "yes", "high", "effort", "200K".
  if (CELL_VALUE.has(t.toLowerCase())) return false;
  if (t.toLowerCase().split(/[-_. ]/).some((seg) => SLUG_WORDS.has(seg))) return false;
  return /^[A-Za-z][\w.\- ]*$/.test(t);
}

/**
 * Every candidate identifier a docs page marks up as a value.
 *
 * `lab` is passed so the company's own name can be dropped: a payload that
 * lists models also names the provider, and "xai" arrived as a candidate model
 * from xAI's own model list.
 */
function idsInDocs(html, lab = '') {
  const own = new Set([flat(lab), flat(lab).replace(/ai$/, ''), flat(lab).split(' ')[0]]
    .filter((x) => x && x.length >= 2));
  const out = new Map();
  const add = (v, weight = 1) => {
    const t = String(v).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').trim();
    if (!looksLikeModelId(t)) return;
    if (own.has(flat(t))) return;
    const k = t.toLowerCase();
    out.set(k, (out.get(k) ?? 0) + weight);
  };
  for (const m of html.matchAll(CODE_SLOT)) add(m[2]);
  for (const m of html.matchAll(CELL_SLOT)) add(m[1]);
  for (const m of html.matchAll(OPT_SLOT)) add(m[1]);
  // A structured field weighs more than a code span. The repeat rule below
  // exists to reject ids mentioned once in prose; a "name" inside a payload is
  // not prose, and xAI lists each model exactly once there.
  for (const m of html.matchAll(JSON_ID)) add(m[1], 2);
  for (const m of html.matchAll(JSON_NAME)) {
    if (MODELISH.test(html.slice(m.index, m.index + 400))) add(m[1], 2);
  }
  return out;
}

/** Headlines from a news index or RSS feed, which is where a NEW line appears. */
const HEADING = /<(h[1-4]|title)\b[^>]*>([\s\S]{4,160}?)<\/\1>/gi;

function headlinesIn(html) {
  const out = [];
  for (const m of html.matchAll(HEADING)) {
    const t = m[2].replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/\s+/g, ' ').trim();
    if (t.length >= 8 && t.length <= 160) out.push(t);
  }
  return [...new Set(out)];
}

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
      // A homepage is not a documentation index. Trimming the last segment off
      // `https://cohere.com/x` leaves the origin, and cohere.com's marketing
      // page produced 79 candidates: its integrations list (algolia, asana,
      // box, bigquery) read exactly like a model list.
      if (!/^https?:\/\/[^/]+\/.+/.test(index)) continue;
      e.docs.set(index, (e.docs.get(index) ?? 0) + 1);
    }
  }

  const out = [];
  for (const [lab, e] of byLab) {
    /**
     * EVERY stem this lab uses, not just its commonest.
     *
     * Taking the most frequent one gave Microsoft "phi", because four Phi
     * records outnumbered one MAI — so the entire MAI line, eight models across
     * text, image, speech and code, was invisible to a scan pointed straight at
     * the page listing them. A lab with two product lines is normal; assuming
     * one was the bug.
     */
    // No stem, no pattern, no `continue` when a lab's ids do not start with
    // letters. The o-series used to disqualify OpenAI's whole channel here.

    // The index cited by the most records is the one the lab actually maintains.
    const url = [...e.docs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!url) continue;

    out.push({
      lab,
      url,
      post: () => url,
      docs: true,
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
    // Every stem, as above. Taking ids[0] gave Microsoft "phi" from a Phi
    // record and lost the whole MAI line on the page that lists it.
    out.push({ lab: x.lab, url: x.url, docs: Boolean(x.docs), post: () => x.url });
  }
  return out;
}

const targets = channels().filter((c) => !ONLY || c.lab.toLowerCase() === ONLY.toLowerCase());

/**
 * A headline is only a lead if it announces something.
 *
 * This used to be a NOISE list that excluded "announces", "launches" and
 * "introduces" — correct when a name pattern was mined out of headline text,
 * because "Mistral AI raises 1.7B" parsed as a model called `mistral ai raises
 * 1`. Now the headline IS the lead, so the test inverts: an announcement verb
 * is the whole signal, and its absence is what makes a headline noise.
 *
 * Without it a product blog delivers its staff page. blog.google's Gemini feed
 * returned "Senior Director", "Contributor" and "Partnerships Lead" as
 * candidate releases, alongside SAT prep and the state fair.
 */
const HEADLINE_SIGNAL = /\b(?:introduc|announc|launch|unveil|releas|debut|ship(?:s|ping)?\b|now available|generally available|meet\s+[A-Z]|open[- ]?sourc|open[- ]?weight|we'?re bringing)/i;

/** Still worth excluding outright: these are never a model release. */
const HEADLINE_NOISE = /\b(?:raises?|funding|series [A-E]\b|valuation|partners(?:hip)?|acquires?|acquisition|hiring|hires?|joins?|appoints?|promotes?|webinar|conference|summit|podcast|interview|lawsuit|court|settlement|earnings|quarterly)\b/i;

const findings = [];
const unreachable = [];

for (const c of targets) {
  const html = await sourceHtml(c.url, { cache: false });
  if (typeof html !== 'string') { unreachable.push(c); continue; }
  // sourceText's stripped copy is still what alias pairs are read from: those
  // are a NAME beside an ID in running text, which is prose, not structure.
  const text = htmlToText(html);

  let seen = [];
  let leads = [];

  if (c.docs) {
    /**
     * An identifier marked up once may still be prose inside a code span —
     * xAI's docs say "not supported by models grok-4.20 and newer", and there
     * is no Grok 4.20. A model the lab actually serves is written down more
     * than once: in its table row, its heading and its alias.
     */
    const counts = idsInDocs(html, c.lab);
    seen = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  } else {
    /**
     * A news index gets headlines, not parsed identifiers.
     *
     * Pulling a model name out of "Introducing Muse Spark, our new..." needs to
     * know what a model name looks like, which is the assumption this rewrite
     * exists to remove. So the headline IS the lead: a person or an agent reads
     * it and decides. That is strictly more useful than the tokens the old
     * pattern produced here, which included `gemini youtube article 13` and
     * `gemini team 5` — neither of which is a model, both of which cost a
     * reader the same to check as a real one.
     */
    /**
     * A headline names the LINE, the dataset holds the VARIANT.
     *
     * "Introducing Shieldstral." against a tracked `Shieldstral 1.0 3B` shares
     * no flattened substring, so the announcement of a model we already have
     * came back as a lead. Matching on the first word of each tracked name is
     * what connects the two.
     */
    const words = new Set((releasesByLab.get(c.lab) ?? [])
      .flatMap((r) => [r.model, r.id])
      .map((n) => flat(String(n).split(/[\s\-_.]/)[0]))
      .filter((w) => w.length >= 4));
    leads = headlinesIn(html)
      .filter((h) => h.length >= 14)
      .filter((h) => HEADLINE_SIGNAL.test(h) && !HEADLINE_NOISE.test(h))
      .filter((h) => ![...words].some((w) => flat(h).includes(w)));
  }

  const aliases = aliasesIn(text);
  const byBase = new Map();
  for (const m of seen) if (!byBase.has(base(m))) byBase.set(base(m), m);
  const untracked = [...byBase.values()].filter((m) => !isKnown(c.lab, m, aliases));
  const fresh = BACKLOG ? untracked : untracked.filter((m) => !seenSet.has(base(m)));
  const freshLeads = BACKLOG ? leads : leads.filter((h) => !seenSet.has(base(h)));
  findings.push({ ...c, seen, fresh, leads: freshLeads, allLeads: leads, aliases, untracked });
}

/* -------------------------------------------------------------- report */

const total = findings.reduce((n, f) => n + f.fresh.length, 0);

console.log(`## Lab documentation scan\n`);
// The backlog is what is untracked; `total` is what is untracked AND unreported.
// Saying "everything is tracked" when thirty models are merely already-reported
// would be the scan lying about the thing it exists to measure.
const backlog = findings.reduce((n, f) => n + (f.untracked?.length ?? 0), 0);

console.log(total
  ? `${total} model${total === 1 ? '' : 's'} newly listed by a lab and not in this dataset. `
    + `Candidates only — each needs the lab's own announcement and an archived snapshot before it becomes a record.\n`
  : backlog
    ? `Nothing NEW since the last scan, and ${backlog} documented model${backlog === 1 ? ' is' : 's are'} `
      + `still untracked from earlier ones. They are listed below.\n`
    : `Nothing new listed, and nothing outstanding. Every model these labs document is tracked.\n`);

/**
 * When nothing is new, print the BACKLOG rather than one line saying there is
 * one.
 *
 * The seen-list exists so a scan running twice a day does not repeat itself,
 * and it worked so well that the issue went quiet for six days with 38
 * documented models outstanding — the report was measuring novelty while the
 * reader wanted outstanding work. Novelty is a property of the scan; the
 * backlog is a property of the dataset, and only one of those is worth
 * anybody's morning.
 */
const nothingNew = total === 0;
for (const f of findings) {
  const show = nothingNew ? f.untracked : f.fresh;
  if (!show?.length && !f.leads.length && !ALL) continue;
  console.log(`**${f.lab}** — ${f.seen.length} documented, ${(f.untracked ?? []).length} untracked`
    + (nothingNew && show?.length ? ' (backlog)' : ''));
  for (const m of show ?? []) console.log(`- \`${m}\` — start from ${f.post(m)}`);
  for (const h of f.leads ?? []) console.log(`- headline: ${h} — ${f.url}`);
  if (ALL && !show?.length && !f.leads.length) console.log(`- all ${f.seen.length} already tracked`);
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
    ...findings.flatMap((f) => f.fresh.map((m) => base(m))),
    ...findings.flatMap((f) => (f.leads ?? []).map((h) => base(h)))])].sort();
  writeFileSync(SEEN_FILE, JSON.stringify({
    note: 'Docs identifiers already surfaced by scripts/scan-labs.mjs. Presence here '
      + 'means "reported once", never "tracked" — the dataset is the record of what is tracked.',
    candidates: all,
  }, null, 2) + '\n');
  console.log(`\n_Recorded ${all.length} surfaced identifiers, so the next scan reports only what is new._`);
}

console.log(`_Documentation is a discovery source, never a source of truth. A name here means "look at this"._`);
