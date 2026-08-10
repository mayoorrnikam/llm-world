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
  dateParts, displayTags, contextWindow, parameterCount, tagLabel, diffRecords,
  fieldState, appliesTo, evidenceFor, assertedValue, EVIDENCED_FIELDS,
  MISSING_LABEL, SOURCE_LABEL, AUTHORITY_LABEL,
} from '../lib/record.mjs';

const EXPORT = process.argv.includes('--export');
const CHECK = process.argv.includes('--check');
const OUT = CHECK ? '.build-check' : '.';
const BASE_URL = 'https://mayoorrnikam.github.io/llm-world';

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/** The dataset as authored (schema 1.6). What --export publishes. */
const rawReleases = data.releases;

/** Dated events that were not model releases (TAXONOMY §7). Optional file. */
let milestones = [];
try {
  milestones = JSON.parse(readFileSync('data/milestones.json', 'utf8')).milestones ?? [];
} catch { /* no milestones yet — the site renders without them */ }

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

/** Releases grouped by lab, so a lab page can say how it compares to the field. */
const byCompanyIndex = new Map();
for (const r of releases) {
  (byCompanyIndex.get(r.company) ?? byCompanyIndex.set(r.company, []).get(r.company)).push(r);
}

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
/** "o-series" → "o-series", "GPT-OSS" → "gpt-oss". Same rule as companies. */
const familySlug = (f) => f.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

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

  /**
   * The source behind one published number, rendered next to it.
   *
   * This is the whole point of Stage 5: a reader should not have to take a
   * figure on trust, or scroll to a source list and guess which entry backs
   * which value. Where sources disagree, both values are shown — resolving it
   * silently would be invisible (METHODOLOGY §8).
   */
  const cite = (field) => {
    const e = evidenceFor(r, field);
    if (!e.claims.length) return '';
    if (!e.agreed) {
      return `<span class="fact-conflict">sources disagree: ${e.claims.map((c) =>
        `${esc(String(c.value))} (${c.sources.map((s) =>
          `<a href="${esc(s.archived_url || s.url)}" rel="noopener noreferrer nofollow">${
            esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a>`).join(', ')})`).join(' · ')}</span>`;
    }
    if (!e.sources.length) return '';
    return `<span class="fact-cite">stated in ${e.sources.map((s) =>
      `<a href="${esc(s.archived_url || s.url)}" rel="noopener noreferrer nofollow" title="${
        esc(SOURCE_LABEL[s.type] ?? s.type)}">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a>`
    ).join(', ')}</span>`;
  };

  const facts = [
    ['Released', fullDate(r), cite('release_date')],
    ['Company', r.company],
    ['Family', r.family],
    ['Era', eraFor(r.year)],
    ['Type', r.kind === 'product' ? 'Product' : TYPE_LABEL(r.classification)],
    ['Modalities', modalityText(r)],
    ['Capabilities', r.capabilities.length ? r.capabilities.map(capLabel).join(', ') : 'Not recorded'],
    ['Weights', r.access.open_weights ? 'Open weights' : 'Proprietary'],
    // "Not disclosed" is a claim about the lab. Only make it where we looked
    // and the primary sources genuinely say nothing (METHODOLOGY §1).
    ['Licence', r.access.open_weights
      ? (r.access.license ?? MISSING_LABEL[fieldState(r, 'license')])
      : 'Not applicable — proprietary'],
    // Language-only rows are omitted for other model types. An image model does
    // not have an undisclosed context window; it has no context window.
    ...(appliesTo(r, 'context_window') ? [
      ['Context window', r.technical.context_window != null
        ? tokens(r.technical.context_window)
        : MISSING_LABEL[fieldState(r, 'context_window')], cite('context_window')],
      ['Parameters', r.technical.parameter_count != null
        ? params(r.technical.parameter_count)
        : MISSING_LABEL[fieldState(r, 'parameter_count')], cite('parameter_count')],
    ] : []),
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
<tbody>${facts.map(([k, v, cited]) =>
  `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}${cited ?? ''}</td></tr>`).join('')}</tbody>
</table>

${r.pricing?.length ? `<h2>Pricing</h2>
<p class="chart-note">The price a lab's own page showed <strong>on the day that page was
captured</strong>. That is what a snapshot can prove; it is not necessarily the launch
price, and prices are often cut later. Citing the live pricing page instead would give a
number with no date at all.</p>
<table class="doc-table">
<tbody>${r.pricing.map((p) => {
  const cited = r.sources.filter((s) => p.sources.includes(s.id));
  return Object.entries(p.rates).map(([k, v]) => `<tr>
<th scope="row">${esc(sentence(k))}</th>
<td>$${v} per million tokens
<span class="fact-cite">observed ${esc(eventDate(p.observed_on))} · ${cited.map((s) =>
    `<a href="${esc(s.archived_url)}" rel="noopener noreferrer nofollow">archived snapshot${
      s.retrieved ? ` (${esc(s.retrieved)})` : ''}</a>`).join(', ')}</span></td>
</tr>`).join('');
}).join('')}</tbody></table>` : ''}

${r.benchmarks?.length ? `<h2>Benchmarks</h2>
<p class="chart-note">Each row is a dated claim by a named party, not a property of the
model. A later revision adds a row rather than replacing one. This project publishes no
composite or overall score.</p>
<table class="doc-table">
<thead><tr><th>Benchmark</th><th>Score</th><th>Reported by</th><th>Date</th></tr></thead>
<tbody>${r.benchmarks.map((b) => `<tr>
<th scope="row">${esc(b.name)}</th><td>${esc(String(b.score))}</td>
<td>${esc(sentence(b.evaluation_type))}</td><td>${esc(eventDate(b.reported_on))}</td>
</tr>`).join('')}</tbody></table>` : ''}

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

  const first = asc[0], latest = asc.at(-1);
  const verified = list.filter((r) => r.provenance.status === 'verified').length;
  const families = [...new Set(list.map((r) => r.family))].sort();

  // How this lab's cadence compares to everyone else's, so the number means
  // something. A 90-day median is fast or slow only relative to the field.
  const allMedians = [];
  for (const [, peers] of byCompanyIndex) {
    const p = [...peers].sort((a, b) => a.year - b.year || a.month - b.month);
    const g = [];
    for (let i = 1; i < p.length; i++) g.push(daysBetween(p[i - 1], p[i]));
    if (g.length >= 2) allMedians.push([...g].sort((a, b) => a - b)[Math.floor(g.length / 2)]);
  }
  const fieldMedian = allMedians.length
    ? [...allMedians].sort((a, b) => a - b)[Math.floor(allMedians.length / 2)] : null;

  const perYear = new Map();
  for (const r of list) perYear.set(r.year, (perYear.get(r.year) ?? 0) + 1);
  const years = [...perYear.keys()].sort((a, b) => a - b);

  // Only capabilities that have actually been evidenced on this lab's records.
  const capCounts = new Map();
  for (const r of list) for (const c of r.capabilities) capCounts.set(c, (capCounts.get(c) ?? 0) + 1);
  const caps = [...capCounts.entries()].sort((a, b) => b[1] - a[1]);

  const ctxPoints = asc.filter((r) => r.technical.context_window != null);

  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <a href="../">Labs</a> › <span>${esc(name)}</span></nav>

<div class="doc-hero">
  <span class="doc-mark">${glyph(name)}</span>
  <div>
    <h1>${esc(name)}</h1>
    <p class="doc-sub">${list.length} tracked release${list.length === 1 ? '' : 's'} · ${open} open weights${
      median != null ? ` · median ${median} days between releases` : ''}</p>
  </div>
</div>

<h2>At a glance</h2>
<table class="doc-table">
<tbody>
<tr><th scope="row">Releases tracked</th><td>${list.length}</td></tr>
<tr><th scope="row">Families</th><td>${families.map((f) =>
    `<a href="../../families/${familySlug(f)}/">${esc(f)}</a>`).join(' · ')}</td></tr>
<tr><th scope="row">First tracked</th><td>${fullDate(first)} — <a href="../../models/${esc(first.id)}/">${esc(first.model)}</a></td></tr>
<tr><th scope="row">Latest</th><td>${fullDate(latest)} — <a href="../../models/${esc(latest.id)}/">${esc(latest.model)}</a></td></tr>
${median != null ? `<tr><th scope="row">Median gap</th><td>${median} days${
    fieldMedian != null ? ` · ${median < fieldMedian ? 'faster' : median > fieldMedian ? 'slower' : 'level'} than the ${fieldMedian}-day median across tracked labs` : ''}</td></tr>` : ''}
<tr><th scope="row">Weights</th><td>${open === list.length ? 'Open throughout'
    : open === 0 ? 'Proprietary throughout'
    : `${open} of ${list.length} open (${Math.round(open / list.length * 100)}%)`}</td></tr>
<tr><th scope="row">Record quality</th><td>${verified} of ${list.length} verified · <a href="../../data-quality/">how this is judged</a></td></tr>
</tbody></table>

${years.length > 1 ? `<h2>Releases per year</h2>
<p class="chart-note">Tracked releases only — a quiet year here may mean this dataset
is thin for that year rather than that the lab was quiet.</p>
${barRows(years.map((y) => ({
    name: String(y), value: perYear.get(y), href: `../../timeline/${y}/`,
  })))}` : ''}

${ctxPoints.length > 1 ? `<h2>Context window over time</h2>
<p class="chart-note">Releases with a disclosed context window${
  ctxPoints.length < list.length ? ` — ${list.length - ctxPoints.length} of ${list.length} not shown` : ''}.</p>
