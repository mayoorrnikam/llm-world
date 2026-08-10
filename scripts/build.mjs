#!/usr/bin/env node
/**
 * Generates the static pages that the single-page app can't provide:
 * indexable, no-JS-required pages for every model, company and year.
 *
 *   node scripts/build.mjs             pages + sitemap
 *   node scripts/build.mjs --export    ALSO write api/*.json and the CSV
 *   node scripts/build.mjs --check     build to a temp dir and diff (CI use)
 *
 * Bulk export is OFF by default: publishing machine-readable copies of the
 * whole dataset is a deliberate decision, not a build side effect.
 *
 * Output is committed to the repo so GitHub Pages serves it with no build
 * step in the deploy path. CI re-runs this with --check so the committed
 * pages can never drift from data/llm-releases.json.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  dateParts, displayTags, contextWindow, parameterCount, tagLabel,
  SOURCE_LABEL, AUTHORITY_LABEL,
} from '../lib/record.mjs';

const EXPORT = process.argv.includes('--export');
const CHECK = process.argv.includes('--check');
const OUT = CHECK ? '.build-check' : '.';
const BASE_URL = 'https://mayoorrnikam.github.io/llm-world';

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/** The dataset as authored (schema 1.6). What --export publishes. */
const rawReleases = data.releases;

/**
 * The dataset as these templates read it: the 1.6 record plus the facts derived
 * from it — canonical date, display tags, flattened language specs.
 *
 * Derived here rather than stored in the JSON so there is exactly one
 * definition of each (docs/METHODOLOGY.md §4), shared with the browser app
 * through lib/record.mjs.
 */
const releases = rawReleases.map((r) => ({
  ...r,
  ...dateParts(r),
  // `tags` is the composed display list (capabilities + derived + editorial),
  // which is what the chips and filters read. `editorial` keeps our own
  // judgements addressable on their own, so exports can separate them.
  tags: displayTags(r),
  editorial: [...(r.tags ?? [])],
  technical: { context_window: contextWindow(r), parameter_count: parameterCount(r) },
}));

/* ------------------------------------------------------------------ shared */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const ERAS = [[2022, 'Pre-ChatGPT scaling'], [2023, 'The assistant boom'],
  [2024, 'Multimodal & open weights'], [2025, 'Reasoning models'], [2026, 'Agentic systems']];
const eraFor = (y) => ERAS.reduce((acc, [yr, n]) => (y >= yr ? n : acc), ERAS[0][1]);

const COMPANY_VAR = {
  'AI21 Labs': 'ai21', Anthropic: 'anthropic', 'Mistral AI': 'mistral',
  'Alibaba Qwen': 'alibaba', Amazon: 'amazon', NVIDIA: 'nvidia', BigScience: 'bigscience',
  OpenAI: 'openai', Microsoft: 'microsoft', xAI: 'xai', 'Google DeepMind': 'google',
  DeepSeek: 'deepseek', 'Meta AI': 'meta', 'Moonshot AI': 'moonshot', 'Zhipu AI': 'zhipu',
  Cohere: 'cohere',
};
const slugFor = (c) => COMPANY_VAR[c] ?? 'other';
const companySlug = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const esc = (s) => String(s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const fullDate = (r) => `${MONTHS[r.month - 1]}${r.day ? ` ${r.day}` : ''}, ${r.year}`;
const isoDate = (r) => `${r.year}-${String(r.month).padStart(2, '0')}` +
  (r.day ? `-${String(r.day).padStart(2, '0')}` : '');

// SOURCE_LABEL is imported from lib/record.mjs so the static pages and the
// browser app cannot describe the same source differently.
const PROV_LABEL = {
  verified: 'verified', partially_verified: 'partly verified',
  unverified: 'unverified', conflicting: 'conflicting', estimated: 'approximate date',
};

// Single source of truth for logos: pull the sprite out of index.html rather
// than keeping a second copy here.
const indexHtml = readFileSync('index.html', 'utf8');
const SPRITE = Object.fromEntries(
  [...indexHtml.matchAll(/<g id="(ic-[a-z0-9]+)"[\s\S]*?<\/g>/g)]
    .map((m) => [m[1], m[0]]));

/* Shared chrome, lifted verbatim out of index.html between the
   shared:header / shared:footer markers. Extracting it rather than keeping a
   second copy here is the whole point: the app and the generated pages cannot
   drift apart, which is exactly what went wrong before. */
const slice = (name) => {
  const a = indexHtml.indexOf(`<!-- shared:${name}-start`);
  const b = indexHtml.indexOf(`<!-- shared:${name}-end -->`);
  if (a < 0 || b < 0) throw new Error(`missing shared:${name} markers in index.html`);
  return indexHtml.slice(indexHtml.indexOf('-->', a) + 3, b).trim();
};
const SHARED_HEADER = slice('header');
const YEAR_LINKS = (up) => [...new Set(releases.map((r) => r.year))]
  .sort((a, b) => b - a)
  .map((y) => `<a href="${up}timeline/${y}/">${y}</a>`).join('');
const SHARED_FOOTER = slice('footer');

/** Re-point the shared chrome's root-relative links for a nested page, and
 *  mark the section this page belongs to as current. */
function chrome(html, up, section = '') {
  let out = html.replace(/href="(?!https?:|#|mailto:)([^"]*)"/g,
    (_, href) => `href="${up}${href === './' ? '' : href}"`);
  out = out.replace(/ aria-current="page"/g, '');
  // Scoped to the nav on purpose: the brand link resolves to the same href as
  // Timeline, so an unscoped match marks the logo instead of the section.
  return out.replace(/<nav class="main-nav"[\s\S]*?<\/nav>/, (nav) => {
    const target = `href="${up}${section}"`;
    return nav.includes(target) ? nav.replace(target, `${target} aria-current="page"`) : nav;
  });
}

