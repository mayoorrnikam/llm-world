#!/usr/bin/env node
/**
 * Establishes text-only modalities from what the primary sources do NOT claim.
 *
 *   node scripts/detect-modalities.mjs           report
 *   node scripts/detect-modalities.mjs --write   record modalities
 *
 * Most text-only models never state their modalities. Being text-only was
 * unremarkable, so nobody wrote it down — while multimodality was always a
 * headline. That asymmetry is the evidence: when a lab's announcement, model
 * card and documentation mention no image, audio or video capability anywhere,
 * the model is text-in, text-out.
 *
 * This is the same reasoning already used for undisclosed[] — silence across
 * the primary sources is a finding, not an absence of one — but it is a claim
 * about the MODEL rather than about the lab's disclosure, so the error
 * direction matters much more.
 *
 * Therefore the multimodal patterns below are deliberately over-broad:
 *
 *   a false hit   → record left null → a human looks. Costs nothing.
 *   a missed hit  → model wrongly published as text-only. Unacceptable.
 *
 * PaLM 2 is the case that proves the point: its announcement discusses
 * multimodality at length — of Med-PaLM and of Gemini, not of PaLM 2. A
 * narrower scan would have published PaLM 2 as text-only. Here it trips the
 * filter and is left for a person, which is the right outcome even though the
 * reason the filter fired is wrong.
 *
 * Records whose sources cannot be read are never touched.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
// One reader for every script: HTML, PDF and client-rendered pages, cached on
// disk so a full pass fetches each source once rather than five times.
import { sourceText, FAILED } from '../lib/source-text.mjs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

// Print the sentences behind a flag, for the records the detector refuses to
// decide on its own.
const CONTEXT = process.argv.includes('--context');

const CONCURRENCY = 6;

const data = JSON.parse(readFileSync(FILE, 'utf8'));

/** Any hint of a non-text modality. Over-broad on purpose — see the header. */
const MULTIMODAL_HINTS = [
  /\bmultimodal\b/i, /\bmulti-modal\b/i,
  /\bvision\b/i, /\bvisual\b/i, /\bimage[s]?\b/i, /\bphoto/i, /\bpicture/i,
  /\baudio\b/i, /\bspeech\b/i, /\bvoice\b/i, /\bsound\b/i,
  /\bvideo\b/i, /\bframe[s]? of\b/i,
  /\bOCR\b/, /\bchart[s]?\b/i, /\bdiagram[s]?\b/i, /\bscreenshot/i,
  /\bsee\s+(?:an?\s+)?image/i, /\blook at\b/i,
];

/**
 * Pass 1 — a structured declaration, which beats any inference.
 *
 * Documentation pages state modalities in a small table rather than in prose,
 * which is why a prose probe misses them entirely:
 *
 *   OpenAI          "Input Text, image  Output Text"
 *   Hugging Face    "Input modalities … Output modalities …"
 *
 * Matching is deliberately tight. Docs navigation is full of phrases like
 * "Images and vision" and "Audio and speech", so a loose pattern would read the
 * sidebar as a capability declaration for the model.
 */
// Global, because a docs page mentions "input"/"output" many times before the
// real declaration — in navigation, pricing and prose. Every candidate is tried
// and parseModalities decides which one is actually a declaration.
// The list is bounded to modality words themselves rather than "any letters".
// A looser bound lets the match run past the declaration into whatever follows
// — Gemini's page reads "Output Text token_auto", and a letters-based capture
// swallows "token", which then fails to parse and the whole declaration is lost.
// Declarations capitalise the FIRST item and often lowercase the rest —
// "Inputs Audio, images, video, text, and PDF". So the first term must be
// capitalised and later ones need not be.
//
// The first term stays case-sensitive on purpose. Relaxing it would let
// ordinary prose — "the input text and output text" — parse as a text-only
// declaration, which is the one error this must never make: publishing a
// multimodal model as text-only.
const TERM_CAP = '(?:Text|Image|Images|Audio|Video|Speech|PDF|PDFs)';
const TERM_ANY = '(?:[Tt]ext|[Ii]mages?|[Aa]udio|[Vv]ideo|[Ss]peech|PDFs?)';
const LIST = `(${TERM_CAP}(?:\\s*(?:,|and|or|,\\s*and)\\s*${TERM_ANY})*)`;
const DECLARATION = [
  new RegExp(`\\bInputs?\\s+modalities?\\s*:?\\s*${LIST}\\s+Outputs?\\s+modalities?\\s*:?\\s*${LIST}`, 'g'),
  new RegExp(`\\bInputs?\\b\\s*:?\\s*${LIST}\\s+Outputs?\\b\\s*:?\\s*${LIST}`, 'g'),
];

const MODALITY_WORD = { text: 'text', image: 'image', images: 'image', audio: 'audio', video: 'video' };
/** Words allowed inside a declaration that are not themselves modalities. */
const IGNORABLE = new Set(['and', 'or', 'pdf', 'pdfs', 'document', 'documents', '']);

/**
 * "Text, Image, Video, Audio, and PDF" → ["text","image","video","audio"].
 *
 * Returns null if the span contains anything that is not a modality or a known
 * connector. That check is what separates a declaration from ordinary prose:
 * without it, "…the input prompt and the output text…" would parse as one.
 */
function parseModalities(s) {
  const out = [];
  for (const raw of s.split(/\s*(?:,|\band\b|\bor\b|\/)\s*/)) {
    const w = raw.trim().toLowerCase();
    if (IGNORABLE.has(w)) continue;
    const m = MODALITY_WORD[w];
    if (!m) return null;
    if (!out.includes(m)) out.push(m);
  }
  return out.length ? out : null;
}

