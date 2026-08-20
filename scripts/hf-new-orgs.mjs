#!/usr/bin/env node
/**
 * Labs shipping open weights that this project has never heard of.
 *
 *   node scripts/hf-new-orgs.mjs             orgs new to us, by traction
 *   node scripts/hf-new-orgs.mjs --days=30   widen the window
 *   node scripts/hf-new-orgs.mjs --all       include orgs we already watch
 *
 * WHY THIS EXISTS
 *
 * Every other channel here is derived from labs already in the dataset.
 * scan-labs reads documentation cited by our own records; check-providers reads
 * a catalogue keyed to models we hold; check-freshness iterates ORGS. Each is
 * good at "what did a lab we know about ship", and none of them can answer
 * "which lab appeared". A new lab is invisible by construction — the same shape
 * of bug as deriving a name pattern from names we already have, one level up.
 *
 * So this asks Hugging Face the question the other way round: what was
 * published recently by ANYONE, minus the orgs we already watch. The list is
 * what gets subtracted rather than what gets iterated, which is the whole
 * difference.
 *
 * WHAT IT IS NOT
 *
 * A discovery source (METHODOLOGY §5). An org here means "look at this". A
 * record still needs the lab's own announcement or model card, archived, and a
 * person. Nothing is written.
 *
 * Traction is a filter, not a judgement. Hugging Face receives thousands of
 * uploads a day, almost all of them re-quantisations of somebody else's
 * weights, so an unfiltered feed is noise with a lab hidden in it. Downloads
 * and likes are the cheapest available proxy for "somebody other than the
 * uploader cared", and they are deliberately not recorded anywhere — this
 * dataset holds what labs state, and a download count is neither stated nor
 * stable.
 */

import { readFileSync } from 'node:fs';
import { ORG_SET } from '../lib/hf-orgs.mjs';

if (process.argv.includes('--limit=0')) process.exit(0);

const ALL = process.argv.includes('--all');
const DAYS = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1]) || 21;
const MIN_LIKES = 12;
const MIN_DOWNLOADS = 400;

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const flat = (s) => String(s).toLowerCase().replace(/[\s._-]/g, '');

/** Companies we already track, so their org account is not news either. */
const tracked = new Set(data.releases.map((r) => flat(r.company)));

/**
 * Derivatives, which outnumber originals on Hugging Face by a wide margin.
 *
 * A quantisation, a format conversion or a fine-tune is somebody republishing a
 * model that already has a lab. Reporting them as new labs would bury the one
 * upload that is a lab.
 */
const DERIVATIVE = /(?:^|[-_.])(?:gguf|awq|gptq|exl2|exl3|mlx|onnx|openvino|bnb|int4|int8|fp8|fp4|w4a16|w8a8|quantized?|quant|4bit|8bit|abliterated|uncensored|lora|adapter|merge|merged|distill(?:ed)?|finetune[d]?|ft|sft|dpo|orpo|imatrix|smashed|neuralmagic)(?:[-_.]|$)/i;

/**
 * Accounts whose whole purpose is republishing other people's weights.
 *
 * The filename test catches `-GGUF` and `-AWQ`; it does not catch
 * `unsloth/Qwen3.8-27B`, which is a clean name for somebody else's model. These
 * orgs are prolific and well-liked, so without this they crowd out the actual
 * labs on every run — Comfy-Org alone arrived with 18 million downloads for
 * three repackages.
 */
const REPUBLISHER = new Set(['unsloth', 'comfy-org', 'thebloke', 'bartowski', 'mradermacher',
  'lmstudio-community', 'quantfactory', 'nousresearch', 'neuralmagic', 'redhatai',
  'modelscope', 'second-state', 'gaianet', 'tensorblock', 'featherless-ai',
  'mlx-community', 'ggml-org', 'onnx-community', 'cognitivecomputations']);

const RELEVANT = new Set(['text-generation', 'text2text-generation', 'image-text-to-text',
  'any-to-any', 'automatic-speech-recognition', 'text-to-image', 'text-to-video']);

const since = Date.now() - DAYS * 86400_000;

/**
 * Two sorts, because they answer different halves of the question.
 *
 * `createdAt` catches a lab that appeared this week and nobody has noticed yet;
 * `likes7d` catches one that appeared earlier and is only now being used. A
 * quiet launch and a slow burn both count as missing a lab.
 */
