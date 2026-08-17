#!/usr/bin/env node
/**
 * Reads modalities and token limits off Google's own per-model documentation.
 *
 *   node scripts/gemini-specs.mjs           report what the pages state
 *   node scripts/gemini-specs.mjs --write   record it
 *
 * WHY THIS PAGE AND NOT THE INDEX
 *
 * ai.google.dev/gemini-api/docs/models lists every Gemini model but carries no
 * specifications — it is a name/endpoint table. Each model's OWN page under it
 * states them plainly:
 *
 *   Inputs              Text, Image, Video, Audio, and PDF
 *   Output              Text
 *   Input token limit   1,048,576
 *   Output token limit  65,536
 *   Audio generation    Not supported
 *
 * That is a context window and a full modality pair, from the lab, in prose a
 * reader can check — the two fields Google records here were thinnest on.
 *
 * The URL uses the DOTTED version: .../models/gemini-3.7-flash, not
 * gemini-3-7-flash. I looked for the hyphenated form first, got nothing, and
 * concluded the per-model pages were client-rendered and unreadable. They are
 * neither. A 404 that reads as "this page does not exist" rather than "you
 * asked for the wrong URL" is the easiest kind of wrong answer to believe, and
 * it cost this project a spec source it had all along.
 *
 * WHAT IT WILL NOT DO
 *
 * It writes only the two fields it can read verbatim, and only onto records
 * that have none — a figure already traced to a source is never overwritten by
 * a scrape.
 *
 * `capabilities` ARE imported now, but only the affirmatives. This page states
 * them as a Supported/Not supported grid, and TAXONOMY §4 is explicit that an
 * unlisted capability means "not evidenced" rather than "absent" — so a
 * "Supported" cell is evidence and a "Not supported" cell is dropped, because
 * recording it as silence would be indistinguishable from never having looked.
 * Which rows map to which capability is the delicate part; see GEMINI_CAPS.
 */

import { readFileSync } from 'node:fs';
import { sourceText, FAILED } from '../lib/source-text.mjs';
import { saveDataset } from '../lib/dataset.mjs';
// Shared half of every docs reader. The parsing below stays lab-specific —
// see lib/model-docs.mjs for why that line is drawn where it is.
import { fetchText, flat, tokens, citeDocs, mergeCaps } from '../lib/model-docs.mjs';

const WRITE = process.argv.includes('--write');
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/**
 * Google's own id for a record — READ from the index, not guessed from the name.
 *
 * Deriving it works for "Gemini 3.7 Flash" and fails for everything Google
 * brands separately: Nano Banana 2 is served as gemini-3.1-flash-image, and
 * guessing produced nano-banana-2, a 404 that reads like "no such page". The
 * index prints both columns, so it is the thing that actually knows.
 */
const INDEX = 'https://ai.google.dev/gemini-api/docs/models?hl=en';

/**
 * Every per-model page the index LINKS TO.
 *
 * The first version matched "Nano Banana 2  gemini-3.1-flash-image" as a text
 * pair, which needed a regex tuned to a table layout and silently missed
 * anything laid out differently. The index links to each page directly, so the
 * hrefs are the authoritative list and cost no guessing — they also turned up
 * endpoints the text pass never saw, including deep-research-preview and
 * antigravity-preview.
 *
 * Read from the raw HTML rather than sourceText, because sourceText returns
 * prose and the whole point here is the markup.
 */