function declaredModalities(texts) {
  for (const t of texts) {
    for (const p of DECLARATION) {
      for (const m of t.matchAll(p)) {
        const input = parseModalities(m[1]);
        const output = parseModalities(m[2]);
        if (input && output) return { input, output, quote: m[0].slice(0, 120) };
      }
    }
  }
  return null;
}

/**
 * Senses of a hint word that cannot denote a modality.
 *
 * Running the detector across every lab showed the same two records blocked by
 * the same sentence shape: AI21 Jamba 1.5 and Mistral Small 3 were both flagged
 * for /image/ by their model cards' install instructions — "use the docker
 * image supplied by them", "a ready-to-go docker image". Neither model card
 * mentions a visual modality anywhere.
 *
 * Only exclusions this narrow are safe. Suppressing a hint risks publishing a
 * multimodal model as text-only, which is the one error this script must never
 * make, so the bar is that the phrase CANNOT refer to a modality in any
 * context. "docker image" clears it. A benchmark name like MMMU does not — a
 * lab that benchmarks on MMMU usually does take images, so those stay flagged.
 */
const NOT_A_MODALITY = [
  /\bdocker\s+image\b/gi, /\bcontainer\s+image\b/gi, /\bimage\s+supplied\b/gi,
  /\bdocker\s+hub\b/gi, /\bimage\s+registry\b/gi, /\bdisk\s+image\b/gi,
];

/** An explicit denial is stronger than silence, and worth recording as such. */
const EXPLICIT_TEXT_ONLY = [
  /\bgenerate[s]? text only\b/i,
  /\btext[- ]only\b/i,
  /\bdoes\s?n[o']?t have other senses\b/i,
  /\binput and output text\b/i,
];



const targets = data.releases.filter((r) => r.modalities == null).slice(0, LIMIT);
console.log(`${targets.length} records without modalities\n`);

const textOnly = [], flagged = [], unreadable = [], declaredHits = [], partial = [];
let done = 0;

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

  // Pass 1: the source states the modalities outright. Nothing to infer.
  const declared = declaredModalities(texts);
  if (declared) {
    declaredHits.push(`${r.id}: in ${declared.input.join(', ')} · out ${declared.output.join(', ')}`);
    if (WRITE) {
      r.modalities = { input: declared.input, output: declared.output };
      r.tags = r.tags.filter((t) => t !== 'multimodal');
      r.provenance.reason = `${(r.provenance.reason ?? '').trim()} Modalities taken from the `
        + `documentation's own declaration: "${declared.quote.trim()}".`.trim();
    }
    return;
  }

  // Pass 2 infers from silence, so it needs ALL the sources. Concluding
  // "text-only" after reading two of a record's three sources means concluding
  // it from a page we never opened — the unread one could be the model card
  // that documents vision. A positive declaration (pass 1) is self-sufficient
  // and therefore exempt; an inference from absence is not.
  if (failures) {
    partial.push(`${r.id} (${failures} of ${archived.length} sources unreadable)`);
    return;
  }

  const explicit = texts.some((t) => EXPLICIT_TEXT_ONLY.some((p) => p.test(t)));
  // Blank the senses that cannot be a modality before looking for hints.
  const scanned = texts.map((t) => NOT_A_MODALITY.reduce((s, p) => s.replace(p, ' '), t));
  const hint = MULTIMODAL_HINTS.find((p) => scanned.some((t) => p.test(t)));

  if (hint && !explicit) {
    // --context prints the sentences that tripped the filter. "Left for a
    // person" is only actionable if the person can see what the source says;
    // without it the next step is re-fetching every page by hand, which is how
    // these records came to sit unresolved. PaLM 2 is the case to keep in mind:
    // the sentences show the multimodality discussed is Gemini's, not its own.
    if (CONTEXT) {
      const seen = new Set();
      for (const t of scanned) {
        for (const m of t.matchAll(new RegExp(`[^.]{0,110}${hint.source}[^.]{0,110}\\.`, 'gi'))) {
          const line = m[0].replace(/\s+/g, ' ').trim();
          if (!seen.has(line) && seen.size < 3) { seen.add(line); }
        }
      }
      flagged.push(`${r.id} (matched ${hint})\n${[...seen].map((l) => `      “${l}”`).join('\n')}`);
      return;
    }
    flagged.push(`${r.id} (matched ${hint})`);
    return;
  }

  textOnly.push({ id: r.id, explicit });
  if (WRITE) {
    r.modalities = { input: ['text'], output: ['text'] };
    // Say how this was established, so a reader can weigh it.
    const how = explicit
      ? 'The primary source states the model is text-only.'
      : 'No image, audio or video capability appears anywhere in the primary sources, '
        + 'which labs advertise prominently when present.';
    r.provenance.reason = `${(r.provenance.reason ?? '').trim()} Modalities recorded as text-to-text. ${how}`.trim();
  }
}

const queue = [...targets];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) await examine(queue.shift());
}));

console.log(`\nDECLARED — the documentation states the modalities (${declaredHits.length}):`);
for (const d of declaredHits) console.log(`  ${d}`);
console.log(`\nTEXT-ONLY — no non-text modality anywhere in the primary sources: ${textOnly.length}`);
console.log(`  of which explicitly stated as text-only: ${textOnly.filter((t) => t.explicit).length}`);
console.log(`\nLEFT FOR A PERSON — something multimodal is mentioned (${flagged.length}):`);
for (const f of flagged) console.log(`  ${f}`);
if (partial.length) {
  console.log(`\nPARTIAL READ — not enough to infer from silence (${partial.length}):`);
  for (const p of partial) console.log(`  ${p}`);
}
if (unreadable.length) console.log(`\nNO READABLE SOURCE (${unreadable.length}): ${unreadable.join(', ')}`);

if (WRITE) {
  saveDataset(data);
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record`);
}