/** Inline only the logos a page actually uses — keeps each page ~2KB, not 20KB. */
const spriteFor = (slugs) => `<svg class="sprite" aria-hidden="true" focusable="false"><defs>${
  [...new Set(slugs)].map((s) => SPRITE[`ic-${s}`] ?? SPRITE['ic-other']).join('')}</defs></svg>`;

const glyph = (company) =>
  `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ` +
  `style="--c:var(--c-${slugFor(company)})"><use href="#ic-${slugFor(company)}"></use></svg>`;

/** 405000000000 -> "405B". Raw digits are unreadable at a glance. */
const params = (n) => n == null ? 'Not disclosed'
  : n >= 1e12 ? `${+(n / 1e12).toFixed(2)}T`
  : n >= 1e9 ? `${+(n / 1e9).toFixed(n < 1e10 ? 1 : 0)}B`
  : n >= 1e6 ? `${Math.round(n / 1e6)}M` : String(n);

const tokens = (n) => n == null ? 'Not disclosed'
  : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M tokens`
  : `${Math.round(n / 1000)}K tokens`;

const daysBetween = (a, b) => Math.round(
  (Date.UTC(b.year, b.month - 1, b.day || 1) - Date.UTC(a.year, a.month - 1, a.day || 1)) / 86400000);

/* ------------------------------------------------- schema 1.6 presentation */

const sentence = (s) => String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const capLabel = (c) => sentence(c);

/** "Language model · LLM" — the classification, spelled out. */
const TYPE_LABEL = (c) => {
  if (!c || c.primary_type === 'unknown') return 'Not classified';
  const primary = c.primary_type === 'language' ? 'Language model' : sentence(c.primary_type);
  const sub = { llm: 'LLM', slm: 'Small language model', reasoning: 'Reasoning model',
    embedding: 'Embedding model', reranker: 'Reranker' }[c.subtype];
  return sub ? `${primary} · ${sub}` : primary;
};

/** null modalities mean "not researched" — never render that as "text only". */
const modalityText = (r) => {
  const m = r.modalities;
  if (!m) return 'Not recorded';
  return `${m.input.map(sentence).join(' + ')} → ${m.output.map(sentence).join(' + ')}`;
};

const EVENT_LABEL = {
  announcement: 'Announced', paper: 'Paper published',
  public_availability: 'Publicly available', api_availability: 'Available via API',
  weights_availability: 'Weights published', major_update: 'Major update',
  retirement: 'Retired',
};

const eventDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]}${d ? ` ${d}` : ''}, ${y}`;
};

/** Previous release from the same lab. */
const predecessorOf = (r) => releases
  .filter((x) => x.company === r.company && x.id !== r.id && daysBetween(x, r) > 0).at(-1);

/* -------------------------------------------------------------------- shell */