${barRows(ctxPoints.map((r) => ({
    name: `${r.model} · ${r.year}`,
    value: r.technical.context_window,
    display: tokens(r.technical.context_window),
    href: `../../models/${esc(r.id)}/`,
  })))}` : ''}

${caps.length ? `<h2>Evidenced capabilities</h2>
<p class="chart-note">How often each capability is cited across this lab's releases.
Absence means not evidenced, never absent — see <a href="../../data-quality/">data quality</a>.</p>
${barRows(caps.map(([c, n]) => ({ name: tagLabel(c), value: n })))}` : ''}

<h2>Releases</h2>
<ol class="doc-list cols-3">${sorted.map((r) =>
  `<li><span class="doc-mark sm">${glyph(r.company)}</span><a class="cell-name" href="../../models/${esc(r.id)}/">${esc(r.model)}</a><span class="cell-meta">${esc(r.family)}</span><span class="cell-num">${fullDate(r)}</span></li>`).join('')}</ol>

<p class="doc-cta">
  <a href="../../?company=${encodeURIComponent(name)}&year=all">Filter the timeline to ${esc(name)} →</a><br>
  <a href="../">Compare with the other ${byCompanyIndex.size - 1} tracked labs →</a>
</p>
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

  // Milestones belong on the timeline even though they are not releases —
  // 2022 without ChatGPT would be a strange year to read.
  const yearMilestones = milestones
    .filter((m) => m.date.startsWith(String(year)))
    .sort((a, b) => a.date.localeCompare(b.date));

  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <span>${year}</span></nav>
<div class="doc-hero"><div>
  <h1>LLM releases in ${year}</h1>
  <p class="doc-sub">${list.length} tracked release${list.length === 1 ? '' : 's'}${
    yearMilestones.length ? ` · ${yearMilestones.length} milestone${yearMilestones.length === 1 ? '' : 's'}` : ''} · ${eraFor(year)}</p>
</div></div>
${yearMilestones.length ? `<h2>Milestones</h2>
<p class="chart-note">Dated events that mattered without being model releases.</p>
<ol class="doc-list">${yearMilestones.map((m) =>
    `<li><span class="doc-mark sm">${glyph(m.company)}</span><a class="cell-name" href="../../milestones/${esc(m.id)}/">${esc(m.title)}</a><span class="cell-meta">${esc(m.company)}</span><span class="cell-num">${esc(eventDate(m.date))}</span></li>`).join('')}</ol>` : ''}
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


const MILESTONE_LABEL = {
  product_launch: 'Product launch', architecture: 'Architecture',
  context: 'Context length', multimodal: 'Multimodal', open_weights: 'Open weights',
  research: 'Research', policy: 'Policy',
};

/**
 * Milestones: dated events that mattered, whether or not they were a model
 * release. ChatGPT is the reason this exists — it is a product served by
 * GPT-3.5, not a set of weights, so filing it as a model gave it a row where
 * every specification was null (TAXONOMY §7). Deleting it would be worse: its
 * launch is the most consequential date in this timeline.
 */
function milestonePage(m) {
  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <a href="../">Milestones</a> › <span>${esc(m.title)}</span></nav>

<div class="doc-hero">
  <span class="doc-mark">${glyph(m.company)}</span>
  <div>
    <h1>${esc(m.title)}</h1>
    <p class="doc-sub">${esc(m.company)} · <time datetime="${esc(m.date)}">${esc(eventDate(m.date))}</time> ·
    ${esc(MILESTONE_LABEL[m.type] ?? m.type)}</p>
  </div>
</div>

<p class="doc-lede">${esc(m.note)}</p>
${m.significance ? `<p class="doc-note">${esc(m.significance)}</p>` : ''}

<h2>Why this is not a model record</h2>
<p class="doc-note">This dataset's model records describe sets of weights — parameters,
a context window, a licence. ${esc(m.title.replace(/ launches$/, ''))} is a product built on
a model, so it has none of those. Recording it as a model would mean a row where every
specification is empty, and would count it as a release that never happened.
${m.related_family ? `The model line behind it is tracked as
<a href="../../families/${familySlug(m.related_family)}/">${esc(m.related_family)}</a>.` : ''}</p>

<h2>Sources</h2>
<p class="doc-prov">Record status: <span class="prov-badge" data-status="${esc(m.provenance.status)}">${
  esc(PROV_LABEL[m.provenance.status] ?? m.provenance.status)}</span> · confidence ${m.provenance.confidence}/100</p>
${m.provenance.reason ? `<p class="doc-reason">${esc(m.provenance.reason)}</p>` : ''}
<ul class="doc-sources">${m.sources.map((s) =>
  `<li><a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a> <span>${esc(SOURCE_LABEL[s.type] ?? s.type)}</span> <span class="src-authority" data-authority="${esc(s.authority)}">${esc(AUTHORITY_LABEL[s.authority] ?? s.authority)}</span>${
    s.archived_url ? ` <a class="src-archive" href="${esc(s.archived_url)}" rel="noopener noreferrer nofollow">archived</a>` : ''}</li>`).join('')}</ul>

<p class="doc-cta"><a href="../../timeline/${m.date.slice(0, 4)}/">See what else happened in ${m.date.slice(0, 4)} →</a></p>
`;

  return page({
    title: `${m.title} — ${eventDate(m.date)} | LLM World`,
    description: `${m.title} on ${eventDate(m.date)}. ${m.note}`.slice(0, 300),
    canonical: `${BASE_URL}/milestones/${m.id}/`,
    // Milestones are timeline events, so they mark Timeline. Two records do not
    // justify a nav slot of their own — revisit when there are more.
    section: '',
    depth: 2,
    sprites: [slugFor(m.company)],
    body,
  });
}

