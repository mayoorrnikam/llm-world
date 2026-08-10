#!/usr/bin/env node
/**
 * Pulls the evidence needed to verify records, and prints it for a human call.
 *
 *   node scripts/research-sources.mjs --need=modalities
 *   node scripts/research-sources.mjs --ids=gpt-4o,claude-3-opus
 *   node scripts/research-sources.mjs --need=modalities --out=review.md
 *
 * It fetches each record's ARCHIVED sources rather than the live URLs. Two
 * reasons, both important:
 *
 *   1. A snapshot proves what the page said when we cited it. The live page
 *      may have changed (docs/METHODOLOGY.md §6).
 *   2. ai.meta.com, openai.com, x.ai and ai.google.dev block automated fetches
 *      outright. web.archive.org does not, so the snapshot is often the ONLY
 *      way to read the primary source programmatically.
 *
 * This tool does NOT decide anything. It prints the sentences a source actually
 * contains, next to what the dataset currently claims, so a human can make the
 * call and record it with a citation. Nothing here writes to the dataset.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalDate, contextWindow, parameterCount } from '../lib/record.mjs';

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const NEED = arg('need');
const IDS = arg('ids')?.split(',').filter(Boolean);
const OUT = arg('out');
const CONCURRENCY = Number(arg('jobs') ?? 4);

/** What each research question needs to see in the source text. */
const PROBES = {
  modalities: ['accepts as input', 'any combination', 'input', 'output', 'audio', 'vision',
    'image', 'video', 'multimodal', 'text-only'],
  context: ['context window', 'context length', 'tokens of context', 'token context'],
  params: ['parameters', 'billion parameters', 'active parameters', 'total parameters'],
  reasoning: ['reasoning', 'thinking', 'chain of thought', 'extended thinking', 'thinks before'],
  date: ['released', 'announcing', 'available today', 'generally available'],
};

const targets = data.releases.filter((r) => {
  if (IDS) return IDS.includes(r.id);
  if (NEED === 'modalities') return r.modalities == null && r.tags.includes('multimodal');
  if (NEED === 'reasoning') return r.capabilities.includes('reasoning');
  if (NEED === 'context') return contextWindow(r) == null;
  return true;
});

if (!targets.length) {
  console.error('no records match — use --need=modalities|reasoning|context or --ids=a,b');
  process.exit(1);
}

/** Strip a page to readable text. No parser dependency; this is a research aid. */
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences containing any probe term, deduplicated and trimmed. */
function excerpts(text, probes, limit = 6) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const seen = new Set();
  const out = [];
  for (const s of sentences) {
    if (s.length < 30 || s.length > 400) continue;
    const low = s.toLowerCase();
    if (!probes.some((p) => low.includes(p))) continue;
    const key = low.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.trim());
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world research)' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: textOf(await res.text()) };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? 'timed out' : e.message };
  }
}

const probes = PROBES[NEED] ?? [...new Set(Object.values(PROBES).flat())];
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

say(`# Research sheet — ${NEED ?? 'all'} (${targets.length} records)`);
say();
say(`Generated ${new Date().toISOString().slice(0, 10)}. Excerpts are quoted from`);
say(`ARCHIVED snapshots, so each is checkable at the URL shown.`);
say();

let done = 0;
async function handle(r) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  const block = [];
  block.push(`## ${r.model}  \`${r.id}\``);
  block.push('');
  block.push(`- Recorded date: **${canonicalDate(r)}**`);
  block.push(`- Recorded context: ${contextWindow(r) ?? 'null'} · parameters: ${parameterCount(r) ?? 'null'}`);
  block.push(`- Recorded modalities: ${r.modalities ? JSON.stringify(r.modalities) : '**null**'}`);
  block.push(`- Capabilities: ${r.capabilities.join(', ') || '—'} · tags: ${r.tags.join(', ') || '—'}`);
  block.push(`- Status: ${r.provenance.status} (${r.provenance.confidence}/100)`);
  block.push('');

  if (!archived.length) {
    block.push('> **No archived primary source.** Cannot verify from a snapshot.');
    block.push('');
  }

  for (const s of archived) {
    const { text, error } = await fetchText(s.archived_url);
    block.push(`### ${s.type} — snapshot ${s.retrieved}`);
    block.push(`<${s.archived_url}>`);
    block.push('');
    if (error) {
      block.push(`> could not read: ${error}`);
    } else {
      const found = excerpts(text, probes);
      if (found.length) for (const f of found) block.push(`> ${f}`);
      else block.push(`> (no sentence matched: ${probes.slice(0, 4).join(', ')}…)`);
    }
    block.push('');
  }

  done++;
  process.stderr.write(`  ${done}/${targets.length} ${r.id}\n`);
  return block;
}

// Bounded concurrency — archive.org replay is slow, but four at a time is polite.
const queue = [...targets];
const results = new Map();
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) {
    const r = queue.shift();
    results.set(r.id, await handle(r));
  }
}));

for (const r of targets) for (const line of results.get(r.id) ?? []) say(line);

if (OUT) {
  writeFileSync(OUT, lines.join('\n') + '\n');
  process.stderr.write(`\nwrote ${OUT}\n`);
}