function page({ title, description, canonical, depth, sprites, body, jsonld, section, head = '' }) {
  const up = '../'.repeat(depth);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#0e131c" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f7f8fa" media="(prefers-color-scheme: light)">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<link rel="icon" href="${up}favicon.svg">
<link rel="stylesheet" href="${up}styles.css">
<script>try{var t=localStorage.getItem('llm-world-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>
<script defer>
addEventListener('DOMContentLoaded',function(){
  var b=document.getElementById('theme-toggle');if(!b)return;
  var order=['system','light','dark'];
  var now=localStorage.getItem('llm-world-theme');
  now=(now==='light'||now==='dark')?now:'system';
  function set(m){
    if(m==='system'){document.documentElement.removeAttribute('data-theme');localStorage.removeItem('llm-world-theme');}
    else{document.documentElement.dataset.theme=m;localStorage.setItem('llm-world-theme',m);}
    b.dataset.themeState=m;b.setAttribute('aria-label','Colour theme: '+m);now=m;
  }
  set(now);
  b.addEventListener('click',function(){set(order[(order.indexOf(now)+1)%3]);});
});
</script>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
${head}
</head>
<body class="doc">
${spriteFor(sprites)}
<header class="site-header">
${chrome(SHARED_HEADER, up, section)}
</header>
<main class="doc-main">
${body}
</main>
${chrome(SHARED_FOOTER, up, '').replace('id="foot-yearlinks"></div>',
  `id="foot-yearlinks">${YEAR_LINKS(up)}</div>`).replace(
  'loading <code>data/llm-releases.json</code>…',
  `${releases.length} releases · updated ${esc(data.updated)}`)}
</body>
</html>
`;
}

const write = (path, html) => {
  const dir = join(OUT, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
};

/* --------------------------------------------------------------- templates */

function modelPage(r) {
  const prev = predecessorOf(r);
  const fam = releases.filter((x) => x.family === r.family).sort((a, b) => a.year - b.year || a.month - b.month || (a.day || 0) - (b.day || 0));
  const idx = fam.findIndex((x) => x.id === r.id);

  const facts = [
    ['Released', fullDate(r)],
    ['Company', r.company],
    ['Family', r.family],
    ['Era', eraFor(r.year)],
    ['Type', r.kind === 'product' ? 'Product' : TYPE_LABEL(r.classification)],
    ['Modalities', modalityText(r)],
    ['Capabilities', r.capabilities.length ? r.capabilities.map(capLabel).join(', ') : 'Not recorded'],
    ['Weights', r.access.open_weights ? 'Open weights' : 'Proprietary'],
    ['Licence', r.access.license ?? 'Not recorded'],
    ['Context window', tokens(r.technical.context_window)],
    ['Parameters', params(r.technical.parameter_count)],
  ];

  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <a href="../../companies/${companySlug(r.company)}/">${esc(r.company)}</a> › <span>${esc(r.model)}</span></nav>

<div class="doc-hero">
  <span class="doc-mark">${glyph(r.company)}</span>
  <div>
    <h1>${esc(r.model)}</h1>
    <p class="doc-sub">${esc(r.company)} · <time datetime="${isoDate(r)}">${fullDate(r)}</time>${
      prev ? ` · ${daysBetween(prev, r)} days after <a href="../${esc(prev.id)}/">${esc(prev.model)}</a>` : ''}</p>
  </div>
</div>

${r.note ? `<p class="doc-note">${esc(r.note)}</p>` : ''}

${r.tags.length ? `<div class="doc-tags">${r.tags.map((t) => `<span class="tag">${esc(tagLabel(t))}</span>`).join('')}</div>` : ''}

<h2>Details</h2>
<table class="doc-table">
<tbody>${facts.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody>
</table>

${r.events.length > 1 ? `<h2>Release timeline</h2>
<p class="doc-note">A model has more than one date. The timeline above positions it
at its announcement; these are every recorded lifecycle event, each with the
source that evidences it.</p>
<ol class="doc-events">${r.events.map((e) => {
  const cited = r.sources.filter((s) => e.sources.includes(s.id));
  return `<li><span class="event-date"><time datetime="${esc(e.date)}">${esc(eventDate(e.date))}</time></span>
<span class="event-type">${esc(EVENT_LABEL[e.type] ?? sentence(e.type))}</span>
<span class="event-src">${cited.map((s) =>
    `<a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a>`).join(', ') || '—'}</span></li>`;
}).join('')}</ol>` : ''}

<h2>Sources</h2>
<p class="doc-prov">Record status: <span class="prov-badge" data-status="${esc(r.provenance.status)}">${
  esc(PROV_LABEL[r.provenance.status] ?? r.provenance.status)}</span> · confidence ${r.provenance.confidence}/100 ·
${r.sources.filter((s) => s.authority === 'primary').length} of ${r.sources.length} primary</p>
${r.provenance.reason ? `<p class="doc-reason">${esc(r.provenance.reason)}</p>` : ''}
<ul class="doc-sources">${r.sources.map((s) =>
  `<li><a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a> <span>${esc(SOURCE_LABEL[s.type] ?? s.type)}</span> <span class="src-authority" data-authority="${esc(s.authority)}">${esc(AUTHORITY_LABEL[s.authority] ?? s.authority)}</span>${
    s.archived_url ? ` <a class="src-archive" href="${esc(s.archived_url)}" rel="noopener noreferrer nofollow">archived</a>` : ''}</li>`).join('')}</ul>
<p class="doc-note">Primary means published by the organisation that made the model.
<strong>Verified</strong> records require at least one.</p>

<h2>${esc(r.family)} family</h2>
<ol class="doc-lineage">${fam.map((x, i) => `<li${x.id === r.id ? ' aria-current="true"' : ''}>${
  x.id === r.id ? `<strong>${esc(x.model)}</strong>` : `<a href="../${esc(x.id)}/">${esc(x.model)}</a>`
} <span>${fullDate(x)}</span></li>`).join('')}</ol>

<p class="doc-cta">
  <a href="../../compare/?m=${esc(r.id)}">Compare ${esc(r.model)} with another model →</a><br>
  <a href="../../?year=${r.year}#${esc(r.id)}">See ${esc(r.model)} on the interactive timeline →</a>
</p>
${idx > 0 || idx < fam.length - 1 ? `<nav class="doc-nav">${
  idx > 0 ? `<a href="../${esc(fam[idx - 1].id)}/">← ${esc(fam[idx - 1].model)}</a>` : '<span></span>'}${
  idx < fam.length - 1 ? `<a href="../${esc(fam[idx + 1].id)}/">${esc(fam[idx + 1].model)} →</a>` : '<span></span>'}</nav>` : ''}
`;

  return page({
    title: `${r.model} — release date, company & sources | LLM World`,
    description: `${r.model} was released by ${r.company} on ${fullDate(r)}. ${r.note}`.slice(0, 300),
    canonical: `${BASE_URL}/models/${r.id}/`,
    section: 'models/',
    depth: 2,
    sprites: [slugFor(r.company)],
    jsonld: {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: r.model,
      applicationCategory: 'Large language model',
      datePublished: isoDate(r),
      creator: { '@type': 'Organization', name: r.company },
      description: r.note || undefined,
      isAccessibleForFree: r.access.open_weights || undefined,
      citation: r.sources.map((s) => s.url),
    },
    body,
  });
}

function companyPage(name, list) {
  const sorted = [...list].sort((a, b) => b.year - a.year || b.month - a.month || (b.day || 0) - (a.day || 0));
  const gaps = [];
  const asc = [...list].sort((a, b) => a.year - b.year || a.month - b.month || (a.day || 0) - (b.day || 0));
  for (let i = 1; i < asc.length; i++) gaps.push(daysBetween(asc[i - 1], asc[i]));
  const median = gaps.length
    ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
  const open = list.filter((r) => r.access.open_weights).length;

  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <span>${esc(name)}</span></nav>

<div class="doc-hero">
  <span class="doc-mark">${glyph(name)}</span>
  <div>
    <h1>${esc(name)}</h1>
    <p class="doc-sub">${list.length} tracked release${list.length === 1 ? '' : 's'} · ${open} open weights${
      median != null ? ` · median ${median} days between releases` : ''}</p>
  </div>
</div>

<h2>Releases</h2>
<ol class="doc-list cols-3">${sorted.map((r) =>
  `<li><span class="doc-mark sm">${glyph(r.company)}</span><a class="cell-name" href="../../models/${esc(r.id)}/">${esc(r.model)}</a><span class="cell-meta">${esc(r.family)}</span><span class="cell-num">${fullDate(r)}</span></li>`).join('')}</ol>

<p class="doc-cta"><a href="../../?company=${encodeURIComponent(name)}&year=all">Filter the timeline to ${esc(name)} →</a></p>
`;
  return page({
    title: `${name} — every tracked LLM release | LLM World`,
    description: `All ${list.length} tracked large language model releases from ${name}, with dates and sources.`,
    canonical: `${BASE_URL}/companies/${companySlug(name)}/`,
    section: 'companies/',
    depth: 2,
    sprites: [slugFor(name)],
    body,
  });
}

function yearPage(year, list) {
  const byMonth = new Map();
  for (const r of list) (byMonth.get(r.month) ?? byMonth.set(r.month, []).get(r.month)).push(r);

  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <span>${year}</span></nav>
<div class="doc-hero"><div>
  <h1>LLM releases in ${year}</h1>
  <p class="doc-sub">${list.length} tracked release${list.length === 1 ? '' : 's'} · ${eraFor(year)}</p>
</div></div>
${[...byMonth.keys()].sort((a, b) => a - b).map((m) => `
<h2>${MONTHS[m - 1]} ${year}</h2>
<ol class="doc-list">${byMonth.get(m).map((r) =>
  `<li><span class="doc-mark sm">${glyph(r.company)}</span><a class="cell-name" href="../../models/${esc(r.id)}/">${esc(r.model)}</a><span class="cell-meta">${esc(r.company)}</span><span class="cell-num">${fullDate(r)}</span></li>`).join('')}</ol>`).join('')}
<p class="doc-cta"><a href="../../?year=${year}">See ${year} on the interactive timeline →</a></p>
`;
  return page({
    title: `LLM releases in ${year} — full timeline | LLM World`,
    description: `Every tracked large language model released in ${year}, by month, with companies, dates and sources.`,
    canonical: `${BASE_URL}/timeline/${year}/`,
    section: '',
    depth: 2,
    sprites: [...new Set(list.map((r) => slugFor(r.company)))],
    body,
  });
}

/** Index of every tracked model, newest first, grouped by year. */
function modelsIndexPage() {
  const byYear = new Map();
  for (const r of [...releases].reverse()) {
    (byYear.get(r.year) ?? byYear.set(r.year, []).get(r.year)).push(r);
  }
  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Models</span></nav>
<div class="doc-hero"><div>
  <h1>All tracked models</h1>
  <p class="doc-sub">${releases.length} releases from ${new Set(releases.map((r) => r.company)).size} labs, newest first</p>
</div></div>
${[...byYear.keys()].sort((a, b) => b - a).map((y) => `
<h2><a href="../timeline/${y}/">${y}</a> — ${byYear.get(y).length} releases</h2>
<ol class="doc-list">${byYear.get(y).map((r) =>
  `<li><span class="doc-mark sm">${glyph(r.company)}</span><a class="cell-name" href="${esc(r.id)}/">${esc(r.model)}</a><span class="cell-meta">${esc(r.company)}</span><span class="cell-num">${fullDate(r)}</span></li>`).join('')}</ol>`).join('')}
`;
  return page({
    title: 'All tracked LLM releases | LLM World',
    description: `An index of ${releases.length} tracked large language model releases, newest first, each with dates and sources.`,
    canonical: `${BASE_URL}/models/`,
    section: 'models/',
    depth: 1,
    sprites: [...new Set(releases.map((r) => slugFor(r.company)))],
    body,
  });
}

/** Index of every lab, by release count. */
function companiesIndexPage(byCompany) {
  const rows = [...byCompany].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Companies</span></nav>
<div class="doc-hero"><div>
  <h1>Labs</h1>
  <p class="doc-sub">${rows.length} organisations, ranked by tracked releases</p>
</div></div>
<ol class="doc-list cols-3">${rows.map(([name, list]) => {
  const latest = [...list].sort((a, b) => b.year - a.year || b.month - a.month || (b.day || 0) - (a.day || 0))[0];
  return `<li><span class="doc-mark sm">${glyph(name)}</span><a class="cell-name" href="${companySlug(name)}/">${esc(name)}</a><span class="cell-meta">${list.length} release${list.length === 1 ? '' : 's'}</span><span class="cell-num">${fullDate(latest)}</span></li>`;
}).join('')}</ol>
`;
  return page({
    title: 'Labs tracked | LLM World',
    description: `The ${rows.length} organisations whose large language model releases are tracked, ranked by release count.`,
    canonical: `${BASE_URL}/companies/`,
    section: 'companies/',
    depth: 1,
    sprites: [...byCompany.keys()].map(slugFor),
    body,
  });
}

/** The 20 most recent releases — the "what shipped lately" view. */
function latestPage() {
  const recent = [...releases].reverse().slice(0, 20);
  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Latest</span></nav>
<div class="doc-hero"><div>
  <h1>Latest releases</h1>
  <p class="doc-sub">The 20 most recent tracked releases · data updated ${esc(data.updated)}</p>
</div></div>
<ol class="doc-list">${recent.map((r) => {
  const prev = predecessorOf(r);
  return `<li><span class="doc-mark sm">${glyph(r.company)}</span><a class="cell-name" href="../models/${esc(r.id)}/">${esc(r.model)}</a><span class="cell-meta">${esc(r.company)}</span><span class="cell-num">${fullDate(r)}${
    prev ? ` · +${daysBetween(prev, r)}d` : ''}</span></li>`;
}).join('')}</ol>
<p class="doc-cta"><a href="../models/">Browse all ${releases.length} releases →</a></p>
`;
  return page({
    title: 'Latest LLM releases | LLM World',
    description: 'The most recent large language model releases, with dates, labs and sources.',
    canonical: `${BASE_URL}/latest/`,
    section: 'latest/',
    depth: 1,
    sprites: [...new Set(recent.map((r) => slugFor(r.company)))],
    body,
  });
}


/* ---------------------------------------------------------------- charts */

/** Horizontal bar row. One hue: these all encode magnitude, not identity. */
function barRows(rows, { unit = '', width = 560 } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<div class="chart-rows">${rows.map((r) => `
    <div class="chart-row">
      <span class="chart-label">${r.href ? `<a href="${r.href}">${esc(r.name)}</a>` : esc(r.name)}</span>
      <span class="chart-track"><span class="chart-bar" style="width:${(r.value / max * 100).toFixed(1)}%"></span></span>
      <span class="chart-value">${r.display ?? r.value}${unit}</span>
    </div>`).join('')}</div>`;
}

/** Column chart for a time series. Values are labelled directly, so the
 *  chart needs no axis furniture. */
function columns(series) {
  const max = Math.max(1, ...series.map((s) => s.value));
  return `<div class="chart-cols">${series.map((s) => `
    <div class="chart-col">
      <span class="chart-colvalue">${s.value}</span>
      <span class="chart-colbar" style="height:${Math.max(3, s.value / max * 150)}px"></span>
      <span class="chart-collabel">${esc(s.label)}</span>
    </div>`).join('')}</div>`;
}

/** Two-series stacked bar: open weights vs proprietary. Exactly two classes,
 *  both direct-labelled, with a legend — identity never rests on colour. */
function openShare(byYear) {
  return `<div class="chart-rows">${[...byYear.keys()].sort((a, b) => a - b).map((y) => {
    const list = byYear.get(y);
    const open = list.filter((r) => r.access.open_weights).length;
    const pct = Math.round(open / list.length * 100);
    return `
    <div class="chart-row">
      <span class="chart-label"><a href="../timeline/${y}/">${y}</a></span>
      <span class="chart-track split">
        <span class="chart-bar open" style="width:${pct}%"></span>
        <span class="chart-bar closed" style="width:${100 - pct}%"></span>
      </span>
      <span class="chart-value">${pct}% open</span>
    </div>`;
  }).join('')}</div>`;
}

/** Peak disclosed context window per year. Log-scaled because 2K→1.05M on a
 *  linear axis would flatten everything before 2024 to nothing. */
function contextGrowth(byYear) {
  const rows = [...byYear.keys()].sort((a, b) => a - b).map((y) => {
    const vals = byYear.get(y).map((r) => r.technical.context_window).filter(Boolean);
    if (!vals.length) return null;
    const max = Math.max(...vals);
    const top = byYear.get(y).find((r) => r.technical.context_window === max);
    return { year: y, max, model: top.model, id: top.id };
  }).filter(Boolean);
  if (!rows.length) return '';

  const lo = Math.log10(Math.min(...rows.map((r) => r.max)));
  const hi = Math.log10(Math.max(...rows.map((r) => r.max)));
  const fmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

  return `<div class="chart-rows">${rows.map((r) => `
    <div class="chart-row">
      <span class="chart-label"><a href="../models/${esc(r.id)}/">${r.year} · ${esc(r.model)}</a></span>
      <span class="chart-track"><span class="chart-bar" style="width:${
        (5 + ((Math.log10(r.max) - lo) / Math.max(0.001, hi - lo)) * 95).toFixed(1)}%"></span></span>
      <span class="chart-value">${fmt(r.max)}</span>
    </div>`).join('')}</div>`;
}

/** Licence mix across open-weights releases. */
function licenceRows() {
  const counts = new Map();
  for (const r of releases) {
    if (!r.access.open_weights) continue;
    const key = r.access.license ?? 'Not recorded';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

function analyticsPage(byCompany, byYear) {
  const years = [...byYear.keys()].sort((a, b) => a - b);

  const perYear = years.map((y) => ({ label: String(y), value: byYear.get(y).length }));

  const perCompany = [...byCompany]
    .map(([name, l]) => ({ name, value: l.length, href: `../companies/${companySlug(name)}/` }))
    .sort((a, b) => b.value - a.value);

  // Median gap between consecutive releases, for labs with enough history
  // for a median to mean anything.
  const cadence = [...byCompany]
    .map(([name, l]) => {
      const asc = [...l].sort((a, b) => a.year - b.year || a.month - b.month || (a.day || 0) - (b.day || 0));
      const gaps = asc.slice(1).map((r, i) => daysBetween(asc[i], r));
      if (gaps.length < 2) return null;
      const sorted = [...gaps].sort((a, b) => a - b);
      const med = sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
      return { name, value: med, display: med, href: `../companies/${companySlug(name)}/` };
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value);

  const tagCounts = new Map();
  for (const r of releases) for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const perTag = [...tagCounts].map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Analytics</span></nav>
<div class="doc-hero"><div>
  <h1>Analytics</h1>
  <p class="doc-sub">${releases.length} tracked releases · ${byCompany.size} labs · ${years[0]}–${years.at(-1)}</p>
</div></div>

<h2>Releases per year</h2>
<p class="chart-note">How many tracked releases landed each year. ${years.at(-1)} is still in progress.</p>
${columns(perYear)}

<h2>Releases per lab</h2>
<p class="chart-note">Tracked releases by organisation, most active first.</p>
${barRows(perCompany)}

<h2>Open weights over time</h2>
<p class="chart-note">
  <span class="key"><span class="key-swatch open"></span>Open weights</span>
  <span class="key"><span class="key-swatch closed"></span>Proprietary</span>
</p>
${openShare(byYear)}

<h2>Median days between releases</h2>
<p class="chart-note">Typical gap between consecutive releases from the same lab. Only labs with three or more tracked releases appear, since a median needs at least two gaps.</p>
${barRows(cadence, { unit: 'd' })}

<h2>Largest context window by year</h2>
<p class="chart-note">The biggest disclosed context window among that year's tracked releases.
Bars are on a <strong>log scale</strong> — the range spans three orders of magnitude, so a
linear axis would render the early years invisible. Read the labels, not the widths.</p>
${contextGrowth(byYear)}

<h2>Open-weights licences</h2>
<p class="chart-note">How the ${releases.filter((r) => r.access.open_weights).length} open-weights
releases are licensed. Permissive licences (Apache-2.0, MIT) sit alongside bespoke
community terms that carry their own restrictions — check the licence before assuming reuse is free.</p>
${barRows(licenceRows())}

<h2>Capabilities</h2>
<p class="chart-note">How often each capability is tagged across all tracked releases.</p>
${barRows(perTag)}

<p class="doc-cta"><a href="../compare/">Compare models side by side →</a></p>
`;
  return page({
    title: 'LLM release analytics — cadence, labs, open weights | LLM World',
    description: `Release frequency, lab activity, open-weights share and release cadence across ${releases.length} tracked large language model releases.`,
    canonical: `${BASE_URL}/analytics/`,
    section: 'analytics/',
    depth: 1,
    sprites: [],
    body,
  });
}


/** Side-by-side comparison. The picker runs in the browser against the same
 *  JSON the app uses; with JavaScript off the page still explains itself and
 *  links into the model index. */
function comparePage() {
  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Compare</span></nav>
<div class="doc-hero"><div>
  <h1>Compare models</h1>
  <p class="doc-sub">Pick two to five releases and read them side by side</p>
</div></div>

<div class="cmp-pickers" id="cmp-pickers"></div>
<p class="chart-note" id="cmp-hint">Add a model to begin.</p>

<div class="cmp-scroll"><table class="cmp-table" id="cmp-table"></table></div>

<noscript><p class="doc-note">The comparison picker needs JavaScript. Every model's
figures are also on its own page — start from <a href="../models/">the model index</a>.</p></noscript>

<p class="doc-cta"><a href="../analytics/">See release analytics →</a></p>

<script type="module">
// Same derivation the static pages use, from the same module — this page reads
// the raw dataset at runtime, so without it the canonical date would be
// computed twice by two different rules.
import { dateParts, contextWindow, parameterCount } from '../lib/record.mjs';
const RES = (await fetch('../data/llm-releases.json', { cache: 'no-store' })
  .then((r) => r.json()).then((d) => d.releases).catch(() => []))
  .map((r) => ({
    ...r,
    ...dateParts(r),
    technical: { context_window: contextWindow(r), parameter_count: parameterCount(r) },
  }));
const byId = new Map(RES.map((r) => [r.id, r]));
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const date = (r) => \`\${MONTHS[r.month - 1]} \${r.day || ''}, \${r.year}\`.replace(' ,', ',');
const fmtParams = (n) => n == null ? 'Not disclosed'
  : n >= 1e12 ? \`\${+(n / 1e12).toFixed(2)}T\`
  : n >= 1e9 ? \`\${+(n / 1e9).toFixed(n < 1e10 ? 1 : 0)}B\`
  : n >= 1e6 ? \`\${Math.round(n / 1e6)}M\` : String(n);
const tokens = (n) => n == null ? 'Not disclosed'
  : n >= 1e6 ? \`\${+(n / 1e6).toFixed(2)}M\` : \`\${Math.round(n / 1000)}K\`;

const params = new URLSearchParams(location.search);
let picked = (params.get('m') || '').split(',').filter((id) => byId.has(id)).slice(0, 5);
if (!picked.length) picked = RES.slice(-2).map((r) => r.id);
// Arriving from a single model, pair it with that lab's previous release —
// the comparison people almost always want. A lone column isn't a comparison.
if (picked.length === 1) {
  const a = byId.get(picked[0]);
  const stamp = (r) => Date.UTC(r.year, r.month - 1, r.day || 1);
  const prior = RES.filter((r) => r.company === a.company && r.id !== a.id && stamp(r) < stamp(a));
  const other = prior.at(-1) ?? RES.filter((r) => r.id !== a.id).at(-1);
  if (other) picked.push(other.id);
}

const ROWS = [
  ['Company',        (r) => r.company],
  ['Released',       (r) => date(r)],
  ['Family',         (r) => r.family],
  ['Weights',        (r) => r.access.open_weights ? 'Open weights' : 'Proprietary'],
  ['Licence',        (r) => r.access.license ?? 'Not recorded'],
  ['Context window', (r) => r.technical.context_window ? tokens(r.technical.context_window) + ' tokens' : 'Not disclosed'],
  ['Parameters',     (r) => fmtParams(r.technical.parameter_count)],
  // Evidenced capabilities only — editorial tags like "flagship" are our
  // judgement and do not belong in a specification comparison (TAXONOMY §5).
  ['Capabilities',   (r) => r.capabilities.join(', ') || 'Not recorded'],
  ['Record status',  (r) => r.provenance.status.replace(/_/g, ' ')],
];

function sync() {
  const p = new URLSearchParams(location.search);
  p.set('m', picked.join(','));
  history.replaceState(null, '', location.pathname + '?' + p);
}

function render() {
  const models = picked.map((id) => byId.get(id)).filter(Boolean);

  document.getElementById('cmp-pickers').replaceChildren(
    ...models.map((r, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'cmp-pick';
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', \`Model \${i + 1}\`);
      for (const o of [...RES].reverse()) {
        const opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = \`\${o.model} — \${o.company}\`;
        if (o.id === r.id) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => { picked[i] = sel.value; sync(); render(); });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cmp-remove';
      del.textContent = '✕';
      del.setAttribute('aria-label', \`Remove \${r.model}\`);
      del.disabled = models.length <= 2;
      del.addEventListener('click', () => { picked.splice(i, 1); sync(); render(); });
      wrap.append(sel, del);
      return wrap;
    }),
    ...(models.length < 5 ? [(() => {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'cmp-add';
      add.textContent = '+ Add model';
      add.addEventListener('click', () => {
        const next = RES.slice().reverse().find((r) => !picked.includes(r.id));
        if (next) { picked.push(next.id); sync(); render(); }
      });
      return add;
    })()] : []),
  );

  document.getElementById('cmp-hint').textContent =
    \`Comparing \${models.length} of \${RES.length} tracked releases. Up to five at a time.\`;

  const t = document.getElementById('cmp-table');
  t.replaceChildren();
  const head = t.insertRow();
  head.insertCell().outerHTML = '<th scope="col"></th>';
  for (const r of models) {
    const th = document.createElement('th');
    th.scope = 'col';
    const a = document.createElement('a');
    a.href = \`../models/\${r.id}/\`;
    a.textContent = r.model;
    th.appendChild(a);
    head.appendChild(th);
  }
  for (const [label, get] of ROWS) {
    const tr = t.insertRow();
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = label;
    tr.appendChild(th);
    // Highlight a row only when the values actually differ.
    const vals = models.map(get);
    const same = vals.every((v) => v === vals[0]);
    for (const v of vals) {
      const td = tr.insertCell();
      td.textContent = v;
      if (!same) td.dataset.differs = 'true';
    }
  }
}

render();
</script>
`;
  return page({
    title: 'Compare LLM releases side by side | LLM World',
    description: 'Compare up to five large language model releases on date, lab, family, weights, context window and parameters.',
    canonical: `${BASE_URL}/compare/`,
    section: 'compare/',
    depth: 1,
    sprites: [],
    body,
  });
}

/* ------------------------------------------------------------------- build */

if (CHECK && existsSync(OUT)) rmSync(OUT, { recursive: true });

for (const r of releases) write(`models/${r.id}`, modelPage(r));

// Records merged under METHODOLOGY §2 leave their old URLs behind. Those pages
// were public, so they keep resolving rather than 404ing — the canonical tag
// tells crawlers where the record went, the meta refresh moves readers.
for (const r of releases) {
  for (const prev of r.previous_ids ?? []) {
    write(prev === r.id ? `models/${prev}-alias` : `models/${prev}`, page({
      title: `${r.model} — release date, company & sources | LLM World`,
      description: `${prev} is now recorded as ${r.model}.`,
      canonical: `${BASE_URL}/models/${r.id}/`,
      section: 'models/',
      depth: 2,
      sprites: [slugFor(r.company)],
      head: `<meta http-equiv="refresh" content="0; url=../${esc(r.id)}/">`,
      body: `<h1>Moved</h1>
<p class="doc-sub">This record was merged into <a href="../${esc(r.id)}/">${esc(r.model)}</a>,
which now carries both its release and its later lifecycle events.</p>
<p class="doc-cta"><a href="../${esc(r.id)}/">Continue to ${esc(r.model)} →</a></p>`,
    }));
  }
}

const byCompany = new Map();
for (const r of releases) (byCompany.get(r.company) ?? byCompany.set(r.company, []).get(r.company)).push(r);
for (const [name, list] of byCompany) write(`companies/${companySlug(name)}`, companyPage(name, list));

const byYear = new Map();
for (const r of releases) (byYear.get(r.year) ?? byYear.set(r.year, []).get(r.year)).push(r);
for (const [y, list] of byYear) write(`timeline/${y}`, yearPage(y, list));

write('models', modelsIndexPage());
write('companies', companiesIndexPage(byCompany));
write('latest', latestPage());
write('analytics', analyticsPage(byCompany, byYear));
write('compare', comparePage());

const BASE = BASE_URL;
const urls = [
  `${BASE}/models/`, `${BASE}/companies/`, `${BASE}/latest/`,
  `${BASE}/analytics/`, `${BASE}/compare/`,
  `${BASE}/`,
  ...releases.map((r) => `${BASE}/models/${r.id}/`),
  ...[...byCompany.keys()].map((c) => `${BASE}/companies/${companySlug(c)}/`),
  ...[...byYear.keys()].map((y) => `${BASE}/timeline/${y}/`),
];
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${u}</loc><lastmod>${data.updated}</lastmod></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${BASE}/sitemap.xml\n`);

/* ------------------------------------------------------ bulk export (off) */

if (EXPORT) {
  mkdirSync(join(OUT, 'api'), { recursive: true });

  // Every payload carries its own licence and attribution, so the terms
  // travel with the data rather than living only in the README.
  const META = {
    name: 'LLM World — tracked large language model releases',
    homepage: `${BASE_URL}/`,
    schema_version: data.schema_version ?? '1.5',
    updated: data.updated,
    count: releases.length,
    license: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: `Release dates and metadata from LLM World — ${BASE_URL}/ — CC BY 4.0`,
    notice: 'Undisclosed figures are null, never estimated. Check each record\'s '
          + 'sources[] before relying on a figure; provenance.status records how '
          + 'well it was verified.',
  };

  const writeJson = (path, obj) =>
    writeFileSync(join(OUT, path), JSON.stringify(obj, null, 2) + '\n');

  // Discovery document, so /api/ is not a dead end.
  writeJson('api/index.json', {
    ...META,
    endpoints: {
      models: `${BASE_URL}/api/models.json`,
      companies: `${BASE_URL}/api/companies.json`,
      csv: `${BASE_URL}/llm-releases.csv`,
    },
  });

  // The dataset as authored, not the view model — consumers pin against
  // schema_version and should get the real shape, derived fields excluded.
  writeJson('api/models.json', { ...META, releases: rawReleases });

  writeJson('api/companies.json', {
    ...META,
    companies: [...byCompany]
      .map(([name, list]) => {
        const asc = [...list].sort((a, b) => a.year - b.year || a.month - b.month || (a.day || 0) - (b.day || 0));
        return {
          name,
          slug: companySlug(name),
          releases: list.length,
          open_weights: list.filter((r) => r.access.open_weights).length,
          first_release: isoDate(asc[0]),
          latest_release: isoDate(asc.at(-1)),
          url: `${BASE_URL}/companies/${companySlug(name)}/`,
        };
      })
      .sort((a, b) => b.releases - a.releases || a.name.localeCompare(b.name)),
  });

  // CSV for spreadsheets: pure data, no comment line. CSV has no comment
  // convention, so a trailing licence row just parses as a bogus 86th record.
  // Terms live in api/index.json, LICENSE-DATA and the README instead.
  // Flat convenience format: the derived canonical date rather than events[],
  // and the schema's three axes as separate columns so a spreadsheet can filter
  // on evidenced facts without our editorial tags mixed in.
  const cols = ['id', 'model', 'company', 'family', 'kind', 'date',
    'primary_type', 'subtype', 'capabilities', 'tags',
    'open_weights', 'license', 'context_window', 'parameter_count',
    'provenance_status', 'confidence', 'primary_sources', 'sources', 'url'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(',')].concat(releases.map((r) => [
    r.id, r.model, r.company, r.family, r.kind, isoDate(r),
    r.classification.primary_type, r.classification.subtype ?? '',
    r.capabilities.join('|'), r.editorial.join('|'),
    r.access.open_weights, r.access.license ?? '',
    r.technical.context_window ?? '', r.technical.parameter_count ?? '',
    r.provenance.status, r.provenance.confidence,
    r.sources.filter((x) => x.authority === 'primary').length,
    r.sources.map((x) => x.url).join('|'), `${BASE_URL}/models/${r.id}/`,
  ].map(cell).join(',')));
  writeFileSync(join(OUT, 'llm-releases.csv'), csv.join('\n') + '\n');

  console.log('  + export: api/index.json, api/models.json, api/companies.json, llm-releases.csv');
}

console.log(`built ${releases.length} model pages · ${byCompany.size} company pages · ` +
  `${byYear.size} year pages · sitemap (${urls.length} urls)`);
if (!EXPORT) console.log('  bulk export skipped — pass --export to enable');