function milestonesIndexPage(list) {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Milestones</span></nav>

<h1>Milestones</h1>
<p class="doc-sub">${sorted.length} dated event${sorted.length === 1 ? '' : 's'} that mattered but were not model releases</p>

<p class="doc-note">Not everything that shaped this history was a set of weights.
A milestone records a dated event — a product launch, an architectural shift — that
belongs on the timeline but has no parameters, context window or licence.
Every milestone needs a primary source, exactly like a model record.</p>

<ol class="doc-list">${sorted.map((m) => `<li>
<span class="doc-mark sm">${glyph(m.company)}</span>
<a class="cell-name" href="${esc(m.id)}/">${esc(m.title)}</a>
<span class="cell-meta">${esc(MILESTONE_LABEL[m.type] ?? m.type)} · ${esc(m.company)}</span>
<span class="cell-num">${esc(eventDate(m.date))}</span>
</li>`).join('')}</ol>

<p class="doc-cta"><a href="../models/">Browse tracked model releases →</a></p>
`;

  return page({
    title: 'Milestones — dated events that were not model releases | LLM World',
    description: 'Dated events that shaped large language model history without being model releases, each with a primary source.',
    canonical: `${BASE_URL}/milestones/`,
    section: '',
    depth: 1,
    sprites: [...new Set(list.map((m) => slugFor(m.company)))],
    body,
  });
}

/**
 * A family page: one model line, generation by generation.
 *
 * This is the question the timeline cannot answer. A timeline shows what
 * shipped when; a family shows how one line of models actually developed —
 * which is the thing a release tracker does not do.
 */
function familyPage(name, list) {
  const gens = [...list].sort((a, b) => a.year - b.year || a.month - b.month || (a.day || 0) - (b.day || 0));
  const labs = [...new Set(gens.map((r) => r.company))];
  const first = gens[0], last = gens.at(-1);
  const span = daysBetween(first, last);
  const openCount = gens.filter((r) => r.access.open_weights).length;
  const verified = gens.filter((r) => r.provenance.status === 'verified').length;

  // Median gap needs at least two gaps to mean anything.
  const gaps = gens.slice(1).map((r, i) => daysBetween(gens[i], r)).sort((a, b) => a - b);
  const median = gaps.length >= 2 ? gaps[Math.floor(gaps.length / 2)] : null;

  const ctxPoints = gens.filter((r) => r.technical.context_window != null);

  const body = `
<nav class="crumbs"><a href="../../">Home</a> › <a href="../">Families</a> › <span>${esc(name)}</span></nav>

<div class="doc-hero">
  <span class="doc-mark">${glyph(first.company)}</span>
  <div>
    <h1>${esc(name)}</h1>
    <p class="doc-sub">${esc(labs.join(' · '))} · ${gens.length} tracked release${gens.length === 1 ? '' : 's'}${
      gens.length > 1 ? ` · ${fullDate(first)} – ${fullDate(last)}` : ` · ${fullDate(first)}`}</p>
  </div>
</div>

<h2>At a glance</h2>
<table class="doc-table">
<tbody>
<tr><th scope="row">Releases tracked</th><td>${gens.length}</td></tr>
<tr><th scope="row">First tracked</th><td>${fullDate(first)} — <a href="../../models/${esc(first.id)}/">${esc(first.model)}</a></td></tr>
<tr><th scope="row">Latest</th><td>${fullDate(last)} — <a href="../../models/${esc(last.id)}/">${esc(last.model)}</a></td></tr>
${gens.length > 1 ? `<tr><th scope="row">Span</th><td>${span.toLocaleString('en-US')} days</td></tr>` : ''}
${median != null ? `<tr><th scope="row">Median gap</th><td>${median} days between releases</td></tr>` : ''}
<tr><th scope="row">Weights</th><td>${openCount === gens.length ? 'Open throughout'
    : openCount === 0 ? 'Proprietary throughout'
    : `${openCount} of ${gens.length} open`}</td></tr>
<tr><th scope="row">Record quality</th><td>${verified} of ${gens.length} verified · <a href="../../data-quality/">how this is judged</a></td></tr>
</tbody></table>

<h2>Lineage</h2>
<p class="chart-note">Ordered by announcement date. Lineage is not inferred from
version numbers — labs do not number consistently, so the dates decide the order.</p>
<ol class="doc-lineage family-lineage">${gens.map((r) => `<li>
<a href="../../models/${esc(r.id)}/">${esc(r.model)}</a>
<span>${fullDate(r)}</span></li>`).join('')}</ol>

${ctxPoints.length > 1 ? `<h2>Context window over time</h2>
<p class="chart-note">Only releases with a disclosed context window appear${
  ctxPoints.length < gens.length ? ` — ${gens.length - ctxPoints.length} of ${gens.length} are not shown` : ''}.</p>
${barRows(ctxPoints.map((r) => ({
    name: `${r.model} · ${r.year}`,
    value: r.technical.context_window,
    display: tokens(r.technical.context_window),
    href: `../../models/${esc(r.id)}/`,
  })))}` : ''}

${gens.length > 1 ? whatChangedSection(gens) : `<h2>What changed</h2>
<p class="doc-note">Only one release of this family is tracked, so there is nothing to compare yet.</p>`}

<p class="doc-cta">
  <a href="../../compare/?m=${gens.slice(-2).map((r) => esc(r.id)).join(',')}">Compare the two most recent side by side →</a><br>
  <a href="../../companies/${companySlug(first.company)}/">All releases from ${esc(first.company)} →</a>
</p>
`;

  return page({
    title: `${name} — model family lineage and what changed | LLM World`,
    description: `Every tracked ${name} release from ${first.company}, in order, with what changed between generations and the sources behind each figure.`,
    canonical: `${BASE_URL}/families/${familySlug(name)}/`,
    section: 'families/',
    depth: 2,
    sprites: [...new Set(gens.map((r) => slugFor(r.company)))],
    body,
  });
}

/**
 * The diff between consecutive generations.
 *
 * Fields the data cannot support are listed as gaps rather than silently
 * dropped, because "we did not compare this" and "nothing changed" look
 * identical once you hide the difference.
 */
function whatChangedSection(gens) {
  const pairs = gens.slice(1).map((next, i) => {
    const d = diffRecords(gens[i], next);
    return { prev: gens[i], next, ...d };
  });

  // A caveat that applies to every pair is a fact about the family, not about
  // any one step. Repeating it fifteen times buries the changes that did happen.
  const universal = pairs[0].incomparable
    .filter((g) => pairs.every((p) => p.incomparable.some((x) => x.label === g.label)))
    .map((g) => g.label);

  return `<h2>What changed</h2>
<p class="chart-note">Generation to generation, from evidenced values only. A field is
compared only where both releases record it — otherwise it is called out as not comparable,
so a research gap never reads as a change the lab made.</p>
${universal.length ? `<p class="doc-note">Across every generation of this family,
${esc(universal.join(', ').toLowerCase())} could not be compared — the values are not
recorded on both sides of any step. That is a gap in this dataset, not a statement about
the models. <a href="../../data-quality/">See data quality</a>.</p>` : ''}
${pairs.map(({ prev, next, changes, incomparable }) => {
    const local = incomparable.filter((g) => !universal.includes(g.label));
    // Two models released the same day are tiers, not generations. Calling the
    // difference between them a "change" would claim a lab revised something it
    // shipped simultaneously — Amazon's five Nova models are one launch.
    const gap = daysBetween(prev, next);
    const sameDay = gap === 0;
    return `<div class="changeset"${sameDay ? ' data-siblings="true"' : ''}>
<h3><a href="../../models/${esc(prev.id)}/">${esc(prev.model)}</a> ${sameDay ? 'vs' : '→'} <a href="../../models/${esc(next.id)}/">${esc(next.model)}</a>
<span class="changeset-gap">${sameDay ? 'shipped together' : `${gap.toLocaleString('en-US')} days`}</span></h3>
${sameDay ? '<p class="doc-note">Released on the same day, so these are differences between tiers rather than changes over time.</p>' : ''}
${changes.length ? `<dl class="change-list">${changes.map((c) => {
      if (c.gained || c.lost) {
        return `<div><dt>${esc(c.label)}</dt><dd>${
          [...(c.gained ?? []).map((x) => `<span class="delta-add">+ ${esc(tagLabel(x))}</span>`),
            ...(c.lost ?? []).map((x) => `<span class="delta-drop">− ${esc(tagLabel(x))}</span>`)].join(' ')
        }</dd></div>`;
      }
      return `<div><dt>${esc(c.label)}</dt><dd><span class="delta-from">${esc(c.from)}</span>
<span class="delta-arrow" aria-label="changed to">→</span>
<span class="delta-to" data-direction="${esc(c.direction)}">${esc(c.to)}</span></dd></div>`;
    }).join('')}</dl>` : '<p class="doc-note">No change in any field both releases record.</p>'}
${local.length ? `<p class="change-gaps">Not comparable here: ${
      local.map((g) => `${esc(g.label.toLowerCase())} (${esc(g.why)})`).join('; ')}.</p>` : ''}
</div>`;
  }).join('')}`;
}

/** Index of every tracked family. */
function familiesIndexPage(byFamily) {
  const rows = [...byFamily.entries()]
    .map(([name, list]) => {
      const gens = [...list].sort((a, b) => a.year - b.year || a.month - b.month);
      return { name, gens, latest: gens.at(-1), first: gens[0] };
    })
    .sort((a, b) => b.gens.length - a.gens.length || a.name.localeCompare(b.name));

  const multi = rows.filter((r) => r.gens.length > 1).length;

  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Families</span></nav>

<h1>Model families</h1>
<p class="doc-sub">${rows.length} tracked lines · ${multi} with more than one generation</p>

<p class="doc-note">A family is a lineage the lab itself presents as continuous.
It is never inferred from names alone — <a href="../models/gpt-oss/">GPT-OSS</a> is not
the GPT family merely for sharing a prefix.</p>

<ol class="doc-list">${rows.map((r) => `<li>
<span class="doc-mark sm">${glyph(r.first.company)}</span>
<a class="cell-name" href="${familySlug(r.name)}/">${esc(r.name)}</a>
<span class="cell-meta">${esc(r.first.company)}</span>
<span class="cell-num">${r.gens.length} release${r.gens.length === 1 ? '' : 's'}</span>
</li>`).join('')}</ol>

<p class="doc-cta"><a href="../models/">Browse every release →</a></p>
`;

  return page({
    title: 'LLM model families — lineage and evolution | LLM World',
    description: `The ${rows.length} model families tracked here, from Claude and GPT to Llama and Qwen, each with its full lineage and what changed between generations.`,
    canonical: `${BASE_URL}/families/`,
    section: 'families/',
    depth: 1,
    sprites: [...new Set(rows.map((r) => slugFor(r.first.company)))],
    body,
  });
}

