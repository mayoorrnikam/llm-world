#!/usr/bin/env node
/**
 * Weekly freshness check. Writes a markdown report to stdout.
 *
 *   node scripts/check-freshness.mjs           report to stdout
 *   node scripts/check-freshness.mjs --quiet   only report if something is due
 *
 * Two signals, because neither is sufficient alone:
 *
 *   1. AGE — how long since `updated` moved. Cheap, and the honest measure of
 *      drift: this dataset went 15 releases stale in three months with nobody
 *      watching.
 *   2. CANDIDATES — new repos from a whitelist of official lab accounts on
 *      Hugging Face, diffed against what we already track.
 *
 * Hugging Face is a DISCOVERY source, never a source of truth. It also cannot
 * see the labs that never publish weights — OpenAI, Anthropic, Google's Gemini
 * line, xAI — so the report always prompts a manual check of those. A quiet
 * report does not mean nothing shipped.
 */

import { readFileSync } from 'node:fs';

const QUIET = process.argv.includes('--quiet');
const STALE_DAYS = 14;

/** Official lab accounts. Anything outside this list is community noise. */
/**
 * The list was hand-written and covered only labs already in the dataset, so it
 * could never surface a lab we were missing — it confirmed what we knew.
 *
 * It is now derived. Epoch AI's notable-models database (CC BY 4.0) names the
 * labs shipping language models; every slug below was then checked against
 * huggingface.co/api/models, so none is a guess. THUDM and CohereForAI came
 * back empty because those orgs moved to zai-org and CohereLabs, which were
 * already here.
 *
 * A model card published by a lab's own org is that lab's own document, so this
 * is the one route where discovery and citation are the same page.
 *
 * Re-derive with: node scripts/discover-epoch.mjs --labs
 */
const ORGS = [
  // Already tracked in the dataset.
  'meta-llama', 'mistralai', 'deepseek-ai', 'Qwen', 'google', 'microsoft',
  'nvidia', 'CohereLabs', 'zai-org', 'moonshotai', 'ai21labs', 'openai',
  'xai-org', 'allenai',

  // Labs Epoch lists that this dataset does not cover at all.
  'ByteDance-Seed', 'tencent', 'apple', 'XiaomiMiMo', 'baidu', 'stepfun-ai',
  'MiniMaxAI', 'inclusionAI', 'internlm', 'OpenGVLab', 'Skywork', 'Tele-AI',
  'LGAI-EXAONE', 'upstage', 'skt', 'naver-hyperclovax', 'Motif-Technologies',
  'tiiuae', 'ibm-granite', 'arcee-ai', 'sarvamai', 'utter-project', 'PleIAs',
];

/** Labs with no meaningful Hugging Face presence — this check is blind to them. */
const BLIND_SPOTS = ['OpenAI (frontier)', 'Anthropic', 'Google (Gemini)', 'xAI (frontier)', 'Meta (Muse)'];

/** Quantisations and format conversions are not releases. */
const NOISE = /gguf|awq|gptq|-int[48]|fp8|fp4|nvfp|mxfp|-4bit|-8bit|bnb|mlx|onnx|openvino|-lora|draft/i;

/** Neither are non-LLM artefacts from the same orgs: speech, music, image
 *  generation, embeddings, benchmarks and safety classifiers. Multimodal
 *  language models ARE in scope, so vision-language names are left alone. */
const OFF_TOPIC = /tokenizer|embed|rerank|whisper|asr|tts|voice|speech|magenta|music|audio|diffusion|bench|eval|tabfm|tabular|guard|shield|safet|moderat|clip|vae|dataset/i;

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const known = data.releases;

/* ------------------------------------------------------------------- age */

const updated = Date.parse(`${data.updated}T00:00:00Z`);
const ageDays = Math.floor((Date.now() - updated) / 86400000);

/* ------------------------------------------------------------ candidates */

/** Loose match: strip punctuation so "Llama-3.1-405B" meets "Llama 3.1". */
const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const knownKeys = known.map((r) => key(r.model));
const seenBefore = (name) => {
  const k = key(name.split('/').pop());
  return knownKeys.some((kk) => k.includes(kk) || kk.includes(k));
};

async function candidatesFor(org) {
  const url = `https://huggingface.co/api/models?author=${encodeURIComponent(org)}`
            + '&sort=createdAt&direction=-1&limit=25&full=false';
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'llm-world freshness check' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { org, error: `HTTP ${res.status}`, models: [] };
    const list = await res.json();
    const models = list
      .filter((m) => m.createdAt && Date.parse(m.createdAt) > updated)
      .filter((m) => !NOISE.test(m.id) && !OFF_TOPIC.test(m.id))
      .filter((m) => !seenBefore(m.id))
      .map((m) => ({ id: m.id, created: m.createdAt.slice(0, 10), likes: m.likes ?? 0 }))
      .sort((a, b) => b.likes - a.likes)
      .slice(0, 6);
    return { org, models };
  } catch (e) {
    return { org, error: e.name === 'TimeoutError' ? 'timed out' : e.message, models: [] };
  }
}

const results = await Promise.all(ORGS.map(candidatesFor));
const found = results.filter((r) => r.models.length);
const errors = results.filter((r) => r.error);
const total = found.reduce((n, r) => n + r.models.length, 0);

/* ---------------------------------------------------------------- report */

const stale = ageDays >= STALE_DAYS;
if (QUIET && !stale && !total) {
  console.log(`fresh: updated ${ageDays}d ago, no new candidates`);
  process.exit(0);
}

const out = [];
out.push(`**Dataset last updated ${data.updated}** — ${ageDays} day${ageDays === 1 ? '' : 's'} ago`
       + `${stale ? ' ⚠️ **stale**' : ''}`);
out.push('');
out.push(`Tracking ${known.length} releases across ${new Set(known.map((r) => r.company)).size} labs.`);
out.push('');

if (total) {
  out.push(`## ${total} possible new release${total === 1 ? '' : 's'} on Hugging Face`);
  out.push('');
  out.push('Candidates only — **verify each against the lab\'s own announcement** before adding.');
  out.push('');
  for (const { org, models } of found) {
    out.push(`**${org}**`);
    for (const m of models) {
      out.push(`- [\`${m.id}\`](https://huggingface.co/${m.id}) — created ${m.created}, ${m.likes} likes`);
    }
    out.push('');
  }
} else {
  out.push('## No new Hugging Face candidates');
  out.push('');
}

out.push('## Check these by hand');
out.push('');
out.push('This scan is structurally blind to labs that do not publish weights:');
out.push('');
for (const b of BLIND_SPOTS) out.push(`- ${b}`);
out.push('');
out.push('A quiet report does **not** mean nothing shipped.');

if (errors.length) {
  out.push('');
  out.push(`<sub>Could not reach: ${errors.map((e) => `${e.org} (${e.error})`).join(', ')}</sub>`);
}

out.push('');
out.push('---');
out.push('<sub>To update: edit `data/llm-releases.json`, bump `updated`, and push. '
       + 'CI validates, rebuilds and deploys. Close this issue when done.</sub>');

console.log(out.join('\n'));
