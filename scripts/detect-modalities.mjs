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

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');
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

/** An explicit denial is stronger than silence, and worth recording as such. */
const EXPLICIT_TEXT_ONLY = [
  /\bgenerate[s]? text only\b/i,
  /\btext[- ]only\b/i,
  /\bdoes\s?n[o']?t have other senses\b/i,
  /\binput and output text\b/i,
];

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world modality-check)' },
    });
    if (!res.ok) return null;
    return textOf(await res.text());
  } catch {
    return null;
  }
}

const targets = data.releases.filter((r) => r.modalities == null);
console.log(`${targets.length} records without modalities\n`);

const textOnly = [], flagged = [], unreadable = [];
let done = 0;

async function examine(r) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  const texts = [];
  for (const s of archived) {
    const t = await fetchText(s.archived_url);
    if (t) texts.push(t);
  }

  done++;
  process.stderr.write(`  ${done}/${targets.length} ${r.id}\n`);

  if (!texts.length) { unreadable.push(r.id); return; }

  const explicit = texts.some((t) => EXPLICIT_TEXT_ONLY.some((p) => p.test(t)));
  const hint = MULTIMODAL_HINTS.find((p) => texts.some((t) => p.test(t)));

  if (hint && !explicit) {
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

console.log(`\nTEXT-ONLY — no non-text modality anywhere in the primary sources: ${textOnly.length}`);
console.log(`  of which explicitly stated as text-only: ${textOnly.filter((t) => t.explicit).length}`);
console.log(`\nLEFT FOR A PERSON — something multimodal is mentioned (${flagged.length}):`);
for (const f of flagged) console.log(`  ${f}`);
if (unreadable.length) console.log(`\nNO READABLE SOURCE (${unreadable.length}): ${unreadable.join(', ')}`);

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to record`);
}