/**
 * The Data Quality page.
 *
 * This publishes the dataset's own weaknesses. That is the point: a reader who
 * can see exactly what is unproven can calibrate everything else, and a number
 * that implies completeness where there is none is worth less than an honest
 * gap. Nothing here is computed specially for display — every figure is read
 * back out of the same records the rest of the site renders.
 */
function dataQualityPage() {
  const total = releases.length;
  const byStatus = {};
  for (const r of releases) byStatus[r.provenance.status] = (byStatus[r.provenance.status] ?? 0) + 1;

  const sources = releases.flatMap((r) => r.sources);
  const primary = sources.filter((s) => s.authority === 'primary').length;
  const archived = sources.filter((s) => s.archived_url).length;
  const noPrimary = releases.filter((r) => !r.sources.some((s) => s.authority === 'primary'));

  // Three-way, because "the lab does not publish it" and "nobody has looked"
  // are different facts and only one of them is a gap.
  const coverage = ['context_window', 'parameter_count', 'license'].map((f) => {
    const scope = f === 'license'
      ? releases.filter((r) => r.access.open_weights)
      : releases.filter((r) => appliesTo(r, f));
    const c = { recorded: 0, undisclosed: 0, unresearched: 0 };
    for (const r of scope) c[fieldState(r, f)]++;
    return { field: f, scope: scope.length, ...c };
  });

  const modalities = releases.filter((r) => r.modalities).length;
  const conflicts = releases.filter((r) => r.provenance.status === 'conflicting');
  const withPricing = releases.filter((r) => r.pricing?.length).length;
  const withBenchmarks = releases.filter((r) => r.benchmarks?.length).length;

  const byLab = new Map();
  for (const r of releases) {
    const e = byLab.get(r.company) ?? { n: 0, v: 0 };
    e.n++; if (r.provenance.status === 'verified') e.v++;
    byLab.set(r.company, e);
  }
  const labRows = [...byLab.entries()]
    .sort((a, b) => (b[1].v / b[1].n) - (a[1].v / a[1].n) || b[1].n - a[1].n)
    .map(([name, e]) => ({
      name, value: Math.round(e.v / e.n * 100),
      display: `${e.v}/${e.n}`, href: `../companies/${companySlug(name)}/`,
    }));

  const unproven = releases.filter((r) => r.provenance.status !== 'verified')
    .sort((a, b) => b.year - a.year || b.month - a.month);

  const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
  const FIELD_LABEL = {
    context_window: 'Context window', parameter_count: 'Parameter count',
    license: 'Licence', release_date: 'Release date',
  };

  const body = `
<nav class="crumbs"><a href="../">Home</a> › <span>Data quality</span></nav>

<h1>Data quality</h1>
<p class="doc-sub">What this dataset can prove, and what it cannot · ${total} records · updated ${esc(data.updated)}</p>

<p class="doc-note">Every figure on this page is read back out of the dataset itself.
Where a record cannot support a claim, it says so here rather than quietly rounding up.</p>

<h2>Verification</h2>
<p class="chart-note">A record is <strong>verified</strong> when every value it asserts was found in a
primary source — one published by the organisation that made the model. A <code>null</code>
asserts nothing, so an undisclosed figure does not block verification.</p>
${barRows([
  { name: 'Verified', value: byStatus.verified ?? 0, display: `${byStatus.verified ?? 0} (${pct(byStatus.verified ?? 0, total)}%)` },
  { name: 'Partly verified', value: byStatus.partially_verified ?? 0, display: String(byStatus.partially_verified ?? 0) },
  { name: 'Approximate date', value: byStatus.estimated ?? 0, display: String(byStatus.estimated ?? 0) },
  { name: 'Conflicting', value: byStatus.conflicting ?? 0, display: String(byStatus.conflicting ?? 0) },
].filter((r) => r.value > 0))}

<h2>Sources</h2>
<p class="chart-note">${sources.length} citations across ${total} records.
<strong>${primary}</strong> are primary. <strong>${archived}</strong> carry a dated
archive snapshot, so they still prove the claim after the live page changes.</p>
${barRows([
  { name: 'Primary', value: primary, display: `${primary} (${pct(primary, sources.length)}%)` },
  { name: 'Secondary', value: sources.length - primary, display: String(sources.length - primary) },
  { name: 'Archived', value: archived, display: `${archived} (${pct(archived, sources.length)}%)` },
])}
<p class="doc-note">Every source URL is re-checked weekly in CI.
${noPrimary.length
    ? `<strong>${noPrimary.length} record${noPrimary.length === 1 ? '' : 's'} cite no primary source at all</strong>
and cannot be verified until the lab's own announcement is found: ${
  noPrimary.map((r) => `<a href="../models/${esc(r.id)}/">${esc(r.model)}</a>`).join(', ')}.`
    : 'Every record cites at least one primary source.'}</p>

<h2>Specification coverage</h2>
<p class="chart-note">A missing value is only a gap if someone could have recorded it.
<strong>Not disclosed</strong> means we read the primary sources and the lab does not publish
it — the record is complete. <strong>Not researched</strong> means nobody has checked yet.
Most proprietary labs never publish parameter counts, so those nulls are correct answers,
not holes.</p>
<table class="doc-table quality-table">
<thead><tr><th>Field</th><th>Recorded</th><th>Not disclosed</th><th>Not researched</th></tr></thead>
<tbody>${coverage.map((c) => `<tr>
<th scope="row">${FIELD_LABEL[c.field]}${c.field === 'license' ? ' <span class="cell-note">open weights only</span>' : ''}</th>
<td>${c.recorded}/${c.scope}</td>
<td>${c.undisclosed}</td>
<td${c.unresearched ? ' class="cell-gap"' : ''}>${c.unresearched}</td>
</tr>`).join('')}
<tr><th scope="row">Modalities</th><td>${modalities}/${total}</td><td>0</td><td class="cell-gap">${total - modalities}</td></tr>
</tbody></table>
<p class="doc-note">Modalities are new to schema 1.6. The earlier schema recorded
<em>that</em> a model was multimodal but never <em>which</em> modalities, so these are
being researched from primary sources rather than back-filled with assumptions.</p>

<h2>Fact-level evidence</h2>
<p class="chart-note">A record-level status says the record was checked. This says
<em>which source states which number</em>, so a figure can be traced without taking
the badge on trust. Three fields carry it so far — doing every field at once is what
makes this kind of work never ship.</p>
${barRows(EVIDENCED_FIELDS.map((f) => {
  const applicable = releases.filter((r) => assertedValue(r, f) != null);
  const backed = applicable.filter((r) => evidenceFor(r, f).sources.length);
  return {
    name: FIELD_LABEL[f] ?? f,
    value: pct(backed.length, applicable.length),
    display: `${backed.length}/${applicable.length}`,
  };
}))}
${conflicts.length ? `<p class="doc-note"><strong>${conflicts.length} record${
  conflicts.length === 1 ? ' has' : 's have'} sources that disagree.</strong> Both values are
