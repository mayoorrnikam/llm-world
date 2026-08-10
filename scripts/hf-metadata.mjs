#!/usr/bin/env node
/**
 * Reads licence and modalities from Hugging Face model cards.
 *
 *   node scripts/hf-metadata.mjs           report
 *   node scripts/hf-metadata.mjs --write   record licence and modalities
 *
 * Any record already citing a huggingface.co model card has structured metadata
 * sitting behind it that nothing here was reading:
 *
 *   cardData.license   the licence the lab declares
 *   pipeline_tag       "image-text-to-text", "image-text-to-video", …
 *
 * Both are set by the lab on its own model card, so they are primary
 * declarations rather than inferences — a stronger signal than the prose the
 * modality detector has to work with, and the reason MiniMax M3 and H3 could be
 * recorded confidently while their announcements only said "multimodal".
 *
 * pipeline_tag is also the most reliable modality signal available: it names
 * inputs and output in a fixed vocabulary, with no sentence to misread. Where it
 * exists, it beats every heuristic in detect-modalities.mjs.
 *
 * Licence is only written for open-weights records. A licence on a proprietary
 * record is a category error, and apply-specs.mjs already refuses it.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hugging Face pipeline tags → modalities.
 *
 * The tag names input and output directly, which is why this is worth more than
 * any amount of prose matching. Tags that say nothing about modality — plain
 * "text-generation" covers both a text-only model and one that also reads
 * images — are deliberately absent, so they fall through to the detector rather
 * than being recorded from a tag that cannot carry the claim.
 */
const PIPELINE = {
  'text-to-text': { input: ['text'], output: ['text'] },
  'image-text-to-text': { input: ['text', 'image'], output: ['text'] },
  'image-to-text': { input: ['image'], output: ['text'] },
  'video-text-to-text': { input: ['text', 'video'], output: ['text'] },
  'audio-text-to-text': { input: ['text', 'audio'], output: ['text'] },
  'any-to-any': null, // Deliberately unmapped: "any" is not a modality list.
  'text-to-image': { input: ['text'], output: ['image'] },
  'image-text-to-video': { input: ['text', 'image'], output: ['video'] },
  'text-to-video': { input: ['text'], output: ['video'] },
  'text-to-speech': { input: ['text'], output: ['audio'] },
  'automatic-speech-recognition': { input: ['audio'], output: ['text'] },
  'text-to-audio': { input: ['text'], output: ['audio'] },
};

const hfRepo = (url) => {
  const m = /huggingface\.co\/([^/\s]+\/[^/\s?#]+)/.exec(url ?? '');
  return m ? m[1] : null;
};

const targets = data.releases
  .map((r) => ({ r, repo: r.sources.map((s) => hfRepo(s.url)).find(Boolean) }))
  .filter((t) => t.repo)
  // Only where something is actually missing.
  .filter((t) => t.r.modalities == null
    || (t.r.access.open_weights && !t.r.access.license));

console.log(`${targets.length} records cite a model card and are missing licence or modalities\n`);

let lic = 0, mods = 0, failed = 0;

for (const { r, repo } of targets) {
  let meta;
  try {
    const res = await fetch(`https://huggingface.co/api/models/${repo}`, {
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'llm-world hf-metadata' },
    });
    if (!res.ok) { failed++; console.log(`  ~ ${r.id} — HTTP ${res.status} for ${repo}`); continue; }
    meta = await res.json();
  } catch { failed++; console.log(`  ~ ${r.id} — could not read ${repo}`); continue; }

  const found = [];

  const license = meta?.cardData?.license;
  // "other" and "unknown" are Hugging Face's slugs for a custom or unstated
  // licence. Recording either as the licence name says less than null does,
  // and reads on the page as though we found something.
  const usable = license && !['other', 'unknown', 'unlicense'].includes(String(license).toLowerCase());
  if (usable && r.access.open_weights && !r.access.license) {
    // Hugging Face writes slugs; the dataset uses the licence's own name.
    const name = { 'apache-2.0': 'Apache-2.0', mit: 'MIT', 'bsd-3-clause': 'BSD-3-Clause',
      'cc-by-4.0': 'CC BY 4.0', 'cc-by-nc-4.0': 'CC BY-NC 4.0',
      'cc-by-sa-4.0': 'CC BY-SA 4.0', 'gemma': 'Gemma Terms of Use',
      'llama3.1': 'Llama 3.1 Community License', 'llama3.2': 'Llama 3.2 Community License',
      'llama4': 'Llama 4 Community License', 'openrail': 'OpenRAIL',
    }[String(license).toLowerCase()] ?? String(license);
    if (WRITE) r.access.license = name;
    found.push(`licence ${name}`);
    lic++;
  }

  const tag = meta?.pipeline_tag;
  const m = tag ? PIPELINE[tag] : undefined;
  if (m && r.modalities == null) {
    if (WRITE) {
      r.modalities = { input: [...m.input], output: [...m.output] };
      r.tags = r.tags.filter((t) => t !== 'multimodal');
      r.provenance.reason = `${(r.provenance.reason ?? '').trim()} Modalities from the `
        + `model card's own pipeline_tag "${tag}" on ${repo}.`.trim();
    }
    found.push(`modalities in ${m.input.join(',')} · out ${m.output.join(',')} (${tag})`);
    mods++;
  } else if (tag && m === undefined && r.modalities == null) {
    found.push(`pipeline_tag "${tag}" carries no modality claim — left for the detector`);
  }

  if (found.length) console.log(`  ${r.id.padEnd(22)} ${found.join('  ·  ')}`);
  await sleep(200);
}

console.log(`\nlicences recorded:  ${lic}`);
console.log(`modalities recorded: ${mods}`);
if (failed) console.log(`could not read:      ${failed}`);
console.log(WRITE ? `\nwrote ${FILE}` : `\ndry run — pass --write to record`);
