#!/usr/bin/env node
/**
 * Flags evidenced capabilities from primary sources.
 *
 *   node scripts/detect-capabilities.mjs            review sheet to stdout
 *   node scripts/detect-capabilities.mjs --context  with the sentences behind each flag
 *   node scripts/detect-capabilities.mjs --write    record Tier-1 capabilities
 *
 * Capability detection inverts the error budget of detect-modalities.mjs.
 * There, a false hit is harmless (the record stays null and a human looks) and
 * a missed hit is unacceptable (a multimodal model published as text-only).
 * Here a false hit WRITES a wrong positive claim about a model onto the site,
 * while a missed hit leaves a record under-claimed — and TAXONOMY §4 says an
 * unlisted capability means "not evidenced", never "absent", so under-claiming
 * is honest. This script is therefore deliberately CONSERVATIVE: it flags for
 * a person and writes almost nothing.
 *
 * The PaLM 2 trap is the norm, not the exception. Scanning primary sources for
 * capability words surfaces:
 *
 *   docs navigation   — "Research areas: Computer vision", sidebar "Images and vision"
 *   sibling models    — Amazon's Nova Micro announcement discusses Nova Premier,
 *                       Lite, Reel and Canvas at length (the Med-PaLM case)
 *   product prose     — a partner's "platform that transcribes audio" on Claude 1
 *   metaphors         — "our vision" on PaLM
 *   page boilerplate  — JSON error blobs, template chrome
 *
 * Tier 1 (auto-written) therefore requires ALL of:
 *   1. a strong, specific capability phrase (not a bare keyword),
 *   2. the sentence naming THIS model, not a sibling or the surrounding product,
 *   3. every primary source readable — no inference from a page we never opened.
 *
 * Everything else goes to the review sheet with --context so the person sees
 * the sentences, exactly like detect-modalities.
 *
 * Vocabulary: tool_use and function_calling stay separate tokens, mapped by the
 * source's literal wording ("use tools" vs "function calling"). long_context is
 * never written — it is derived, not evidenced.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { sourceText, FAILED } from '../lib/source-text.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
const CONTEXT = process.argv.includes('--context');

const CONCURRENCY = 6;

const data = JSON.parse(readFileSync(FILE, 'utf8'));

/** A capability, with the strong phrases that evidence it. */
const CAPABILITIES = [
  ['reasoning', /\breasoning\b/i],
  ['coding', /\bcode\s+(?:generation|completion|assistant|intelligence)\b|\bcoding\b/i],
  ['multilingual', /\bmultilingual\b|\b\d+\s+(?:more\s+)?languages\b|\bmany\s+languages\b/i],
  ['tool_use', /\btool\s+use\b|\buse\s+(?:external\s+)?tools?\b|\bcall\s+tools?\b|\buses\s+tools?\b/i],
  ['function_calling', /\bfunction\s+call(?:ing)?\b|\bfunction-call\b/i],
  ['structured_output', /\bstructured\s+(?:output|generation)\b|\bJSON\s+mode\b|\bjson\s+(?:output|response)\b/i],
  ['agentic', /\bagentic\b|\bagents?\b|\bautonomous\s+agent\b/i],
  ['vision', /\bvision[- ]language\b|\bvisual\s+(?:reasoning|understanding|question\s+answering|QA)\b|\bimage\s+understanding\b|\bimage\s+input\b|\btakes?\s+(?:input\s+)?images\b|\bcomputer\s+vision\b|\bimage\s+recognition\b/i],
  ['audio', /\baudio\s+(?:input|understanding|transcription|content)\b|\bspeech\s+(?:recognition|input)\b|\bprocess(?:ing)?\s+audio\b/i],
  ['speech_generation', /\btext[- ]to[- ]speech\b|\bspeech\s+(?:generation|synthesis|output)\b|\bspeak\s+aloud\b/i],
  ['image_generation', /\bimage\s+generation\b|\btext[- ]to[- ]image\b|\bimage\s+synthesis\b/i],
  ['video_generation', /\bvideo\s+generation\b|\btext[- ]to[- ]video\b/i],
  ['video', /\bvideo\s+(?:input|understanding|analysis|content)\b|\bprocess(?:ing)?\s+video\b|\bvideo\s+frames?\b/i],
];

/** Sentences that cannot be capability claims no matter what they contain. */
const NOT_A_CLAIM = [
  /\bour\s+vision\b|\bthis\s+vision\b|\bthe\s+vision\b|\bvision\s+of\b/i,       // metaphor
  /research\s+areas?:?\s*[-:]?\s*$|our\s+work\b/i,                              // nav fragment
  /\b(?:transcribes?|transcription)\b(?![^.]*model)/i,                          // partner product
  /\binstall|docker|setup|getting\s+started|quickstart\b/i,                     // docs chrome
];

/**
 * Future aspiration, not present capability. "Our goal in the near future is to
 * make Llama 3 multilingual" evidences nothing — the sentence itself says the
 * capability is not here yet.
 */
const FUTURE = [
  /\b(?:goal|plan|aim|hope|intend|expect|will|future)\b[^.]{0,80}\b(?:to\s+make|to\s+bring|to\s+add|to\s+deliver|to\s+support|make\s+\w+\s+multilingual|add\s+)\b/i,
  /\bin\s+the\s+(?:near\s+)?future\b/i,
  /\bcoming\s+(?:soon|later)\b/i,
  /\b(?:will|going\s+to)\s+(?:be\s+able\s+to|support|gain|add)\b/i,
];

