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

const EXPORT = process.argv.includes('--export');
const CHECK = process.argv.includes('--check');
const OUT = CHECK ? '.build-check' : '.';

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const releases = data.releases;

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

const SOURCE_LABEL = {
  official_announcement: 'Official announcement', paper: 'Research paper',
  repository: 'Code repository', model_card: 'Model card',
  documentation: 'Official documentation', secondary: 'Secondary reporting',
};
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

/** Inline only the logos a page actually uses — keeps each page ~2KB, not 20KB. */
const spriteFor = (slugs) => `<svg class="sprite" aria-hidden="true" focusable="false"><defs>${
  [...new Set(slugs)].map((s) => SPRITE[`ic-${s}`] ?? SPRITE['ic-other']).join('')}</defs></svg>`;

const glyph = (company) =>
  `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false" ` +
  `style="--c:var(--c-${slugFor(company)})"><use href="#ic-${slugFor(company)}"></use></svg>`;

const daysBetween = (a, b) => Math.round(
  (Date.UTC(b.year, b.month - 1, b.day || 1) - Date.UTC(a.year, a.month - 1, a.day || 1)) / 86400000);

/** Previous release from the same lab. */
const predecessorOf = (r) => releases
  .filter((x) => x.company === r.company && x.id !== r.id && daysBetween(x, r) > 0).at(-1);

/* -------------------------------------------------------------------- shell */

function page({ title, description, canonical, depth, sprites, body, jsonld }) {
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
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head>
<body class="doc">
${spriteFor(sprites)}
<header class="doc-head">
  <a class="doc-brand" href="${up}"><span class="brand-mark" aria-hidden="true"></span><span>LLM&nbsp;WORLD</span></a>
  <a class="doc-back" href="${up}">Interactive timeline →</a>
</header>
<main class="doc-main">
${body}
</main>
<footer class="doc-foot">
  <p>Data: <a href="${up}">LLM World</a> · ${releases.length} tracked releases · updated ${esc(data.updated)}</p>
</footer>
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
    ['Type', r.kind === 'product' ? 'Product' : 'Model'],
    ['Weights', r.access.open_weights ? 'Open weights' : 'Proprietary'],
    ['Licence', r.access.license ?? 'Not recorded'],
    ['Context window', r.technical.context_window ? `${r.technical.context_window.toLocaleString()} tokens` : 'Not disclosed'],
    ['Parameters', r.technical.parameter_count ? r.technical.parameter_count.toLocaleString() : 'Not disclosed'],
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

${r.tags.length ? `<div class="doc-tags">${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}

<h2>Details</h2>
<table class="doc-table">
<tbody>${facts.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody>
</table>

<h2>Sources</h2>
<p class="doc-prov">Record status: <span class="prov-badge" data-status="${esc(r.provenance.status)}">${
  esc(PROV_LABEL[r.provenance.status] ?? r.provenance.status)}</span> · confidence ${r.provenance.confidence}/100</p>
<ul class="doc-sources">${r.sources.map((s) =>
  `<li><a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a> <span>${esc(SOURCE_LABEL[s.type] ?? s.type)}</span></li>`).join('')}</ul>

<h2>${esc(r.family)} family</h2>
<ol class="doc-lineage">${fam.map((x, i) => `<li${x.id === r.id ? ' aria-current="true"' : ''}>${
  x.id === r.id ? `<strong>${esc(x.model)}</strong>` : `<a href="../${esc(x.id)}/">${esc(x.model)}</a>`
} <span>${fullDate(x)}</span></li>`).join('')}</ol>

<p class="doc-cta"><a href="../../?year=${r.year}#${esc(r.id)}">See ${esc(r.model)} on the interactive timeline →</a></p>
${idx > 0 || idx < fam.length - 1 ? `<nav class="doc-nav">${
  idx > 0 ? `<a href="../${esc(fam[idx - 1].id)}/">← ${esc(fam[idx - 1].model)}</a>` : '<span></span>'}${
  idx < fam.length - 1 ? `<a href="../${esc(fam[idx + 1].id)}/">${esc(fam[idx + 1].model)} →</a>` : '<span></span>'}</nav>` : ''}
`;

  return page({
    title: `${r.model} — release date, company & sources | LLM World`,
    description: `${r.model} was released by ${r.company} on ${fullDate(r)}. ${r.note}`.slice(0, 300),
    canonical: `https://mayoorrnikam.github.io/llm-world/models/${r.id}/`,
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
<ol class="doc-list">${sorted.map((r) =>
  `<li><a href="../../models/${esc(r.id)}/">${esc(r.model)}</a><span>${fullDate(r)}</span></li>`).join('')}</ol>

<p class="doc-cta"><a href="../../?company=${encodeURIComponent(name)}&year=all">Filter the timeline to ${esc(name)} →</a></p>
`;
  return page({
    title: `${name} — every tracked LLM release | LLM World`,
    description: `All ${list.length} tracked large language model releases from ${name}, with dates and sources.`,
    canonical: `https://mayoorrnikam.github.io/llm-world/companies/${companySlug(name)}/`,
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
  `<li><span class="doc-mark sm">${glyph(r.company)}</span><a href="../../models/${esc(r.id)}/">${esc(r.model)}</a><span>${esc(r.company)}</span><span>${fullDate(r)}</span></li>`).join('')}</ol>`).join('')}
<p class="doc-cta"><a href="../../?year=${year}">See ${year} on the interactive timeline →</a></p>
`;
  return page({
    title: `LLM releases in ${year} — full timeline | LLM World`,
    description: `Every tracked large language model released in ${year}, by month, with companies, dates and sources.`,
    canonical: `https://mayoorrnikam.github.io/llm-world/timeline/${year}/`,
    depth: 2,
    sprites: [...new Set(list.map((r) => slugFor(r.company)))],
    body,
  });
}

/* ------------------------------------------------------------------- build */

if (CHECK && existsSync(OUT)) rmSync(OUT, { recursive: true });

for (const r of releases) write(`models/${r.id}`, modelPage(r));

const byCompany = new Map();
for (const r of releases) (byCompany.get(r.company) ?? byCompany.set(r.company, []).get(r.company)).push(r);
for (const [name, list] of byCompany) write(`companies/${companySlug(name)}`, companyPage(name, list));

const byYear = new Map();
for (const r of releases) (byYear.get(r.year) ?? byYear.set(r.year, []).get(r.year)).push(r);
for (const [y, list] of byYear) write(`timeline/${y}`, yearPage(y, list));

const BASE = 'https://mayoorrnikam.github.io/llm-world';
const urls = [
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
  writeFileSync(join(OUT, 'api/models.json'), JSON.stringify(data, null, 2));
  writeFileSync(join(OUT, 'api/companies.json'), JSON.stringify(
    [...byCompany].map(([name, l]) => ({ name, releases: l.length })), null, 2));
  const cols = ['id', 'model', 'company', 'family', 'kind', 'date', 'tags', 'open_weights', 'status', 'source'];
  const csv = [cols.join(',')].concat(releases.map((r) => [
    r.id, r.model, r.company, r.family, r.kind, isoDate(r), r.tags.join('|'),
    r.access.open_weights, r.provenance.status, r.sources[0]?.url ?? '',
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')));
  writeFileSync(join(OUT, 'llm-releases.csv'), csv.join('\n') + '\n');
  console.log('  + bulk export written (api/, csv)');
}

console.log(`built ${releases.length} model pages · ${byCompany.size} company pages · ` +
  `${byYear.size} year pages · sitemap (${urls.length} urls)`);
if (!EXPORT) console.log('  bulk export skipped — pass --export to enable');