published rather than resolved silently: ${conflicts.map((r) =>
  `<a href="../models/${esc(r.id)}/">${esc(r.model)}</a>`).join(', ')}.</p>`
  : '<p class="doc-note">No record currently has sources that disagree with each other. Where that happens, both values are published rather than one being chosen silently.</p>'}

<h2>Pricing and benchmarks</h2>
<p class="chart-note">Both were nearly left out of this project, on the grounds that a
price changes silently and a citation to a live page rots. The answer was to cite dated
snapshots instead: a pricing entry whose source has no archive is <strong>rejected by the
build</strong>, so every price here is evidenced as of a specific capture.</p>
<table class="doc-table quality-table">
<thead><tr><th>Field</th><th>Recorded</th><th>Note</th></tr></thead>
<tbody>
<tr><th scope="row">Token pricing</th><td>${withPricing}/${total}</td>
<td class="cell-note">only where the lab stated a price in a source we hold a snapshot of</td></tr>
<tr><th scope="row">Benchmarks</th><td>${withBenchmarks}/${total}</td>
<td class="cell-note">recorded as dated claims; no composite score is published</td></tr>
</tbody></table>
<p class="doc-note">Most labs do not state a price in the announcement itself, and this
dataset does not chase the current price on a live pricing page — that would be a number
without a date, which is the thing it is trying not to publish.</p>

<h2>Verification by lab</h2>
<p class="chart-note">Share of each lab's tracked releases that are fully verified.
Labs that publish detailed model cards verify faster; that is a fact about them, not about their models.</p>
${barRows(labRows, { unit: '%' })}

<h2>What is not covered</h2>
<p class="doc-note">This dataset tracks <strong>${total} releases from ${byLab.size} labs</strong>.
It is not a complete census and does not imply one. Notable absences include Ai2 (OLMo),
TII (Falcon), Baidu, ByteDance, Reka and Stability, along with most fine-tunes,
quantisations and community derivatives, which are out of scope by design.
Naming the gaps is more useful than a number that implies there are none.</p>

<h2>Records not yet verified</h2>
<p class="chart-note">${unproven.length} of ${total}. Each says which fact is unproven.</p>
<ol class="doc-list quality-list">${unproven.map((r) => `<li>
<span class="doc-mark sm">${glyph(r.company)}</span>
<a class="cell-name" href="../models/${esc(r.id)}/">${esc(r.model)}</a>
<span class="cell-meta">${esc(r.provenance.reason ?? '')}</span>
</li>`).join('')}</ol>

<p class="doc-cta"><a href="../analytics/">See release analytics →</a></p>
`;

  return page({
    title: 'Data quality — what this dataset can prove | LLM World',
    description: `Verification status, source authority and specification coverage across ${total} tracked LLM releases, including what is missing and why.`,
    canonical: `${BASE_URL}/data-quality/`,
    section: 'data-quality/',
    depth: 1,
    sprites: [...new Set(releases.map((r) => slugFor(r.company)))],
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
      <span class="chart-value">${r.display ?? `${r.value}${unit}`}</span>
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

/**
 * Multimodality over time, from researched modalities only.
 *
 * This is the question the modality research existed to answer. Records with
 * null modalities are excluded from BOTH sides of the fraction rather than
 * counted as text-only — otherwise unresearched years would render as a
 * confident "100% text-only" and the chart would describe our coverage instead
 * of the models.
 */
function modalityEvolution() {
  const known = releases.filter((r) => r.modalities);
  const byYear = new Map();
  for (const r of known) {
    const e = byYear.get(r.year) ?? { n: 0, multi: 0 };
    e.n++;
    if (r.modalities.input.length > 1 || r.modalities.output.length > 1) e.multi++;
    byYear.set(r.year, e);
  }

  const inputCounts = new Map();
  for (const r of known) for (const m of r.modalities.input) {
    inputCounts.set(m, (inputCounts.get(m) ?? 0) + 1);
  }

  return {
    researched: known.length,
    rows: [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([y, e]) => ({
      name: String(y),
      value: Math.round(e.multi / e.n * 100),
      display: `${e.multi}/${e.n}`,
      href: `../timeline/${y}/`,
    })),
    inputs: [...inputCounts.entries()].sort((a, b) => b[1] - a[1])
      .map(([m, n]) => ({ name: sentence(m), value: n })),
  };
}

function analyticsPage(byCompany, byYear) {
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const modalityYears = modalityEvolution();

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

<h2>When models stopped being text-only</h2>
<p class="chart-note">Share of each year's releases that accept or produce more than
text, counting only releases whose modalities have been researched. The denominator is
small in early years, so read the counts rather than the percentages.
${modalityYears.researched} of ${releases.length} records have modalities recorded —
see <a href="../data-quality/">data quality</a>.</p>
${barRows(modalityYears.rows)}

<h2>Input modalities in use</h2>
<p class="chart-note">Across every release with researched modalities. A model
counts once per modality it accepts.</p>
${barRows(modalityYears.inputs)}

<p class="doc-cta">
  <a href="../compare/">Compare models side by side →</a><br>
  <a href="../families/">Follow a family through its generations →</a>
</p>
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
import { dateParts, contextWindow, parameterCount, fieldState, MISSING_LABEL } from '../lib/record.mjs';
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
  ['Context window', (r) => r.technical.context_window
    ? tokens(r.technical.context_window) + ' tokens'
    : MISSING_LABEL[fieldState(r, 'context_window')]],
  ['Parameters',     (r) => r.technical.parameter_count != null
    ? fmtParams(r.technical.parameter_count)
    : MISSING_LABEL[fieldState(r, 'parameter_count')]],
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
write('data-quality', dataQualityPage());

const byFamily = new Map();
for (const r of releases) (byFamily.get(r.family) ?? byFamily.set(r.family, []).get(r.family)).push(r);
for (const [name, list] of byFamily) write(`families/${familySlug(name)}`, familyPage(name, list));
write('families', familiesIndexPage(byFamily));

// Dataset-declared redirects: URLs that were public before a record changed
// shape. Kept in the data rather than hardcoded here.
for (const rd of data.redirects ?? []) {
  const depth = rd.from.split('/').length;
  write(rd.from, page({
    title: 'Moved | LLM World',
    description: rd.reason,
    canonical: `${BASE_URL}/${rd.to}/`,
    section: 'models/',
    depth,
    sprites: [],
    head: `<meta http-equiv="refresh" content="0; url=${'../'.repeat(depth)}${esc(rd.to)}/">`,
    body: `<h1>Moved</h1>
<p class="doc-sub">${esc(rd.reason)}</p>
<p class="doc-cta"><a href="${'../'.repeat(depth)}${esc(rd.to)}/">Continue →</a></p>`,
  }));
}

for (const m of milestones) write(`milestones/${m.id}`, milestonePage(m));
if (milestones.length) write('milestones', milestonesIndexPage(milestones));

// These were model URLs before the products moved out. They were public, so
// they keep resolving rather than 404ing.
for (const m of milestones) {
  write(`models/${m.id}`, page({
    title: `${m.title} — ${eventDate(m.date)} | LLM World`,
    description: `${m.id} is recorded as a milestone, not a model.`,
    canonical: `${BASE_URL}/milestones/${m.id}/`,
    section: 'models/',
    depth: 2,
    sprites: [slugFor(m.company)],
    head: `<meta http-equiv="refresh" content="0; url=../../milestones/${esc(m.id)}/">`,
    body: `<h1>Moved</h1>
<p class="doc-sub">${esc(m.title.replace(/ launches$/, ''))} is a product, not a model, so it is
recorded as a <a href="../../milestones/${esc(m.id)}/">milestone</a>.</p>
<p class="doc-cta"><a href="../../milestones/${esc(m.id)}/">Continue →</a></p>`,
  }));
}
write('compare', comparePage());

const BASE = BASE_URL;
const urls = [
  `${BASE}/models/`, `${BASE}/companies/`, `${BASE}/latest/`,
  `${BASE}/analytics/`, `${BASE}/compare/`, `${BASE}/data-quality/`, `${BASE}/families/`,
  ...(milestones.length ? [`${BASE}/milestones/`] : []),
  ...milestones.map((m) => `${BASE}/milestones/${m.id}/`),
  ...[...new Set(releases.map((r) => r.family))].map((f) => `${BASE}/families/${familySlug(f)}/`),
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

console.log(`built ${releases.length} model pages · ${byFamily.size} family pages · ${milestones.length} milestones · ${byCompany.size} company pages · ` +
  `${byYear.size} year pages · sitemap (${urls.length} urls)`);
if (!EXPORT) console.log('  bulk export skipped — pass --export to enable');