/** Model lines that share a name with this record but are NOT this record. */
const SIBLING_LINES = [
  /\bNova\s+(?:Premier|Lite|Reel|Canvas|Pro)\b/i,
  /\bMed[- ]PaLM\b/i, /\bGemini\b/i, /\bDALL[- ][Ee]\b/i, /\bSora\b/i,
  /\bWhisper\b/i, /\bCodex\b/i, /\bTTS\b/i, /\bSTT\b/i,
  /\bGLM-4(?:-|_)\d/i,                                  // GLM-4-32B-0414 is a sibling variant
  /\bGLM-4\s+All\s+Tools\b/i,                           // distinct variant with its own tool model
];

const targets = data.releases.filter((r) => !r.capabilities?.length).slice(0, LIMIT);
console.log(`${targets.length} records without capabilities\n`);

const tier1 = [], flagged = [], unreadable = [], partial = [];
let done = 0;

/** The names this record is allowed to be called in its own sources. */
function ownNames(r) {
  const names = new Set([r.model, ...(r.previous_ids ?? [])]);
  // "Amazon Nova Micro" is claimed by "Nova Micro"; the family name alone is
  // not enough — it also names the siblings.
  const exact = [...names].sort((a, b) => b.length - a.length);
  return exact.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * The sentence can be about this model if it names the model, its family or its
 * lab — then the exclusions (siblings, nav, future, partner) decide the rest.
 * Recall here matters: this feeds the review sheet. Auto-write (--write) is
 * gated on the strict own-name match below.
 */
function gates(r) {
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const broad = new Set([r.model, r.family, r.company, ...(r.previous_ids ?? [])]);
  const narrow = new Set([r.model, ...(r.previous_ids ?? [])]);
  const re = (set) => new RegExp(`\\b(?:${[...set].sort((a, b) => b.length - a.length).map(esc).join('|')})\\b`, 'i');
  return { broad: re(broad), narrow: re(narrow) };
}

async function examine(r) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  const texts = [];
  let failures = 0;
  for (const s of archived) {
    const t = await sourceText(s.archived_url);
    if (t) texts.push(t); else failures++;
  }

  done++;
  process.stderr.write(`  ${done}/${targets.length} ${r.id}\n`);

  if (!texts.length) { unreadable.push(r.id); return; }
  if (failures) {
    partial.push(`${r.id} (${failures} of ${archived.length} sources unreadable)`);
    return;
  }

  // Sentence-scoped scan. Capability words in a page header or sidebar are
  // navigation, not a claim about the model.
  const { broad, narrow } = gates(r);
  const found = new Map();

  for (const t of texts) {
    const cleaned = t.replace(/<[^>]*>/g, ' ');
    for (const sentence of cleaned.match(/[^.!?\n]+[.!?]?/g) ?? []) {
      const s = sentence.replace(/\s+/g, ' ').trim();
      if (!s || s.length > 400) continue;
      if (NOT_A_CLAIM.some((p) => p.test(s))) continue;
      if (FUTURE.some((p) => p.test(s))) continue;
      if (SIBLING_LINES.some((p) => p.test(s))) continue;
      if (!broad.test(s)) continue; // not about this model, family or lab
      for (const [cap, re] of CAPABILITIES) {
        const m = s.match(re);
        if (m && !found.has(cap)) {
          // Auto-write only when the claim names THIS model, not just its family.
          found.set(cap, { quote: s.slice(0, 180), own: narrow.test(s) });
        }
      }
    }
  }

  if (!found.size) { flagged.push(`${r.id} — no capability claim found`); return; }

  const hits = [...found.entries()];
  tier1.push({ id: r.id, model: r.model, hits: hits.map(([c, v]) => `${c}${v.own ? '' : ' (family)'}`).join(', ') });
  if (WRITE) {
    for (const [cap, v] of hits) if (v.own && !r.capabilities.includes(cap)) r.capabilities.push(cap);
    const how = hits.filter(([, v]) => v.own).map(([c, v]) => `${c}: “${v.quote}”`).join(' | ');
    if (how) r.provenance.reason = `${(r.provenance.reason ?? '').trim()} Capabilities evidenced from the primary sources: ${how}.`.trim();
  }
  if (CONTEXT) {
    flagged.push(`${r.id} — ${hits.map(([c, v]) => `${c}${v.own ? '' : ' (family)'}`).join(', ')}\n${hits.map(([c, v]) => `      “${v.quote}”`).join('\n')}`);
  }
}

const queue = [...targets];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) await examine(queue.shift());
}));

console.log(`\nTIER 1 — a specific claim about this model, all sources read (${tier1.length}):`);
for (const t of tier1) console.log(`  ${t.id.padEnd(22)} ${t.model.padEnd(26)} ${t.hits}`);
console.log(`\nFLAGGED FOR A PERSON — review the sentences before recording (${flagged.length}):`);
for (const f of flagged) console.log(`  ${f}`);
if (partial.length) {
  console.log(`\nPARTIAL READ — not enough to evidence anything (${partial.length}):`);
  for (const p of partial) console.log(`  ${p}`);
}
if (unreadable.length) console.log(`\nNO READABLE SOURCE (${unreadable.length}): ${unreadable.join(', ')}`);

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record`);
}