async function endpointsFromIndex() {
  const html = await fetchText(INDEX);
  if (!html) return [];
  return [...new Set([...html.matchAll(/href="[^"]*gemini-api\/docs\/models\/([a-z0-9.-]+)"/g)]
    .map((m) => m[1]))];
}

/**
 * Display name → endpoint, from the same page's two-column table.
 *
 * The hrefs give the authoritative LIST of endpoints; they cannot tell you
 * that "Nano Banana 2" is gemini-3.1-flash-image, because the two share no
 * substring. Google brands several models separately from their API id, so
 * matching on the name alone reports them as not served when they are the
 * newest thing on the page. Both halves of the table are needed: the links for
 * what exists, the text for what it is called.
 */
const ALIAS_PAIR = /([A-Z][\w.\- ]{2,28}?)\s+((?:gemini|imagen|veo|lyria|gemma)-[a-z0-9.\-]{3,40})(?=\s|$)/g;

async function displayNames() {
  const t = await sourceText(INDEX, { cache: false });
  if (!t || t === FAILED) return new Map();
  const flat = (x) => String(x).toLowerCase().replace(/[\s._-]/g, '');
  const out = new Map();
  for (const m of t.replace(/\s+/g, ' ').matchAll(ALIAS_PAIR)) {
    const name = m[1].trim();
    if (/^(model|endpoint|preview|new|all)$/i.test(name)) continue;
    out.set(flat(name), m[2]);
  }
  return out;
}

/** Match a record to one of those endpoints, by alias first then by name. */
function endpointFor(model, endpoints, aliases) {
  const flat = (x) => String(x).toLowerCase().replace(/[\s._-]/g, '');
  const want = flat(model);
  const alias = aliases?.get(want);
  if (alias && endpoints.includes(alias)) return alias;
  const exact = endpoints.find((e) => flat(e) === want);
  if (exact) return exact;
  return [...endpoints].sort((a, b) => b.length - a.length)
    .find((e) => flat(e).startsWith(want) || want.startsWith(flat(e)));
}

/**
 * Google's input list mapped onto this project's modality vocabulary.
 *
 * PDF is deliberately absent. Google lists it as an input, and TAXONOMY has no
 * such modality — the vocabulary is text/image/audio/video/3d/sensor/
 * environment. The validator rejected it, correctly: a scraper must not widen
 * a controlled vocabulary as a side effect of reading a page that happens to
 * use a different one. Adding `pdf` is a taxonomy decision for a person, not
 * something an importer should smuggle in.
 *
 * Dropping it loses nothing a reader needs here: a model that accepts PDF
 * accepts it as text and image, both of which are recorded.
 */
const MODALITY = { text: 'text', image: 'image', video: 'video', audio: 'audio' };

/** "Text, Image, Video, Audio, and PDF" → ['text','image','video','audio','pdf'] */
const parseModalities = (s) => [...new Set(
  s.toLowerCase().split(/,|\band\b/).map((x) => MODALITY[x.trim()]).filter(Boolean),
)];


async function specsFor(endpoint) {
  const url = `https://ai.google.dev/gemini-api/docs/models/${endpoint}?hl=en`;
  const t = await sourceText(url, { cache: false });
  if (!t || t === FAILED) return { url, error: 'unreadable' };
  const s = t.replace(/\s+/g, ' ');

  const inputs = /Inputs\s+([A-Za-z,\s]+?)\s+Output\b/.exec(s);
  const output = /\bOutput\s+([A-Za-z,\s]+?)\s+(?:token_auto|Token limits)/.exec(s);
  const ctx = /Input token limit\s+([\d,]+)/.exec(s);
  const out = /Output token limit\s+([\d,]+)/.exec(s);

  return {
    url,
    modalities: inputs && output
      ? { input: parseModalities(inputs[1]), output: parseModalities(output[1]) }
      : null,
    context_window: ctx ? tokens(ctx[1]) : null,
    output_limit: out ? tokens(out[1]) : null,
    caps: capsIn(s),
  };
}

/**
 * The Capabilities block, which prints "<Feature> Supported" or "Not supported".
 *
 * WHAT IS DELIBERATELY NOT MAPPED
 *
 * "Audio generation: Supported" is not mapped either, and that one is subtler.
 * The row is true of Lyria 3, which generates MUSIC, and of Gemini 3.1 Flash
 * Live, which generates SPEECH. The vocabulary has speech_generation and no
 * music equivalent, so the row would have labelled a music model as a speech
 * model — a confident wrong fact from an accurate source. It waits for a
 * taxonomy decision by a person.
 *
 * "Code execution: Supported" is a sandboxed tool the API can call. It says
 * nothing about whether the model writes good code, and mapping it to `coding`
 * would drop every Gemini model into "best model for coding" on a feature flag.
 * Same for caching, search grounding, Maps, URL context and batch inference:
 * platform features, not model abilities.
 *
 * A "Not supported" is read and discarded — see mergeCaps for why absence
 * cannot be recorded here.
 */
const GEMINI_CAPS = {
  Thinking: 'reasoning',
  'Function calling': 'function_calling',
  'Structured outputs': 'structured_output',
  'Computer use': 'agentic',
  'Image generation': 'image_generation',
};

function capsIn(s) {
  const found = [];
  for (const [label, cap] of Object.entries(GEMINI_CAPS)) {
    // "Supported" must not match inside "Not supported".
    const m = new RegExp(`\\b${label}\\s+(Not supported|Supported)`, 'i').exec(s);
    if (m && !/^not/i.test(m[1])) found.push(cap);
  }
  return found;
}

const gemini = data.releases.filter((r) => r.company === 'Google DeepMind');
const endpoints = await endpointsFromIndex();
const aliases = await displayNames();
console.log(`${gemini.length} Google records · ${endpoints.length} per-model pages linked, ${aliases.size} display names mapped\n`);

let wrote = 0;
for (const r of gemini) {
  const ep = endpointFor(r.model, endpoints, aliases);
  // No linked page is the normal case for a retired model, not a failure.
  if (!ep) { console.log(`  · ${r.model.padEnd(24)} not served by the Gemini API`); continue; }
  const s = await specsFor(ep);
  if (s.error) { console.log(`  ~ ${r.model.padEnd(24)} ${ep} — ${s.error}`); continue; }

  const gaps = [];
  // Only fill what is empty. A figure already traced to a source outranks a
  // scrape of a page that may describe a later revision of the same endpoint.
  if (r.specifications?.language && r.specifications.language.context_window == null && s.context_window) {
    gaps.push(`context ${s.context_window.toLocaleString('en-US')}`);
    if (WRITE) r.specifications.language.context_window = s.context_window;
  }
  if (!r.modalities && s.modalities?.input.length) {
    gaps.push(`modalities in ${s.modalities.input.join('/')} out ${s.modalities.output.join('/')}`);
    if (WRITE) r.modalities = s.modalities;
  }
  const fresh = mergeCaps(r, s.caps ?? [], WRITE);
  if (fresh.length) gaps.push(`capabilities +${fresh.join(' +')}`);

  if (!gaps.length) { console.log(`  · ${r.model.padEnd(24)} nothing to add`); continue; }

  console.log(`  ✓ ${r.model.padEnd(24)} ${gaps.join(' · ')}`);
  wrote++;
  // The page becomes a cited source, not an invisible one. This reader got that
  // right from the start; citeDocs is that habit hoisted so the other three,
  // which cited sources[0] for values they read here, cannot get it wrong.
  if (WRITE) citeDocs(r, s.url, 'gdocs');
}

console.log(`\n${wrote} record${wrote === 1 ? '' : 's'} with something to add`);
if (WRITE && wrote) {
  saveDataset(data);
  console.log('wrote data/llm-releases.json');
} else if (!WRITE) {
  console.log('dry run — pass --write to record');
}
