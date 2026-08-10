#!/usr/bin/env node
/**
 * One-shot: split the `nova` record into the models Amazon actually shipped.
 *
 *   node scripts/split-nova.mjs           report
 *   node scripts/split-nova.mjs --write   apply
 *
 * `nova` was one row standing for a whole family — Micro, Lite and Pro (text
 * out), Canvas (images) and Reel (video) — with the union of their modalities
 * and capabilities glued onto a single `language` classification. That breaks
 * S6 (one record per separately named, separately shipped model) and it is the
 * only record whose outputs no single type can honestly describe.
 *
 * Splitting it is also how the first non-language types arrive: not as a
 * research programme opened and then filled, but because a record already in
 * the dataset cannot be stated correctly without them.
 *
 * Every value below is quoted from the two archived AWS announcements already
 * cited by the original record. Nothing new is inferred.
 *
 * Nova Premier is deliberately NOT created: "Amazon Nova Premier is still in
 * training" on the announcement date, so it was announced, not shipped.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'data/llm-releases.json';
const WRITE = process.argv.includes('--write');

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const nova = data.releases.find((r) => r.id === 'nova');
if (!nova) { console.log('nova already split'); process.exit(0); }

const DATE = nova.events[0].date;
const SOURCES = nova.sources;

/** id, name, type, subtype, modalities, specs, capabilities, and the quote. */
const MODELS = [
  {
    id: 'nova-micro', model: 'Nova Micro',
    type: 'language', subtype: 'llm',
    input: ['text'], output: ['text'],
    language: { context_window: null, parameter_count: null },
    capabilities: [],
    note: "Amazon's lowest-latency Nova model, text in and text out.",
    quote: 'Amazon Nova Micro – A text-only model that delivers the lowest latency responses '
      + 'in the Amazon Nova family of models at a very low cost.',
  },
  {
    id: 'nova-lite', model: 'Nova Lite',
    type: 'language', subtype: 'llm',
    input: ['text', 'image', 'video'], output: ['text'],
    language: { context_window: null, parameter_count: null },
    capabilities: ['vision', 'video'],
    note: "Amazon's low-cost multimodal Nova model, reading images and video to produce text.",
    quote: 'Amazon Nova Lite – A very low-cost multimodal model that is lightning fast for '
      + 'processing image, video, and text inputs to generate text output.',
  },
  {
    id: 'nova-pro', model: 'Nova Pro',
    type: 'language', subtype: 'llm',
    // The 300K context recorded on the old family row belongs to Pro alone.
    input: ['text', 'image', 'video'], output: ['text'],
    language: { context_window: 300000, parameter_count: null },
    capabilities: ['vision', 'video', 'agentic', 'tool_use'],
    note: "Amazon's most capable shipped Nova understanding model, with a 300K-token context window.",
    quote: 'Amazon Nova Pro is capable of processing up to 300K input tokens and sets new '
      + 'standards in multimodal intelligence and agentic workflows.',
  },
  {
    id: 'nova-canvas', model: 'Nova Canvas',
    type: 'image_generation', subtype: null,
    input: ['text', 'image'], output: ['image'],
    language: null,
    capabilities: ['image_generation'],
    note: "Amazon's image generation model, with inpainting, outpainting and background editing.",
    quote: 'Amazon Nova Canvas – A state-of-the-art image generation model producing '
      + 'studio-quality images with precise control over style and content, including rich '
      + 'editing features such as inpainting, outpainting, and background removal.',
  },
  {
    id: 'nova-reel', model: 'Nova Reel',
    type: 'video_generation', subtype: null,
    input: ['text', 'image'], output: ['video'],
    language: null,
    capabilities: ['video_generation'],
    note: "Amazon's video generation model, producing short videos from text prompts and images.",
    quote: 'Amazon Nova Reel – A state-of-the-art video generation model. With Amazon Nova Reel, '
      + 'you can produce short videos through text prompts and images.',
  },
];

const built = MODELS.map((m) => ({
  id: m.id,
  model: m.model,
  company: nova.company,
  family: 'Nova',
  classification: { primary_type: m.type, subtype: m.subtype },
  modalities: { input: m.input, output: m.output },
  capabilities: m.capabilities,
  tags: [],
  note: m.note,
  events: [{ type: 'announcement', date: DATE, sources: SOURCES.map((s) => s.id) }],
  // Non-language models get no language bucket rather than a bucket of nulls:
  // an image model does not have an undisclosed context window, it has no
  // context window at all.
  specifications: m.language ? { language: m.language } : {},
  access: { open_weights: false, license: null },
  sources: SOURCES.map((s) => ({ ...s })),
  provenance: {
    status: 'verified',
    confidence: 90,
    reason: `Split from the former single "Nova" family record. Every value is quoted from `
      + `an archived AWS announcement: "${m.quote}"`,
  },
}));

// Amazon publishes no parameter counts for Nova, and the announcements state
// none — evidenced by having read them, so this is a disclosure fact.
for (const r of built) {
  if (r.specifications.language) r.undisclosed = ['parameter_count'];
}

const idx = data.releases.indexOf(nova);
data.releases.splice(idx, 1, ...built);

// The old /models/nova/ URL was public. It described the family, so it now
// points at the family page rather than at any one of the five.
data.redirects = [...(data.redirects ?? []), {
  from: 'models/nova',
  to: 'families/nova',
  reason: 'The "Nova" record described a family, not a model, and was split into its five '
    + 'shipped models. The family page lists them all.',
}];

console.log(`split nova into ${built.length} records:`);
for (const r of built) {
  console.log(`  ${r.id.padEnd(13)} ${r.classification.primary_type.padEnd(17)} `
    + `in ${r.modalities.input.join(',')} · out ${r.modalities.output.join(',')}`);
}
console.log(`\nNova Premier not created — "still in training" on the announcement date.`);
console.log(`releases: ${data.releases.length - built.length + 1} → ${data.releases.length}`);

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nwrote ${FILE}`);
} else {
  console.log(`\ndry run — pass --write to apply`);
}