const FEEDS = [
  { sort: 'createdAt', label: 'newly published' },
  { sort: 'likes7d', label: 'gaining attention' },
];

async function page(sort) {
  const url = `https://huggingface.co/api/models?sort=${sort}&direction=-1&limit=300`
    + '&full=false&config=false';
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world source-reader)' },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Hugging Face answered ${res.status}`);
  return res.json();
}

const byOrg = new Map();
const problems = [];

for (const feed of FEEDS) {
  let rows;
  try { rows = await page(feed.sort); } catch (e) { problems.push(`${feed.sort}: ${e.message}`); continue; }

  for (const m of rows) {
    const id = m.modelId ?? m.id ?? '';
    const org = id.includes('/') ? id.split('/')[0] : null;
    // No org means a personal namespace with no account behind it.
    if (!org) continue;
    if (!ALL && (ORG_SET.has(org.toLowerCase()) || tracked.has(flat(org)))) continue;
    if (REPUBLISHER.has(org.toLowerCase())) continue;
    if (DERIVATIVE.test(id)) continue;
    if (m.pipeline_tag && !RELEVANT.has(m.pipeline_tag)) continue;

    const created = Date.parse(m.createdAt ?? m.lastModified ?? '');
    if (feed.sort === 'createdAt' && Number.isFinite(created) && created < since) continue;
    // A slow burn is worth catching; a 2023 model having a good week is not.
    // Sorting by likes7d put Stable Diffusion XL at the top of a report about
    // labs we have just missed.
    if (Number.isFinite(created) && created < Date.now() - 400 * 86400_000) continue;

    const likes = m.likes ?? 0;
    const downloads = m.downloads ?? 0;
    // Downloads, not likes-or-downloads. A like is one click and personal
    // accounts collect them for LoRAs and workflow files — froggeric, Kijai and
    // conradlocke all arrived with hundreds of likes and zero downloads. Weights
    // somebody actually ran is the signal worth having, and a lab too new to
    // clear the bar today clears it on a later run.
    if (downloads < MIN_DOWNLOADS || likes < MIN_LIKES) continue;

    const e = byOrg.get(org) ?? { org, models: [], likes: 0, downloads: 0, why: new Set() };
    e.models.push({ id, likes, downloads, created, tag: m.pipeline_tag ?? '—' });
    e.likes += likes;
    e.downloads += downloads;
    e.why.add(feed.label);
    byOrg.set(org, e);
  }
}

/* ------------------------------------------------------------------ report */

const orgs = [...byOrg.values()].sort((a, b) => (b.likes + b.downloads / 100) - (a.likes + a.downloads / 100));

console.log('## Labs on Hugging Face that this dataset does not watch\n');

if (problems.length) {
  console.log('### Hugging Face did not answer\n');
  for (const p of problems) console.log(`- ${p}`);
  console.log('\nAn unanswered query is not a quiet week.\n');
}

if (!orgs.length) {
  console.log(problems.length
    ? '_No result from the feeds that did answer._'
    : `_Nothing published in the last ${DAYS} days by an org outside the watch list `
      + `cleared ${MIN_LIKES} likes or ${MIN_DOWNLOADS} downloads._`);
} else {
  console.log(`${orgs.length} organisation${orgs.length === 1 ? '' : 's'} outside the watch list `
    + `published something in the last ${DAYS} days with real traction. `
    + `Candidates only — a record needs the lab's own card or announcement, archived, and a person.\n`);

  for (const e of orgs.slice(0, 12)) {
    const top = e.models.sort((a, b) => b.likes - a.likes).slice(0, 4);
    console.log(`**${e.org}** — ${e.models.length} model${e.models.length === 1 ? '' : 's'}, `
      + `${e.likes} likes, ${e.downloads.toLocaleString('en-US')} downloads (${[...e.why].join(', ')})`);
    for (const m of top) {
      console.log(`- \`${m.id}\` — ${m.tag}, ${m.likes} likes — https://huggingface.co/${m.id}`);
    }
    console.log();
  }
  if (orgs.length > 12) console.log(`_…and ${orgs.length - 12} more below the top twelve._\n`);
}

console.log('_Hugging Face is a discovery source, never a source of truth. Traction is a filter '
  + 'for noise, not evidence of anything, and is not recorded._');
