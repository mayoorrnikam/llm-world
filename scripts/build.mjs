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
import { execFileSync } from 'node:child_process';
import {
  dateParts, stamp, displayTags, contextWindow, parameterCount, tagLabel, diffRecords,
  fieldState, appliesTo, evidenceFor, assertedValue, EVIDENCED_FIELDS, lineageOf,
  MISSING_LABEL, SOURCE_LABEL, AUTHORITY_LABEL, logoSlug, monogram,
} from '../lib/record.mjs';
import { contextFrontier, stepChartSvg, tokenLabel } from '../lib/chart.mjs';
import {
  fieldHistory, historyTable, historySources, historyCaveats,
  openWeightsByYear, openWeightsTable, openWeightsFrontier, openWeightsFrontierTable,
  frontierUnsourced, frontierLevel, LEVEL_TOLERANCE, historyClaims, frontierClaims,
} from '../lib/history.mjs';

const EXPORT = process.argv.includes('--export');
const CHECK = process.argv.includes('--check');
const OUT = CHECK ? '.build-check' : '.';
/** Canonical repository, for linking a change to the commit that made it. */
const REPO_URL = 'https://github.com/mayoorrnikam/llm-world';

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
 * `draft: true` keeps a milestone off the site, exactly as it does for posts.
 *
 * Milestones may be dated from reputable media rather than the company's own
 * announcement, which is allowed (a secondary-only milestone is
 * partially_verified, never verified). That makes a review step worth having:
 * research lands in the repository as a draft, a person checks the date against
 * the quoted evidence, and publishing is flipping one flag.
 *
 * Filtered HERE, at the one place the file is read, and mirrored in app.js.
 * The timeline fetches this JSON directly at runtime, so a filter applied only
 * to the static build would hide a draft from /milestones/ and show it on the
 * home page — the two renderers disagreeing about what is published, which is
 * the failure this project designs against.
 *
 * NOT privacy. This repository is public, so a draft is readable on GitHub the
 * moment it is committed. It controls what the SITE publishes.
 */
const draftMilestones = milestones.filter((m) => m.draft === true);
milestones = milestones.filter((m) => m.draft !== true);

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

// Company → logo/colour slug now lives in lib/record.mjs, imported below
// with the other shared derived facts. See the note there.
const slugFor = logoSlug;
const companySlug = (c) => c.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** "o-series" → "o-series", "GPT-OSS" → "gpt-oss". Same rule as companies. */
const familySlug = (f) => f.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const esc = (s) => String(s).replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const fullDate = (r) => `${MONTHS[r.month - 1]}${r.day ? ` ${r.day}` : ''}, ${r.year}`;

/**
 * A breadcrumb trail. `up` is the depth prefix, then [label, href?] steps —
 * the last step omits href and renders as text.
 *
 * Hand-typed at seventeen sites before this, and they had drifted: eleven were
 * missing `aria-label="Breadcrumb"`, and the separator was written three ways
 * (a literal ›, `&rsaquo;`, and one wrapped in aria-hidden while the others
 * were read aloud). A screen reader announced the same navigation differently
 * depending on which page you were on.
 *
 * Labels are passed already-escaped, because most call sites already had an
 * esc() around a model or company name and double-escaping them would print
 * the entities.
 */
/**
 * One row of an index list: company mark, name, secondary, figure.
 *
 * Written out eight times before this, differing only in the link depth and
 * which field went in the middle. The hue is set as an inline --c so the mark
 * and the row's left edge pick up the company colour without a per-company
 * rule; `company` is omitted only by the labs index, whose rows ARE companies.
 */
/**
 * Modality glyphs — what goes in and what comes out, at a glance.
 *
 * A list row said "GPT-4o" and "Nano Banana 2" in identical type, and nothing
 * on it distinguished a text model from an image generator. The dataset knows:
 * 119 of 180 records carry researched modalities and 57 are multimodal. That
 * fact was only visible by opening the record.
 *
 * Lucide (ISC), inlined like the company marks — nothing is fetched at runtime.
 *
 * COLOUR IS NOT USED. These are shapes, and each carries a <title>, because the
 * page already spends its one colour channel on company identity (CLAUDE.md,
 * Design constraints) and a second hue-coded axis would collide with it.
 *
 * A record with no researched modalities renders NOTHING rather than a neutral
 * placeholder — an empty slot reads as "not looked at", which is exactly what
 * it is, where a grey icon would read as "text only".
 */
const MODALITY_GLYPH = {
  text: 'M17 6.1H3M21 12.1H3M15.1 18H3',
  image: 'M3 5.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 20',
  audio: 'M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3',
  video: 'M3 6.5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 10l6-3.5v11L15 14',
};

const MODALITY_LABEL = { text: 'Text', image: 'Image', audio: 'Audio', video: 'Video' };

/** The union of a record's input and output modalities, in a stable order. */
const modalityMarks = (r) => {
  if (!r.modalities) return '';
  const seen = [...new Set([...r.modalities.input, ...r.modalities.output])]
    .filter((m) => MODALITY_GLYPH[m]);
  if (!seen.length) return '';
  const inOut = (m) => {
    const i = r.modalities.input.includes(m);
    const o = r.modalities.output.includes(m);
    return i && o ? 'in and out' : i ? 'input' : 'output';
  };
  return `<span class="mods">${seen.map((m) =>
    `<svg class="mod" viewBox="0 0 24 24" role="img" aria-label="${
      esc(MODALITY_LABEL[m])} ${esc(inOut(m))}"><title>${
      esc(MODALITY_LABEL[m])} ${esc(inOut(m))}</title><path d="${MODALITY_GLYPH[m]}"/></svg>`).join('')}</span>`;
};

const listRow = ({ company, href, name, meta, num, data, marks }) =>
  `<li${company ? ` style="--c:var(--c-${slugFor(company)})"` : ''}${
    data ? Object.entries(data).map(([k, v]) => ` data-${k}="${esc(String(v))}"`).join('') : ''}>`
  + `${companyMark(company ?? name, 'sm')}`
  + `<a class="cell-name" href="${href}">${name}</a>`
  + `<span class="cell-meta">${meta}</span>`
  // ALWAYS emitted, even empty. This is a grid, and a conditionally absent
  // cell does not leave a hole — every later cell shifts left by one track. A
  // row with no researched modalities put its date in the 68px glyph column
  // and clipped it to "August 14, 2" on 61 of 180 rows.
  + (marks || '<span class="mods"></span>')
  + `<span class="cell-num">${num}</span></li>`;

const crumbs = (up, ...steps) => `<nav class="crumbs" aria-label="Breadcrumb">`
  + `<a href="${up}">Home</a>`
  + steps.map(([label, href]) => ' <span aria-hidden="true">&rsaquo;</span> '
    + (href ? `<a href="${href}">${label}</a>` : `<span>${label}</span>`)).join('')
  + `</nav>`;

/** A YYYY-MM-DD string as prose. Sources carry `retrieved` in that form. */
const fullDateISO = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return String(iso);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

/**
 * The claim a traced value makes, written as a sentence.
 *
 * An evidence panel that opens onto "context_window: 128000" restates the row
 * the reader just clicked. The point is to say what is being ASSERTED, so the
 * source underneath it can be judged against a claim rather than a field name.
 */
const CLAIM_TEXT = {
  release_date: (v, r) => `${r.model} was released on ${fullDateISO(v)}.`,
  context_window: (v, r) => `${r.model} supports a context window of ${
    Number(v).toLocaleString('en-US')} tokens.`,
  parameter_count: (v, r) => `${r.model} has ${
    Number(v).toLocaleString('en-US')} parameters.`,
};
const isoDate = (r) => `${r.year}-${String(r.month).padStart(2, '0')}` +
  (r.day ? `-${String(r.day).padStart(2, '0')}` : '');

// SOURCE_LABEL is imported from lib/record.mjs so the static pages and the
// browser app cannot describe the same source differently.
const PROV_LABEL = {
  verified: 'verified', partially_verified: 'partly verified',
  unverified: 'unverified', conflicting: 'conflicting', estimated: 'approximate date',
};

// Two source files, one copy of each thing. The landing page owns the shared
// header and footer; the timeline owns the logo sprite, because it is the page
// that renders every company at once. Neither is duplicated.
const indexHtml = readFileSync('index.html', 'utf8');
const timelineHtml = readFileSync('timeline.html', 'utf8');
// One copy of the logos, in sprite.svg. Both the generated pages and the
// landing page read it from there; nothing inlines a second copy.
const spriteSvg = readFileSync('sprite.svg', 'utf8');
const SPRITE = Object.fromEntries(
  [...spriteSvg.matchAll(/<g id="(ic-[a-z0-9]+)"[\s\S]*?<\/g>/g)]
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

const glyph = (company) => {
  const slug = slugFor(company);
  // No logo → initials, never a generic grey mark. See monogram() in
  // lib/record.mjs. In practice smoke fails the build before a dataset company
  // can reach here, so this is the safety net rather than the usual path.
  return slug === 'other'
    ? `<span class="mark-mono">${esc(monogram(company))}</span>`
    : `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">`
      + `<use href="#ic-${slug}"></use></svg>`;
};

/** The framed mark: the hue sits on the container so the tint can mix from it. */
const companyMark = (company, cls = '') =>
  `<span class="doc-mark${cls ? ` ${cls}` : ''}" style="--c:var(--c-${slugFor(company)})">`
  + `${glyph(company)}</span>`;

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

/**
 * "What changed" against the previous release in the same FAMILY.
 *
 * The family predecessor, not the lab's previous release: GPT-4o follows GPT-4,
 * and putting it next to whatever OpenAI happened to ship most recently
 * compares two unrelated products. Families already order by date on the family
 * page, so the same neighbour is used here and the two pages cannot disagree.
 *
 * Rendered statically. This is a fact about two records that never changes
 * between builds, so it needs no JavaScript — the compare page computes the
 * same thing at runtime only because its pair is chosen by the reader.
 */
function changedSection(prev, next) {
  if (!prev) return '';
  const { changes, incomparable } = diffRecords(prev, next);
  if (!changes.length && !incomparable.length) return '';

  const rows = changes.map((c) => `<li data-direction="${esc(c.direction)}">`
    + `<span class="cmp-diff-label">${esc(c.label)}</span>`
    + `<span class="cmp-diff-value">${esc(c.gained ? c.gained.join(', ') : `${c.from} → ${c.to}`)}</span>`
    + `</li>`).join('');

  return `
<h2>What changed from ${esc(prev.model)}</h2>
<p class="chart-note">Compared with the previous release in this family. A field
appears only when both records state a value — where one does not, it is listed
as uncomparable rather than dropped, because a gap in our research is not a
finding about the model.</p>
<div class="cmp-diff">
${rows ? `<ul class="cmp-diff-list">${rows}</ul>` : ''}
${incomparable.length ? `<p class="cmp-diff-gap">Not comparable: ${
  esc(incomparable.map((x) => `${x.label} (${x.why})`).join('; '))}</p>` : ''}
<p class="doc-note"><a href="../../compare/?m=${esc(prev.id)},${esc(next.id)}">Compare them side by side →</a></p>
</div>`;
}

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
<link rel="alternate" type="application/rss+xml" title="LLM World — tracked model releases" href="${up}feed.xml">
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
<script defer>
/* Copy this view.
   Every view here is already addressable — the URL carries the filters, the
   picks, the year. Nothing surfaced that, so a reader who wanted to cite a
   comparison had to know to copy the address bar. This is progressive
   enhancement: the buttons are rendered by the page and only become useful
   here, so a reader without JavaScript sees no dead control. */
addEventListener('DOMContentLoaded',function(){
  var boxes=document.querySelectorAll('[data-copy]');
  if(!boxes.length)return;
  boxes.forEach(function(btn){
    btn.hidden=false;
    btn.addEventListener('click',function(){
      var url=location.href;
      /* Markdown, because the thing people paste this into is an issue, a PR or
         a doc — and a bare URL there loses what it pointed at. */
      var text=btn.dataset.copy==='md'
        ? '['+(btn.dataset.copyTitle||document.title)+']('+url+')'
        : url;
      /* Capture the label ONCE, from the markup, so a second click never
         restores "Copied" or "Press ⌘C" as if it were the button's name. The
         first version read textContent at click time and a failed copy left the
         button permanently mislabelled. */
      if(!btn.dataset.label)btn.dataset.label=btn.textContent;
      var restore=function(){setTimeout(function(){btn.textContent=btn.dataset.label;},1400);};
      btn.setAttribute('aria-live','polite');
      navigator.clipboard.writeText(text).then(function(){
        btn.textContent='Copied';
        restore();
      }).catch(function(){
        /* Clipboard writes need a secure origin and a real user gesture, and
           some policies block them outright. Say so rather than doing nothing
           silently — then put the label back. */
        btn.textContent='Press ⌘C';
        restore();
      });
    });
  });
});
</script>
<script defer>
/* Surprise me.
   A database you can only query is a database you have to already have a
   question about. This is the way in for a reader who does not — one click,
   another record, keep going.
   The id list is fetched lazily ON CLICK rather than inlined into all 169 model
   pages, and the current record is excluded so the button never appears to do
   nothing. */
addEventListener('DOMContentLoaded',function(){
  var b=document.getElementById('surprise');if(!b)return;
  b.hidden=false;
  b.addEventListener('click',function(){
    b.disabled=true;
    fetch('${up}data/llm-releases.json',{cache:'force-cache'})
      .then(function(r){return r.json();})
      .then(function(d){
        var here=location.pathname.replace(/\\/$/,'').split('/').pop();
        var ids=d.releases.map(function(r){return r.id;}).filter(function(id){return id!==here;});
        if(!ids.length){b.disabled=false;return;}
        location.href='${up}models/'+ids[Math.floor(Math.random()*ids.length)]+'/';
      })
      .catch(function(){b.disabled=false;b.textContent='Could not load';});
  });
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

/**
 * Every page written, so the sitemap can be derived rather than remembered.
 *
 * The sitemap used to be a hand-maintained array beside the writes, which meant
 * adding a route was two edits and the second one is invisible when you forget
 * it — the page builds, the site works, and search engines never hear about it.
 * /methodology/, /taxonomy/, /changes/ and /analytics/context-windows/ were all
 * live and all absent from the sitemap for exactly that reason.
 *
 * Redirect stubs are excluded: a sitemap should list destinations, not the URLs
 * that point at them.
 */
const WRITTEN = new Set();

const write = (path, html, { sitemap = true } = {}) => {
  const dir = join(OUT, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  if (sitemap) WRITTEN.add(path);
};

/* --------------------------------------------------------------- templates */

/**
 * The record's evidence state, at the top of the page instead of buried.
 *
 * A model page opened with the name, the lab and the date, and said nothing
 * about whether any of it had been checked — while the dataset knew precisely,
 * for every field, whether a figure was traced to a source, withheld by the
 * lab, or simply never researched. The strongest thing about this project was
 * three scrolls down.
 *
 * Restrained on purpose. Nothing here is green or red: a verified record is not
 * "good news" and an unresearched field is not an error, it is an honest gap.
 * The states are distinguished by weight and a leading mark, not by hue alone,
 * so they survive a monochrome screen and forced colours.
 *
 * The counts are the part that cannot overclaim. "Verified" on its own invites
 * a reader to assume every number on the page is checked; "3 of 5 values traced
 * to a source" says exactly what was done.
 */
/**
 * The source list under a record.
 *
 * There were two copies: modelPage and milestonePage carried these same
 * lines character for character, differing only in whether the record was
 * called `r` or `m`.
 */
/**
 * Context window over time, as a bar per release.
 *
 * companyPage and familyPage carried these five lines identically. Only the
 * surrounding prose differed, so the prose stays at the call sites and the
 * chart is stated once.
 */
const ctxOverTime = (ctxPoints) => barRows(ctxPoints.map((r) => ({
  name: `${r.model} · ${r.year}`,
  value: r.technical.context_window,
  display: tokens(r.technical.context_window),
  href: `../../models/${esc(r.id)}/`,
})));

const sourceList = (rec) => `<ul class="doc-sources">${rec.sources.map((s) =>
  `<li><a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a> <span>${esc(SOURCE_LABEL[s.type] ?? s.type)}</span> <span class="src-authority" data-authority="${esc(s.authority)}">${esc(AUTHORITY_LABEL[s.authority] ?? s.authority)}</span>${
    s.archived_url ? ` <a class="src-archive" href="${esc(s.archived_url)}" rel="noopener noreferrer nofollow">archived</a>` : ''}</li>`).join('')}</ul>`;

function provenanceBar(r) {
  const status = r.provenance?.status ?? 'unverified';

  const LABEL = {
    verified: 'Verified',
    partially_verified: 'Partially verified',
    estimated: 'Estimated',
    unverified: 'Not verified',
  };

  // Fields this record could carry, and what is actually known about each.
  const fields = ['release_date', 'context_window', 'parameter_count']
    .filter((f) => appliesTo(r, f));
  const traced = fields.filter((f) => evidenceFor(r, f).sources.length).length;
  const asserted = fields.filter((f) => assertedValue(r, f) != null).length;

  const undisclosed = (r.undisclosed ?? []).length;
  const unresearched = ['context_window', 'parameter_count', 'license']
    .filter((f) => appliesTo(r, f) && fieldState(r, f) === 'unresearched').length;

  const archived = r.sources.filter((x) => x.archived_url).length;
  const primary = r.sources.filter((x) => x.authority === 'primary').length;

  const bits = [
    `<span class="pv-fact"><strong>${traced}</strong> of ${asserted} published values traced to a source</span>`,
    `<span class="pv-fact"><strong>${primary}</strong> primary source${primary === 1 ? '' : 's'}, ${archived} archived</span>`,
  ];
  if (undisclosed) {
    bits.push(`<span class="pv-fact"><strong>${undisclosed}</strong> not disclosed by the lab</span>`);
  }
  if (unresearched) {
    bits.push(`<span class="pv-fact pv-gap"><strong>${unresearched}</strong> not researched yet</span>`);
  }

  return `<div class="pv" data-status="${esc(status)}">
<p class="pv-head"><span class="pv-dot" aria-hidden="true"></span>${esc(LABEL[status] ?? status)}</p>
<p class="pv-facts">${bits.join('')}</p>
${r.provenance?.reason ? `<details class="pv-why"><summary>Why this status</summary>
<p>${esc(r.provenance.reason)}</p></details>` : ''}
<p class="pv-more"><a href="../../methodology/">What these states mean</a> · <a href="../../data-quality/">How records are judged</a> · <a href="../../changes/">Has this record changed?</a></p>
</div>`;
}

/**
 * Where to go for the things this dataset deliberately does not hold.
 *
 * Pricing sits at 21% of records and benchmarks at 7%, and neither will ever be
 * complete here: a price is true for a quarter and a leaderboard changes weekly,
 * while every figure in this dataset has to be traced to a dated primary source
 * before it can be published. That is the wrong shape for live data, and
 * OpenRouter, Artificial Analysis and Hugging Face already do it properly.
 *
 * So the gap is stated as a boundary rather than left looking like neglect.
 * This dataset answers "what was true, when, and who said so"; these answer
 * "what is true right now". Links are search queries rather than deep links,
 * because a guessed model slug on someone else's site 404s the moment they
 * rename something, and a dead link is worse than one extra click.
 */
function elsewhere(r) {
  const q = encodeURIComponent(r.model);
  const links = [
    ['Current price and providers', `https://openrouter.ai/models?q=${q}`, 'OpenRouter'],
    ['Current benchmark scores', `https://artificialanalysis.ai/models?q=${q}`, 'Artificial Analysis'],
  ];
  if (r.access?.open_weights) {
    links.push(['Weights and model card', `https://huggingface.co/models?search=${q}`, 'Hugging Face']);
  }
  return `
<section class="elsewhere">
  <h2>Current information, elsewhere</h2>
  <p>This record is a historical one: every figure above is traced to a dated
  primary source. For what is true <em>today</em> — live pricing, current
  rankings, availability — these are better maintained than anything here
  could be.</p>
  <ul class="elsewhere-list">
${links.map(([what, href, who]) =>
    `    <li><span class="el-what">${what}</span> <a href="${esc(href)}" rel="noopener nofollow">${who} \u2197</a></li>`).join('\n')}
  </ul>
</section>`;
}

/**
 * The page header: optional company mark, title, optional standfirst.
 *
 * Hand-typed at fourteen sites in three shapes — with a mark, bare, and wrapped
 * in a `doc-heading` div that styles.css never defined. Three treatments of one
 * object, and the dead class was emitted on four pages.
 *
 * `title` and `sub` are passed already-escaped: most call sites already wrap a
 * model or company name in esc(), and escaping twice prints the entities.
 */
const hero = ({ mark = '', title, sub = '' }) => `<div class="doc-hero">${
  mark ? `\n  ${mark}` : ''}
  <div>
    <h1>${title}</h1>${sub ? `\n    <p class="doc-sub">${sub}</p>` : ''}
  </div>
</div>`;

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

    /**
     * The evidence behind ONE value, opened in place.
     *
     * The previous version was a bare link with the source type hidden in a
     * `title` attribute — invisible on touch, unreadable to most screen readers,
     * and silent about the two things that decide how much a figure is worth:
     * whether the source is primary, and when it was read.
     *
     * A <details> rather than a scripted popover, because this is the one part
     * of the site that must still work when nothing else does. Provenance that
     * depends on JavaScript is provenance a reader cannot check.
     */
    const claim = CLAIM_TEXT[field]?.(e.claims[0].value, r) ?? `${field} is ${e.claims[0].value}.`;
    const rows = e.sources.map((s) => {
      const host = esc(new URL(s.url).hostname.replace(/^www\./, ''));
      const when = s.retrieved
        ? `<span class="fact-ev-when">read ${esc(fullDateISO(s.retrieved))}</span>`
        : '';
      return `<li>
<span class="fact-ev-type">${esc(SOURCE_LABEL[s.type] ?? s.type)}</span>
<span class="src-authority" data-authority="${esc(s.authority)}">${esc(AUTHORITY_LABEL[s.authority] ?? s.authority)}</span>
${when}
<a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${host}</a>${
  s.archived_url ? ` <a class="src-archive" href="${esc(s.archived_url)}" rel="noopener noreferrer nofollow">archived</a>`
    : ' <span class="fact-ev-when">no snapshot yet</span>'}
</li>`;
    }).join('');

    return `<details class="fact-ev">
<summary>stated in ${e.sources.map((s) => esc(new URL(s.url).hostname.replace(/^www\./, ''))).join(', ')}</summary>
<div class="fact-ev-body">
<p class="fact-ev-claim">${esc(claim)}</p>
<ul class="fact-ev-list">${rows}</ul>
</div>
</details>`;
  };

  const facts = [
    ['Released', fullDate(r), cite('release_date')],
    ['Company', r.company],
    ['Family', r.family],
    /**
     * Where this sits in its family. Derived in lib/record.mjs, never stored —
     * and same-day releases are shown as siblings rather than a chain, because
     * GPT-5.6 Sol, Luna and Terra are one launch of three sizes and ordering
     * them by date would invent a succession OpenAI never announced.
     */
    ...(() => {
      const l = lineageOf(r, releases);
      const link = (x) => `<a href="../${esc(x.id)}/">${esc(x.model)}</a>`;
      const rows = [];
      if (l.predecessor || l.successor) {
        // Third slot, not second: the renderer escapes the value and leaves the
        // third raw, which is the right default — links belong in the raw one.
        rows.push(['Lineage', '', [
          l.predecessor ? `after ${link(l.predecessor)}` : null,
          l.successor ? `before ${link(l.successor)}` : null,
        ].filter(Boolean).join(' · ')]);
      }
      if (l.siblings.length) {
        rows.push(['Released alongside', '', l.siblings.map(link).join(' · ')]);
      }
      return rows;
    })(),
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
${crumbs('../../', [esc(r.company), `../../companies/${companySlug(r.company)}/`], [esc(r.model)])}

<div class="doc-hero">
  ${companyMark(r.company)}
  <div>
    <h1>${esc(r.model)}</h1>
    <p class="doc-sub">${esc(r.company)} · <time datetime="${isoDate(r)}">${fullDate(r)}</time>${
      prev ? ` · ${daysBetween(prev, r)} days after <a href="../${esc(prev.id)}/">${esc(prev.model)}</a>` : ''}</p>
  </div>
</div>

${provenanceBar(r)}

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

${elsewhere(r)}

<h2>Sources</h2>
<p class="doc-prov">Record status: <span class="prov-badge" data-status="${esc(r.provenance.status)}">${
  esc(PROV_LABEL[r.provenance.status] ?? r.provenance.status)}</span> · confidence ${r.provenance.confidence}/100 ·
${r.sources.filter((s) => s.authority === 'primary').length} of ${r.sources.length} primary</p>
${r.provenance.reason ? `<p class="doc-reason">${esc(r.provenance.reason)}</p>` : ''}
${sourceList(r)}
<p class="doc-note">Primary means published by the organisation that made the model.
<strong>Verified</strong> records require at least one.</p>

<h2>${esc(r.family)} family</h2>
<ol class="doc-lineage">${fam.map((x, i) => `<li${x.id === r.id ? ' aria-current="true"' : ''}>${
  x.id === r.id ? `<strong>${esc(x.model)}</strong>` : `<a href="../${esc(x.id)}/">${esc(x.model)}</a>`
} <span>${fullDate(x)}</span></li>`).join('')}</ol>

${changedSection(fam[idx - 1], r)}

<p class="doc-share">
  <button type="button" class="copy-btn" data-copy="url" hidden>Copy link</button>
  <button type="button" class="copy-btn" data-copy="md" data-copy-title="${esc(r.model)} — ${esc(r.company)}" hidden>Copy as Markdown</button>
  <a class="copy-btn copy-btn--link" href="../">Browse models</a>
  <button type="button" class="copy-btn" id="surprise" hidden>🎲 Surprise me</button>
</p>

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

/**
 * The cadence ribbon, server-rendered.
 *
 * The timeline builds this in app.js from live state; these pages are the
 * no-JS, indexable half of the site, so they get a second implementation
 * rather than an import — app.js is a DOM program, not a renderer.
 *
 * One tile is always exactly one release (a unit chart), laid out on a real
 * twelve-month grid per year. Spacing is therefore the DATA's spacing: a year
 * with one release in March and nothing after is a row with one tile and a lot
 * of empty months, and a year with none still gets a row. That is the whole
 * read — an even list of rows cannot show a lab going quiet.
 *
 * Colour is a secondary channel here as everywhere (CLAUDE.md): every tile
 * carries the model, the lab and the date as real text inside the link, so the
 * ribbon is fully readable with the hue channel switched off.
 */
function cadenceRibbon(list, { up, label }) {
  const asc = [...list].sort((a, b) =>
    a.year - b.year || a.month - b.month || (a.day || 0) - (b.day || 0));
  if (!asc.length) return '';

  const years = [];
  for (let y = asc[0].year; y <= asc.at(-1).year; y++) years.push(y);

  const byYear = new Map(years.map((y) => [y, new Map()]));
  for (const r of asc) {
    const months = byYear.get(r.year);
    (months.get(r.month) ?? months.set(r.month, []).get(r.month)).push(r);
  }

  // Row height is set by the busiest month, so a tile means the same amount
  // everywhere on the page instead of being stretched to fill a fixed band.
  const peak = Math.max(1, ...[...byYear.values()]
    .flatMap((months) => [...months.values()].map((v) => v.length)));

  const rows = years.map((y) => {
    const months = byYear.get(y);
    const n = [...months.values()].reduce((a, v) => a + v.length, 0);
    const cells = [...months.entries()].sort((a, b) => a[0] - b[0]).map(([m, rs]) =>
      `<li class="rib-month" style="grid-column:${m}">${rs.map((r) =>
        `<a class="rib-tile" style="--c:var(--c-${slugFor(r.company)})"`
        + ` href="${up}models/${esc(r.id)}/"`
        + ` title="${esc(r.model)} — ${esc(r.company)}, ${fullDate(r)}">`
        + `<span class="sr-only">${esc(r.model)}, ${esc(r.company)}, ${fullDate(r)}</span>`
        + `</a>`).join('')}</li>`).join('');

    return `<li class="rib-year">`
      + `<a class="rib-year-num" href="${up}timeline/${y}/">${y}</a>`
      + `<ol class="rib-months">${cells}</ol>`
      + `<span class="rib-year-n"${n ? '' : ' data-zero="true"'}>${n}</span></li>`;
  }).join('');

  return `<ol class="ribbon-static" style="--rows:${peak}" aria-label="${
    esc(label)} — ${asc.length} release${asc.length === 1 ? '' : 's'} from ${
    years[0]} to ${years.at(-1)}, one tile per release, placed by month.">${rows}</ol>`;
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

  // The ribbon counts its own years, so this is only the "is there more than
  // one year to show" test.
  const years = [...new Set(list.map((r) => r.year))].sort((a, b) => a - b);

  // Only capabilities that have actually been evidenced on this lab's records.
  const capCounts = new Map();
  for (const r of list) for (const c of r.capabilities) capCounts.set(c, (capCounts.get(c) ?? 0) + 1);
  const caps = [...capCounts.entries()].sort((a, b) => b[1] - a[1]);

  const ctxPoints = asc.filter((r) => r.technical.context_window != null);

  const body = `
${crumbs('../../', ['Labs', '../'], [esc(name)])}

<div class="doc-hero">
  ${companyMark(name)}
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

${years.length > 1 ? `<h2>Release cadence</h2>
<p class="chart-note">One tile per tracked release, placed in the month it shipped;
the year links through to that year's timeline. Tracked releases only — a quiet
year here may mean this dataset is thin for that year rather than that the lab
was quiet.</p>
${cadenceRibbon(list, { up: '../../', label: name })}` : ''}

${ctxPoints.length > 1 ? `<h2>Context window over time</h2>
<p class="chart-note">Releases with a disclosed context window${
  ctxPoints.length < list.length ? ` — ${list.length - ctxPoints.length} of ${list.length} not shown` : ''}.</p>
${ctxOverTime(ctxPoints)}` : ''}

${caps.length ? `<h2>Evidenced capabilities</h2>
<p class="chart-note">How often each capability is cited across this lab's releases.
Absence means not evidenced, never absent — see <a href="../../data-quality/">data quality</a>.</p>
${barRows(caps.map(([c, n]) => ({ name: tagLabel(c), value: n })))}` : ''}

<h2>Releases</h2>
<ol class="doc-list cols-3">${sorted.map((r) =>
  listRow({ company: r.company, href: `../../models/${esc(r.id)}/`, name: esc(r.model), meta: esc(r.family), num: fullDate(r) , marks: modalityMarks(r) })).join('')}</ol>

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
${crumbs('../../', [year])}
${hero({
  title: `LLM releases in ${year}`,
  sub: `${list.length} tracked release${list.length === 1 ? '' : 's'}${
    yearMilestones.length ? ` · ${yearMilestones.length} milestone${yearMilestones.length === 1 ? '' : 's'}` : ''} · ${eraFor(year)}`,
})}
${yearMilestones.length ? `<h2>Milestones</h2>
<p class="chart-note">Dated events that mattered without being model releases.</p>
<ol class="doc-list">${yearMilestones.map((m) =>
    listRow({ company: m.company, href: `../../milestones/${esc(m.id)}/`, name: esc(m.title), meta: esc(m.company), num: esc(eventDate(m.date)) })).join('')}</ol>` : ''}
${[...byMonth.keys()].sort((a, b) => a - b).map((m) => `
<h2>${MONTHS[m - 1]} ${year}</h2>
<ol class="doc-list">${byMonth.get(m).map((r) =>
  listRow({ company: r.company, href: `../../models/${esc(r.id)}/`, name: esc(r.model), meta: esc(r.company), num: fullDate(r), marks: modalityMarks(r) })).join('')}</ol>`).join('')}
<p class="doc-cta"><a href="../../?year=${year}">See ${year} on the interactive timeline →</a></p>
`;
  return page({
    title: `LLM releases in ${year} — full timeline | LLM World`,
    description: `Every tracked large language model released in ${year}, by month, with companies, dates and sources.`,
    canonical: `${BASE_URL}/timeline/${year}/`,
    section: 'timeline/',
    depth: 2,
    sprites: [...new Set(list.map((r) => slugFor(r.company)))],
    body,
  });
}

/** Index of every tracked model, newest first, grouped by year. */
/**
 * A filter bar over an already-rendered list, as markup plus its behaviour.
 *
 * There were two copies of this and the second one arrived carrying a comment
 * admitting it was a copy. They agreed on the whole protocol — a `hidden` bar,
 * a search box, <select> facets, a clear button, a count in a live region, an
 * empty-state line, `li[data-find]` rows, state in the query string — and
 * differed only in an id prefix, the facet list, and whether the noun was
 * "releases" or "records".
 *
 * PROGRESSIVE ENHANCEMENT IS THE POINT. These pages are static so they can be
 * indexed and read without JavaScript; the full list stays in the HTML and this
 * only hides rows once it loads. The controls ship `hidden` so a reader without
 * JavaScript never meets a control that does nothing.
 *
 * The script is assembled by substitution into a plain string rather than
 * written as a nested template literal. build.mjs is itself a template, so a
 * `${}` meant for the browser has to be escaped from the build — and
 * `node --check`, which smoke runs, validates syntax but not which stage a
 * substitution belongs to. Getting that wrong produces valid JavaScript that
 * does the wrong thing. Avoiding the nesting avoids the class.
 */
function filterBar({ prefix, noun, placeholder, facets, rowSelector, groupHeadings = false }) {
  const markup = `
<div class="filterbar" id="${prefix}" hidden>
  <label class="filterbar-search">
    <span class="sr-only">${esc(placeholder)}</span>
    <input type="search" id="${prefix}-q" placeholder="${esc(placeholder)}" autocomplete="off">
  </label>
  ${facets.map((f) => `<label class="filterbar-sel">
    <span class="sr-only">${esc(f.label)}</span>
    <select id="${prefix}-${f.key}"><option value="">${esc(f.label)}: any</option>${
      f.options.map((o) => `<option value="${esc(String(o))}">${
        esc(String(o).replace(/_/g, ' '))}</option>`).join('')}</select>
  </label>`).join('')}
  <button type="button" class="reset-btn" id="${prefix}-clear" hidden>Clear</button>
  <p class="filterbar-count" id="${prefix}-count" role="status"></p>
</div>
<p class="filterbar-empty" id="${prefix}-empty" hidden>Nothing matches those filters.</p>`;

  const HEADINGS = `
    // A year heading with nothing under it is noise, and its count is a lie.
    heads.forEach(function(h){
      var list=h.nextElementSibling; if(!list||list.tagName!=='OL')return;
      var vis=[].slice.call(list.children).filter(function(x){return !x.hidden;}).length;
      h.hidden=vis===0; list.hidden=vis===0;
      if(vis){var a=h.querySelector('a');h.innerHTML='';if(a)h.appendChild(a);
        h.appendChild(document.createTextNode(' — '+vis+' __NOUN_SING__'+(vis===1?'':'s')));}
    });`;

  const BODY = `
addEventListener('DOMContentLoaded',function(){
  var bar=document.getElementById('__P__');if(!bar)return;
  bar.hidden=false;
  var q=document.getElementById('__P__-q'),clear=document.getElementById('__P__-clear'),
      count=document.getElementById('__P__-count'),empty=document.getElementById('__P__-empty'),
      sels=__IDS__.map(function(i){return document.getElementById(i);}),
      rows=[].slice.call(document.querySelectorAll('__ROWS__')),
      heads=[].slice.call(document.querySelectorAll('.doc-main h2'));
  var KEY=__KEYS__;
  function apply(push){
    var text=q.value.trim().toLowerCase(), on=0;
    rows.forEach(function(li){
      var ok=(!text||li.dataset.find.indexOf(text)>=0);
      sels.forEach(function(s){ if(ok&&s.value&&li.dataset[KEY[s.id]]!==s.value) ok=false; });
      li.hidden=!ok; if(ok)on++;
    });__HEADINGS__
    var filtered=!!text||sels.some(function(s){return !!s.value;});
    count.textContent=filtered?(on+' of '+rows.length+' __NOUN__'):(rows.length+' __NOUN__');
    clear.hidden=!filtered; empty.hidden=on>0;
    if(push){
      var p=new URLSearchParams();
      if(text)p.set('q',q.value.trim());
      sels.forEach(function(s){if(s.value)p.set(KEY[s.id],s.value);});
      history.replaceState(null,'',location.pathname+(p.toString()?'?'+p:''));
    }
  }
  var p0=new URLSearchParams(location.search);
  q.value=p0.get('q')||'';
  sels.forEach(function(s){s.value=p0.get(KEY[s.id])||'';});
  q.addEventListener('input',function(){apply(true);});
  sels.forEach(function(s){s.addEventListener('change',function(){apply(true);});});
  clear.addEventListener('click',function(){
    q.value='';sels.forEach(function(s){s.value='';});apply(true);q.focus();
  });
  apply(false);
});`;

  const ids = facets.map((f) => `'${prefix}-${f.key}'`).join(',');
  const keys = facets.map((f) => `'${prefix}-${f.key}':'${f.key}'`).join(',');
  const script = '<script defer>' + BODY
    .split('__P__').join(prefix)
    .split('__IDS__').join('[' + ids + ']')
    .split('__KEYS__').join('{' + keys + '}')
    .split('__ROWS__').join(rowSelector)
    .split('__HEADINGS__').join(groupHeadings ? HEADINGS : '')
    .split('__NOUN_SING__').join(noun.replace(/s$/, ''))
    .split('__NOUN__').join(noun) + '</script>';

  return { markup, script };
}

function modelsIndexPage() {
  const byYear = new Map();
  for (const r of [...releases].reverse()) {
    (byYear.get(r.year) ?? byYear.set(r.year, []).get(r.year)).push(r);
  }
  const mf = filterBar({
    prefix: 'mf',
    noun: 'releases',
    placeholder: 'Search model, lab or family',
    rowSelector: '.doc-list li[data-find]',
    groupHeadings: true,
    facets: [
      { key: 'lab', label: 'Lab', options: [...new Set(releases.map((r) => r.company))].sort() },
      { key: 'year', label: 'Year', options: [...new Set(releases.map((r) => r.year))].sort((a, b) => b - a) },
      { key: 'type', label: 'Type', options: [...new Set(releases.map((r) => r.classification?.primary_type ?? 'language'))].sort() },
      { key: 'weights', label: 'Weights', options: ['open', 'proprietary'] },
    ],
  });

  const body = `
${crumbs('../', ['Models'])}
${hero({
  title: 'All tracked models',
  sub: `${releases.length} releases from ${new Set(releases.map((r) => r.company)).size} labs, newest first`,
})}

${mf.markup}
${[...byYear.keys()].sort((a, b) => b - a).map((y) => `
<h2><a href="../timeline/${y}/">${y}</a> — ${byYear.get(y).length} releases</h2>
<ol class="doc-list">${byYear.get(y).map((r) =>
  listRow({
    company: r.company,
    href: `${esc(r.id)}/`,
    name: esc(r.model),
    meta: esc(r.company),
    num: fullDate(r),
    marks: modalityMarks(r),
    // Facets travel with the row, so filtering never re-reads the dataset —
    // the page already contains every fact the filter needs.
    data: {
      lab: r.company,
      year: r.year,
      type: r.classification?.primary_type ?? 'language',
      weights: r.access.open_weights ? 'open' : 'proprietary',
      find: `${r.model} ${r.company} ${r.family}`.toLowerCase(),
    },
  })).join('')}</ol>`).join('')}
`;
  /**
   * Filtering, as progressive enhancement.
   *
   * 181 rows is about fourteen screens, which is the real complaint. But these
   * pages are static so that they are indexable and readable without
   * JavaScript, so the whole list still ships in the HTML and the bar only
   * HIDES rows once it loads. A reader with no JavaScript gets exactly what
   * they got before, and no dead controls.
   *
   * State lives in the query string like every other view here, so a filtered
   * list is a link somebody can send.
   */


  return page({
    head: mf.script,
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
${crumbs('../', ['Companies'])}
${hero({ title: 'Labs', sub: `${rows.length} organisations, ranked by tracked releases` })}
<p class="chart-note">Ranked by tracked releases. Each lab's own hue and logo are the
same pair used on the timeline's filter chips, so a lab looks the same wherever you
meet it.</p>
<ul class="chips lab-grid">${rows.map(([name, list]) => {
  const latest = [...list].sort((a, b) => b.year - a.year || b.month - a.month || (b.day || 0) - (a.day || 0))[0];
  const n = `${list.length} tracked release${list.length === 1 ? '' : 's'}`;
  // The count is followed by an sr-only noun so the link's accessible name is
  // "OpenAI, 32 releases" rather than "OpenAI 32".
  return `<li><a class="chip lab-chip" style="--c:var(--c-${slugFor(name)})"`
    + ` href="${companySlug(name)}/"`
    + ` title="${esc(name)} — ${n}, latest ${fullDate(latest)}">`
    + `${glyph(name)}<span class="chip-name">${esc(name)}</span>`
    + `<span class="chip-count">${list.length}<span class="sr-only"> releases</span></span>`
    + `</a></li>`;
}).join('')}</ul>
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
${crumbs('../', ['Latest'])}
${hero({
  title: 'Latest releases',
  sub: `The 20 most recent tracked releases · data updated ${esc(data.updated)}`,
})}
<ol class="doc-list">${recent.map((r) => {
  const prev = predecessorOf(r);
  return listRow({
    company: r.company,
    href: `../models/${esc(r.id)}/`,
    name: esc(r.model),
    meta: esc(r.company),
    num: `${fullDate(r)}${prev ? ` · +${daysBetween(prev, r)}d` : ''}`,
    marks: modalityMarks(r),
  });
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
  agent: 'Agent & harness', protocol: 'Protocol',
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
${crumbs('../../', ['Milestones', '../'], [esc(m.title)])}

<div class="doc-hero">
  ${companyMark(m.company)}
  <div>
    <h1>${esc(m.title)}</h1>
    <p class="doc-sub">${esc(m.company)} · <time datetime="${esc(m.date)}">${esc(eventDate(m.date))}</time> ·
    ${esc(MILESTONE_LABEL[m.type] ?? m.type)}</p>
  </div>
</div>

<p class="doc-lede">${esc(m.note)}</p>
${m.significance ? `<p class="doc-note">${esc(m.significance)}</p>` : ''}

${/**
   * The "why this is not a model record" explainer used to sit here. It made
   * sense when milestones were four, the distinction was new, and every visitor
   * arrived from a page full of models. It is redundant now that there are 21
   * behind their own nav entry — and worse, it had gone wrong: it told every
   * reader that this thing "is a product built on a model", which describes
   * ChatGPT and does not describe MCP, a protocol with no product behind it.
   * The one useful thing it carried was the family link, kept below.
   */''}${m.related_family ? `<p class="doc-note">Model line behind it:
<a href="../../families/${familySlug(m.related_family)}/">${esc(m.related_family)}</a>.</p>` : ''}

<h2>Sources</h2>
<p class="doc-prov">Record status: <span class="prov-badge" data-status="${esc(m.provenance.status)}">${
  esc(PROV_LABEL[m.provenance.status] ?? m.provenance.status)}</span> · confidence ${m.provenance.confidence}/100</p>
${m.provenance.reason ? `<p class="doc-reason">${esc(m.provenance.reason)}</p>` : ''}
${sourceList(m)}

<p class="doc-cta"><a href="../../timeline/${m.date.slice(0, 4)}/">See what else happened in ${m.date.slice(0, 4)} →</a></p>
`;

  return page({
    title: `${m.title} — ${eventDate(m.date)} | LLM World`,
    description: `${m.title} on ${eventDate(m.date)}. ${m.note}`.slice(0, 300),
    canonical: `${BASE_URL}/milestones/${m.id}/`,
    // Milestones marked Timeline while there were two of them, with a note here
    // to revisit when there were more. There are 21, spanning the agent era and
    // faceted by kind, so they have their own nav slot and mark it.
    section: 'milestones/',
    depth: 2,
    sprites: [slugFor(m.company)],
    body,
  });
}

/**
 * What a milestone connects to in the model dataset — and nothing more.
 *
 * The ONLY link a milestone record asserts to llm-releases.json is its own
 * `related_family` field. It never names a model. ChatGPT's note mentions
 * GPT-3.5 in prose, but prose is not a field: turning it into a link would be
 * this build inventing a relationship the record does not make, which is
 * exactly the failure mode diffRecords() exists to avoid elsewhere.
 *
 * So the family is the evidenced edge, and the model-page link on top of it is
 * a plain statement about dates *within that family* — "the most recent tracked
 * release in this line before this date". That is arithmetic over two fields,
 * not a claim that the milestone was served by that model. Where nothing in the
 * line predates the milestone — which is the case for ChatGPT, because this
 * dataset's GPT coverage starts at GPT-4 — the page says so rather than
 * reaching for the nearest record and implying a connection.
 */
function milestoneLine(m) {
  if (!m.related_family) return null;
  const line = releases
    .filter((r) => r.family === m.related_family)
    .sort((a, b) => isoDate(a).localeCompare(isoDate(b)));
  // A family named on a milestone but absent from the dataset gets no link at
  // all. A dead link is worse than an admitted gap.
  if (!line.length) return null;

  // Ties are the whole reason this returns arrays. Gemini 1.0 Ultra, Pro and
  // Nano all carry 2023-12-06, so "the" nearest release before a 2024 milestone
  // does not exist — taking the last of the three would be this build picking
  // one on no evidence and presenting it as the answer. Every record on the
  // winning date is named instead.
  const sameDate = (pool, iso) => pool.filter((r) => isoDate(r) === iso);
  const earlier = line.filter((r) => isoDate(r) <= m.date);
  return {
    family: m.related_family,
    line,
    before: earlier.length ? sameDate(earlier, isoDate(earlier.at(-1))) : [],
    first: sameDate(line, isoDate(line[0])),
  };
}

/** The "Model line" block on a milestone card. Renders the gap when there is one. */
function milestoneLineBlock(m) {
  const rel = milestoneLine(m);
  if (!rel) {
    return `<p class="ms-gap">No model line is recorded on this milestone, so nothing here `
      + `links it to a model record.</p>`;
  }
  const named = (rs) => rs.map((r) => `<a href="../models/${esc(r.id)}/">${esc(r.model)}</a>`)
    .join(', ').replace(/, ([^,]*)$/, ' and $1');
  const on = (rs) => `<time datetime="${esc(isoDate(rs[0]))}">${fullDate(rs[0])}</time>`;
  const nearest = rel.before.length
    ? `${named(rel.before)} — ${on(rel.before)}`
    : `None. This dataset's record of the ${esc(rel.family)} line starts later, `
      + `with ${named(rel.first)} on ${on(rel.first)}.`;
  return `<dl class="ms-line">
<dt>Model line</dt>
<dd><a href="../families/${familySlug(rel.family)}/">${esc(rel.family)}</a> · `
    + `${rel.line.length} tracked release${rel.line.length === 1 ? '' : 's'}</dd>
<dt>Most recent tracked release in that line before this date</dt>
<dd>${nearest}</dd>
</dl>`;
}

function milestonesIndexPage(list) {
  // Oldest first. Every other index here leads with the newest record, because
  // the question there is "what shipped lately". This page answers a different
  // one: these events refer to each other — Bard is a response to ChatGPT,
  // Gemini is Bard renamed, the AI Act regulates the market the first two made
  // — and read newest-first that chain runs backwards. The set is also small
  // enough to see whole, so the usual reason to front-load recency (scanning a
  // long list) does not apply.
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
  const releaseYears = new Set(releases.map((r) => r.year));

  const years = [...new Set(sorted.map((m) => m.date.slice(0, 4)))];

  /* Facets are read off the records, never declared. A `type` that appears in
     milestones.json gets a control; one that does not, does not — so the
     controls can never offer a filter the data cannot answer. */
  const facet = (key, label, of) => {
    const counts = new Map();
    for (const m of sorted) counts.set(of(m), (counts.get(of(m)) ?? 0) + 1);
    const opts = [...counts.keys()].sort();
    return { key, label, opts, counts };
  };
  const facets = [
    facet('kind', 'Kind', (m) => m.type),
    facet('lab', 'Recorded against', (m) => m.company),
  ].filter((f) => f.opts.length > 1); // a one-value facet filters nothing

  const chipFor = (f, value) => {
    const text = f.key === 'kind' ? (MILESTONE_LABEL[value] ?? value) : value;
    const hue = f.key === 'lab' ? ` style="--c:var(--c-${slugFor(value)})"` : '';
    return `<button type="button" class="chip" data-facet="${esc(f.key)}" data-value="${esc(value)}"${hue} aria-pressed="false">`
      + `${f.key === 'lab' ? '<span class="chip-dot"></span>' : ''}`
      + `${esc(text)} <span class="chip-count">${f.counts.get(value)}</span></button>`;
  };

  const card = (m) => `<li class="ms-item" id="ms-${esc(m.id)}"
 data-kind="${esc(m.type)}" data-lab="${esc(m.company)}" style="--c:var(--c-${slugFor(m.company)})">
<div class="ms-head">
${companyMark(m.company, 'sm')}
<div class="ms-headtext">
<h3 class="ms-title"><a href="${esc(m.id)}/">${esc(m.title)}</a></h3>
<p class="ms-meta"><time datetime="${esc(m.date)}">${esc(eventDate(m.date))}</time>
<span class="ms-kind">${esc(MILESTONE_LABEL[m.type] ?? m.type)}</span>
<span class="ms-lab">${esc(m.company)}</span></p>
</div>
</div>
<p class="ms-note">${esc(m.note)}</p>
${m.significance ? `<p class="ms-sig">${esc(m.significance)}</p>` : ''}
${milestoneLineBlock(m)}
<p class="ms-prov">Record status: <span class="prov-badge" data-status="${esc(m.provenance.status)}">${
  esc(PROV_LABEL[m.provenance.status] ?? m.provenance.status)}</span> · confidence ${m.provenance.confidence}/100</p>
<ul class="ms-sources">${m.sources.map((s) => `<li>
<a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(new URL(s.url).hostname.replace(/^www\./, ''))}</a>
<span>${esc(SOURCE_LABEL[s.type] ?? s.type)}</span>
<span class="src-authority" data-authority="${esc(s.authority)}">${esc(AUTHORITY_LABEL[s.authority] ?? s.authority)}</span>${
  s.archived_url ? `<a class="src-archive" href="${esc(s.archived_url)}" rel="noopener noreferrer nofollow">archived</a>` : ''}
</li>`).join('')}</ul>
</li>`;

  const yearSection = (y) => {
    const ms = sorted.filter((m) => m.date.slice(0, 4) === y);
    return `<section class="ms-year" data-year="${esc(y)}" aria-labelledby="ms-y${esc(y)}">
<h2 class="ms-year-head" id="ms-y${esc(y)}">${esc(y)}
<span class="ms-year-n" data-total="${ms.length}">${ms.length} milestone${ms.length === 1 ? '' : 's'}</span></h2>
${releaseYears.has(Number(y)) ? `<p class="ms-year-link"><a href="../timeline/${esc(y)}/">Model releases in ${esc(y)} →</a></p>` : ''}
<ol class="ms-list">${ms.map(card).join('')}</ol>
</section>`;
  };

  const body = `
${crumbs('../', ['Milestones'])}

<h1>Milestones</h1>
<p class="doc-sub">${sorted.length} dated event${sorted.length === 1 ? '' : 's'} that mattered but were not model releases,
${years.length === 1 ? `all in ${years[0]}` : `${years[0]}–${years[years.length - 1]}`}</p>

<p class="doc-note">Not everything that shaped this history was a set of weights.
A milestone records a dated event — a product launch, a statutory regime — that
belongs on the timeline but has no parameters, context window or licence.
Every milestone needs a primary source, exactly like a model record.</p>

<p class="doc-note">This is a deliberately short list, and it is short because the
bar is high: an event earns a record here only when it changed what the labs in
this dataset could ship or sell. ${sorted.length} record${sorted.length === 1 ? '' : 's'} is the honest
count, not a placeholder for a longer one.</p>

${facets.length ? `<div class="ms-controls" id="ms-controls" hidden>
${facets.map((f) => `<div class="filter-group">
<p class="filter-title" id="ms-f-${esc(f.key)}">${esc(f.label)}</p>
<div class="chips" role="group" aria-labelledby="ms-f-${esc(f.key)}">${f.opts.map((v) => chipFor(f, v)).join('')}</div>
</div>`).join('')}
<button type="button" class="reset-btn" id="ms-reset" hidden>Clear filters</button>
</div>
<p class="ms-status" id="ms-status" role="status" hidden></p>
<p class="ms-empty" id="ms-empty" hidden>No milestone matches those filters.</p>` : ''}

${years.map(yearSection).join('')}

<p class="doc-cta"><a href="../models/">Browse tracked model releases →</a></p>
`;

  /* Progressive enhancement, and the order matters: the controls ship `hidden`
     in the markup and are revealed here. A reader without JavaScript sees the
     full list, grouped by year, with every source and provenance badge intact,
     and never sees a filter button that cannot do anything.

     Filter state goes into the query string, like every other view on this
     site, so a filtered page is a linkable page. */
  const script = `<script defer>
addEventListener('DOMContentLoaded',function(){
  var box=document.getElementById('ms-controls');
  if(!box)return;
  var FACETS=['kind','lab'];
  var items=[].slice.call(document.querySelectorAll('.ms-item'));
  var sections=[].slice.call(document.querySelectorAll('.ms-year'));
  var chips=[].slice.call(box.querySelectorAll('[data-facet]'));
  var reset=document.getElementById('ms-reset');
  var live=document.getElementById('ms-status');
  var empty=document.getElementById('ms-empty');
  var picked={};

  var q=new URLSearchParams(location.search);
  FACETS.forEach(function(f){
    var raw=q.get(f);
    picked[f]=raw?raw.split(',').filter(Boolean):[];
  });

  box.hidden=false;
  if(live)live.hidden=false;

  function apply(store){
    var shown=0;
    items.forEach(function(el){
      var ok=FACETS.every(function(f){
        return !picked[f].length||picked[f].indexOf(el.dataset[f])>-1;
      });
      el.hidden=!ok;
      if(ok)shown++;
    });
    sections.forEach(function(s){
      /* Deliberately NOT named "live" — that is the status element in the outer
         scope, and shadowing a page global inside a nested callback is the bug
         class this project already shipped once (CLAUDE.md, compare page). */
      var here=s.querySelectorAll('.ms-item:not([hidden])').length;
      s.hidden=here===0;
      /* The year heading counts what is on screen. Left static it reads
         "2 milestones" above a single card and contradicts the page. */
      var n=s.querySelector('.ms-year-n');
      if(n){
        var total=Number(n.dataset.total);
        n.textContent=here===total
          ?total+' milestone'+(total===1?'':'s')
          :here+' of '+total+' milestones';
      }
    });
    chips.forEach(function(c){
      c.setAttribute('aria-pressed',
        picked[c.dataset.facet].indexOf(c.dataset.value)>-1?'true':'false');
    });
    var any=FACETS.some(function(f){return picked[f].length>0;});
    if(reset)reset.hidden=!any;
    if(empty)empty.hidden=shown!==0;
    if(live){
      live.textContent=shown===items.length
        ?'Showing all '+items.length+' milestones.'
        :'Showing '+shown+' of '+items.length+' milestones.';
    }
    if(store){
      var next=new URLSearchParams(location.search);
      FACETS.forEach(function(f){
        if(picked[f].length)next.set(f,picked[f].join(','));else next.delete(f);
      });
      var qs=next.toString();
      history.replaceState(null,'',location.pathname+(qs?'?'+qs:'')+location.hash);
    }
  }

  chips.forEach(function(c){
    c.addEventListener('click',function(){
      var arr=picked[c.dataset.facet];
      var at=arr.indexOf(c.dataset.value);
      if(at>-1)arr.splice(at,1);else arr.push(c.dataset.value);
      apply(true);
    });
  });
  if(reset)reset.addEventListener('click',function(){
    FACETS.forEach(function(f){picked[f]=[];});
    apply(true);
  });

  apply(false);
});
</script>`;

  return page({
    title: 'Milestones — dated events that were not model releases | LLM World',
    description: 'Dated events that shaped large language model history without being model releases, grouped by year, each with a primary source.',
    canonical: `${BASE_URL}/milestones/`,
    section: 'milestones/',
    depth: 1,
    sprites: [...new Set(list.map((m) => slugFor(m.company)))],
    head: facets.length ? script : '',
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
${crumbs('../../', ['Families', '../'], [esc(name)])}

<div class="doc-hero">
  ${companyMark(first.company)}
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

${gens.length > 1 ? `<h2>Release cadence</h2>
<p class="chart-note">One tile per tracked release, placed in the month it shipped,
so the pauses in this line are the pauses in the data. Years with nothing tracked
keep their row.</p>
${cadenceRibbon(gens, { up: '../../', label: name })}` : ''}

<h2>Lineage</h2>
<p class="chart-note">Ordered by announcement date, and spaced by the gap between
releases, so a quiet year looks like one. Lineage is not inferred from version
numbers — labs do not number consistently, so the dates decide the order.</p>
${lineageGraph(gens)}

${ctxPoints.length > 1 ? `<h2>Context window over time</h2>
<p class="chart-note">Only releases with a disclosed context window appear${
  ctxPoints.length < gens.length ? ` — ${gens.length - ctxPoints.length} of ${gens.length} are not shown` : ''}.</p>
${ctxOverTime(ctxPoints)}` : ''}

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

/**
 * The family lineage as a dated rail rather than a flat list.
 *
 * Three things the list could not show, all of which are already in the data:
 *
 *   - WHEN. Spacing is proportional to the gap between releases, so an
 *     eighteen-month pause reads as a pause instead of one more <li>. The
 *     scale is damped (square root) and clamped, because a linear scale gives
 *     a family with one long gap a screen of empty rail.
 *   - WHAT CHANGED. Each edge carries the step from the previous generation,
 *     via the same diffRecords() the What Changed section uses, so the two can
 *     never disagree.
 *   - SIBLINGS. Models shipped on one day are one tier, not a sequence. Nova
 *     shipped four at once; rendering them as four generations invented three
 *     upgrade steps that never happened.
 *
 * It stays an <ol> of models: the rail is drawn with CSS on top of a list that
 * still reads correctly with no stylesheet and in a screen reader.
 */
function lineageGraph(gens) {
  // Tiers: consecutive releases sharing a canonical date are siblings.
  const tiers = [];
  for (const r of gens) {
    const key = isoDate(r);
    const last = tiers[tiers.length - 1];
    if (last && last.key === key) last.models.push(r);
    else tiers.push({ key, models: [r] });
  }

  // The first release to evidence each capability — a fact about the family,
  // computed once so a capability cannot be marked "first" twice.
  const firstSeen = new Map();
  for (const t of tiers) {
    for (const r of t.models) {
      for (const c of r.capabilities ?? []) if (!firstSeen.has(c)) firstSeen.set(c, r.id);
    }
  }

  const dayMs = 86400000;
  const items = tiers.map((tier, i) => {
    const prev = tiers[i - 1];
    const days = prev
      ? Math.round((Date.parse(tier.key) - Date.parse(prev.key)) / dayMs)
      : 0;
    // Damped so one long gap cannot dominate the page, floored so consecutive
    // releases still separate.
    const lead = prev ? Math.min(120, Math.max(20, Math.round(Math.sqrt(Math.max(days, 0)) * 5))) : 0;

    const edge = prev ? diffRecords(prev.models[prev.models.length - 1], tier.models[0]) : null;
    const chips = (edge?.changes ?? []).map((c) => c.gained
      ? `<span class="lin-chip lin-new">first evidenced: ${c.gained.map(tagLabel).map(esc).join(', ')}</span>`
      : `<span class="lin-chip lin-${esc(c.direction)}">${esc(c.label)} ${esc(c.from)} → ${esc(c.to)}</span>`).join('');

    const cards = tier.models.map((r) => {
      const firsts = (r.capabilities ?? []).filter((c) => firstSeen.get(c) === r.id);
      return `<div class="lin-card">
<a class="lin-name" href="../../models/${esc(r.id)}/">${esc(r.model)}</a>${modalityMarks(r)}
${firsts.length ? `<p class="lin-firsts">${firsts.map((c) => `<span class="lin-chip lin-new">${esc(tagLabel(c))}</span>`).join('')}</p>` : ''}
</div>`;
    }).join('');

    return `<li class="lin-tier"${tier.models.length > 1 ? ' data-siblings="true"' : ''} style="--lead:${lead}px">
<div class="lin-rail" aria-hidden="true"><span class="lin-node"></span></div>
<div class="lin-body">
<p class="lin-date"><time datetime="${esc(tier.key)}">${fullDate(tier.models[0])}</time>${
  prev ? ` <span class="lin-gap">+${days.toLocaleString('en-US')} days</span>` : ''}</p>
${tier.models.length > 1
  ? `<p class="lin-sibs">${tier.models.length} released the same day</p><div class="lin-cards">${cards}</div>`
  : cards}
${chips ? `<p class="lin-changes">${chips}</p>` : ''}
</div></li>`;
  }).join('');

  // A family page is about ONE lab, so a single hue on the rail carries
  // identity with no rainbow risk — the objection to colouring list rows
  // elsewhere is that sixteen companies exceed the categorical ceiling, and
  // that cannot happen where every row is the same company.
  return `<ol class="lineage-graph" style="--c:var(--c-${slugFor(gens[0].company)})">${items}</ol>`;
}

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
${crumbs('../', ['Families'])}

<h1>Model families</h1>
<p class="doc-sub">${rows.length} tracked lines · ${multi} with more than one generation</p>

<p class="doc-note">A family is a lineage the lab itself presents as continuous.
It is never inferred from names alone — <a href="../models/gpt-oss/">GPT-OSS</a> is not
the GPT family merely for sharing a prefix.</p>

<ol class="doc-list">${rows.map((r) => `<li>
${companyMark(r.first.company, 'sm')}
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
/**
 * /api/ — the machine-readable surface, for the people who wire it up.
 *
 * The endpoints existed and were documented only in the README, which is the
 * one place a person arriving from a search engine will not look. llms.txt
 * tells an agent what is here; this tells whoever is deciding whether to
 * depend on it — what the licence requires, which fields are thin, and how to
 * run the MCP server without the PATH trap that makes it fail silently.
 *
 * Every figure is computed at build time. A hand-written coverage table is
 * wrong within a week, and being wrong about your own coverage is a worse
 * failure here than anywhere else on the site.
 */
function apiPage() {
  const n = releases.length;
  const pct = (v) => `${Math.round((v / n) * 100)}%`;
  const cov = (f) => releases.filter(f).length;
  const fields = [
    ['modalities', cov((r) => r.modalities), 'What the model takes in and puts out'],
    ['capabilities', cov((r) => r.capabilities?.length), 'Only where a primary source states them'],
    ['context_window', cov((r) => r.specifications?.language?.context_window != null), 'Language models only'],
    ['parameter_count', cov((r) => r.specifications?.language?.parameter_count != null), 'Most proprietary labs publish none'],
    ['pricing', cov((r) => r.pricing), 'Needs an archived page to evidence it'],
    ['benchmarks', cov((r) => r.benchmarks?.length), 'Most labs publish these as images'],
  ];
  const verified = releases.filter((r) => r.provenance?.status === 'verified').length;
  /**
   * Which fields are actually thin, rather than which ones were thin the day
   * this page was written.
   *
   * The table below has always been computed; the sentence under it named
   * pricing and benchmarks in prose. Those two are at 12% and 7% today, and the
   * moment either is backfilled the page would carry a correct table above a
   * false sentence — the exact drift this project regenerates the README to
   * avoid. A third under a quarter would have gone unmentioned for the same
   * reason.
   */
  const thin = fields.filter(([, v]) => v / n < 0.25).map(([f]) => f);
  const listOf = (xs) => xs.length < 2 ? (xs[0] ?? '')
    : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  const claimCount = releases.reduce((t, r) =>
    t + Object.values(r.evidence ?? {}).reduce((a, l) => a + l.length, 0), 0);

  return page({
    title: 'API, data and MCP | LLM World',
    description: `Every record as JSON and CSV under CC BY 4.0, ${claimCount} evidenced claims `
      + 'with the URL that states each one, and a dependency-free MCP server.',
    canonical: `${BASE_URL}/api/`,
    section: 'api/',
    depth: 1,
    sprites: [],
    body: `
${crumbs('../', ['API and MCP'])}
${hero({
    title: 'Use the data',
    sub: `${n} releases, ${claimCount} evidenced claims, every one carrying the URL of the page that states it. CC BY 4.0.`,
  })}
<div class="prose">

<h2>Endpoints</h2>
<table class="facts">
<tr><th scope="row"><a href="index.json">/api/index.json</a></th><td>Discovery: licence, counts, endpoint list. Stable — point a badge at it.</td></tr>
<tr><th scope="row"><a href="models.json">/api/models.json</a></th><td>Every release as authored, with sources and provenance.</td></tr>
<tr><th scope="row"><a href="claims.json">/api/claims.json</a></th><td>${claimCount} claims, denormalised: value, the lab page asserting it, the archived snapshot.</td></tr>
<tr><th scope="row"><a href="companies.json">/api/companies.json</a></th><td>Per-lab counts, open-weights share, first and latest release.</td></tr>
<tr><th scope="row"><a href="../llm-releases.csv">/llm-releases.csv</a></th><td>Flat table for spreadsheets.</td></tr>
<tr><th scope="row"><a href="../llms.txt">/llms.txt</a></th><td>What an agent should read first.</td></tr>
</table>

<p>Every payload carries its own <code>license</code>, <code>attribution</code> and
<code>schema_version</code>, so the terms travel with the data. A breaking shape change
bumps <code>schema_version</code> — pin against it.</p>

<h2>Licence</h2>
<p>The <strong>data is CC BY 4.0</strong>: use it, change it, sell it, as long as you credit
LLM World and link back. The <strong>code is MIT</strong>. See
<a href="https://github.com/mayoorrnikam/llm-world/blob/main/LICENSE-DATA">LICENSE-DATA</a>
and <a href="https://github.com/mayoorrnikam/llm-world/blob/main/NOTICE">NOTICE</a> for
exactly what each covers.</p>
<pre><code>Release dates and metadata from LLM World
https://mayoorrnikam.github.io/llm-world/ — CC BY 4.0</code></pre>

<h2>What a missing field means</h2>
<p><strong>Nobody has traced it yet.</strong> Not zero, and not that the model lacks the
property. Capabilities are recorded only where a primary source states them, so absence
is silence rather than denial — a model with no <code>coding</code> capability may well
code, and this dataset simply has not evidenced it. Building a "does not support"
claim on a blank field is the one misuse that will make you wrong.</p>

<table class="facts">
<tr><th scope="row">Records</th><td>${n}, of which ${verified} (${pct(verified)}) are verified — every value traced to a primary source</td></tr>
${fields.map(([f, v, note]) =>
    `<tr><th scope="row"><code>${f}</code></th><td>${v} of ${n} (${pct(v)}) — ${note}</td></tr>`).join('\n')}
</table>

<p>${thin.length
    ? `${listOf(thin.map((f) => `<code>${f}</code>`))} ${thin.length === 1 ? 'is' : 'are'} thin`
    : 'Where a field is thin it is'} on purpose rather than by neglect, and the reasons are
in <a href="../data-quality/">data quality</a>.${thin.length ? ` What follows from it: <strong>this dataset
cannot ${thin.includes('benchmarks') ? 'rank models by performance' : 'compare models'}${thin.includes('pricing') ? ' or cost' : ''}</strong>
across the whole set.` : ''} It can tell you what a lab stated and where.</p>

<h2>MCP server</h2>
<p>A dependency-free server over the same data, for Claude Desktop, Claude Code or any
MCP client. It lives in the repository at <code>mcp/server.mjs</code>.</p>

<pre><code>git clone https://github.com/mayoorrnikam/llm-world.git
npm run mcp</code></pre>

<p>Then add it to your client's config — for Claude Desktop that is
<code>~/Library/Application&nbsp;Support/Claude/claude_desktop_config.json</code>:</p>

<pre><code>{ "mcpServers": { "llm-world": {
    "command": "/opt/homebrew/bin/node",
    "args": ["/absolute/path/to/llm-world/mcp/server.mjs"] } } }</code></pre>

<p><strong>Use an absolute path to <code>node</code>, not <code>"node"</code>.</strong> A GUI
application on macOS inherits <code>/usr/bin:/bin:/usr/sbin:/sbin</code> and never the PATH
from your shell profile, so a Node installed by nvm or a version manager is invisible to it
and the server fails to spawn with nothing useful in the log. <code>which node</code> in a
terminal answers about a different PATH than the one your client has.</p>

<table class="facts">
<tr><th scope="row"><code>search_models</code></th><td>A plain-language query. Returns <code>matches</code> and <code>not_ruled_out</code>.</td></tr>
<tr><th scope="row"><code>get_model</code></th><td>One record in full, every claim with its primary and archived URL.</td></tr>
<tr><th scope="row"><code>dataset_stats</code></th><td>Coverage per field, so a caller knows what the data supports.</td></tr>
</table>

<p><code>not_ruled_out</code> is the part worth having. Asked for a coding model with a 1M
context window it returns the models that match — and separately lists Claude Sonnet 5
and Claude Fable 5, which have the context window and whose coding ability nobody has
evidenced. Reporting those as "no" would be false; dropping them silently is how a
research gap turns into a wrong answer.</p>

<p>Nothing in it ranks models. Benchmarks cover ${pct(cov((r) => r.benchmarks?.length))} of
records, and a leaderboard on that basis would be the one part of this project that is not
evidence.</p>

</div>
<p class="doc-cta">
  <a href="../methodology/">How a record is verified →</a><br>
  <a href="../data-quality/">Where the gaps are, and why →</a>
</p>`,
  });
}

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

  const qf = filterBar({
    prefix: 'qf',
    noun: 'records',
    placeholder: 'Search model, lab or reason',
    rowSelector: '.quality-list li[data-find]',
    facets: [
      { key: 'lab', label: 'Lab', options: [...new Set(unproven.map((r) => r.company))].sort() },
      { key: 'status', label: 'Status', options: [...new Set(unproven.map((r) => r.provenance.status))].sort() },
    ],
  });

  const body = `
${crumbs('../', ['Data quality'])}

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
${/**
   * The two thin fields belong in this table, not only in the prose below it.
   * A coverage table that lists the fields we do well and omits the ones we do
   * not is a marketing table. Pricing and benchmarks are the fields a reader is
   * most likely to want and least likely to find, so they are stated here at
   * full width with the reason attached.
   */''}
<tr><th scope="row">Pricing <span class="cell-note">historical observations</span></th>
<td>${withPricing}/${total}</td><td>0</td><td class="cell-gap">${total - withPricing}</td></tr>
<tr><th scope="row">Benchmarks <span class="cell-note">as published</span></th>
<td>${withBenchmarks}/${total}</td><td>0</td><td class="cell-gap">${total - withBenchmarks}</td></tr>
</tbody></table>
<p class="doc-note">Pricing and benchmarks are thin, and deliberately so. A price is
true for a quarter and a leaderboard changes weekly, while every figure here must be
traced to a dated primary source before it can be published — the wrong shape for live
data. <a href="../api/">OpenRouter and Artificial Analysis maintain those properly</a>,
and each model page links out to them.</p>
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

${qf.markup}

<ol class="doc-list quality-list">${unproven.map((r) => `<li data-lab="${esc(r.company)}" data-status="${
  esc(r.provenance.status)}" data-find="${esc(`${r.model} ${r.company} ${r.provenance.reason ?? ''}`.toLowerCase())}">
${companyMark(r.company, 'sm')}
<a class="cell-name" href="../models/${esc(r.id)}/">${esc(r.model)}</a>
<span class="cell-meta">${esc(r.provenance.reason ?? '')}</span>
</li>`).join('')}</ol>

<p class="doc-cta"><a href="../analytics/">See release analytics →</a></p>
`;

  /**
   * The same progressive-enhancement filter as /models/, scoped to one list.
   *
   * This page is 135 rows and 131 of them are in this single section — it is
   * not a long page, it is a short page with one runaway list, so it wants a
   * filter rather than splitting. The list still ships whole in the HTML; this
   * only hides rows once it loads.
   */


  return page({
    head: qf.script,
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


/**
 * Capability evolution, from researched records only.
 *
 * The researched set is `r.modalities != null` — the same proxy diffRecords()
 * uses, and for the same reason: capabilities and modalities are established in
 * one research pass, so a record with modalities has had its capabilities read
 * off a primary source. Without that test an empty capabilities[] means "nobody
 * looked", and counting it as "does not have this capability" turns a research
 * gap into a measurement.
 *
 * "First evidenced" is a claim about this dataset, never about history — it is
 * the earliest release we can SHOW carrying the capability, which is why the
 * heading and note say so. The distinction is not pedantic: before the
 * capability audit, `reasoning` first appeared on PaLM in 2022, and a chart
 * would have published that as the year reasoning models arrived.
 */
function capabilityEvolution() {
  const known = releases.filter((r) => r.modalities).sort((a, b) => stamp(a) - stamp(b));

  const first = new Map();
  for (const r of known) {
    for (const c of r.capabilities ?? []) if (!first.has(c)) first.set(c, r);
  }

  // Adoption per year, per capability, over the researched records of that year.
  const years = [...new Set(known.map((r) => r.year))].sort((a, b) => a - b);
  const perYear = new Map(years.map((y) => [y, known.filter((r) => r.year === y)]));

  // Only capabilities with enough presence to have a shape worth drawing.
  const totals = new Map();
  for (const r of known) for (const c of r.capabilities ?? []) totals.set(c, (totals.get(c) ?? 0) + 1);
  const tracked = [...totals.entries()].filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1]).map(([c]) => c);

  const matrix = tracked.map((cap) => ({
    cap,
    total: totals.get(cap),
    cells: years.map((y) => {
      const list = perYear.get(y);
      const n = list.filter((r) => (r.capabilities ?? []).includes(cap)).length;
      return { year: y, n, of: list.length, pct: Math.round(n / list.length * 100) };
    }),
  }));

  return {
    researched: known.length,
    years,
    firsts: [...first.entries()]
      .sort((a, b) => stamp(a[1]) - stamp(b[1]))
      .map(([cap, r]) => ({ cap, r })),
    matrix,
  };
}

/**
 * Capability adoption as a year × capability grid.
 *
 * One hue at varying strength, because every cell is the same measurement at a
 * different magnitude — a categorical palette here would imply the capabilities
 * are the variable being compared. Each cell is direct-labelled with its count,
 * so the colour is a second channel and never the only one.
 */
function capabilityMatrix(evo) {
  const head = evo.years.map((y) => `<th scope="col"><a href="../timeline/${y}/">${y}</a></th>`).join('');
  const rows = evo.matrix.map((row) => `<tr>
<th scope="row">${esc(tagLabel(row.cap))}</th>
${row.cells.map((c) => `<td class="cap-cell"${c.n ? ` style="--fill:${(0.1 + c.pct / 100 * 0.9).toFixed(2)}"` : ''}>
<span class="cap-n">${c.n}</span><span class="cap-of">/${c.of}</span></td>`).join('')}
</tr>`).join('');
  return `<div class="table-scroll"><table class="cap-matrix">
<thead><tr><th scope="col">Capability</th>${head}</tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

/**
 * A small Markdown renderer for the two public reference documents.
 *
 * METHODOLOGY.md and TAXONOMY.md are the documents that justify the dataset to
 * someone who does not trust it, and they were invisible to the site — sitting
 * in a gitignored folder, which is the wrong place for the answer to "why
 * should I believe this figure?". Publishing them is charter §48 and Phase 3
 * finally reaching the reader.
 *
 * Deliberately not a Markdown implementation. It handles exactly what those two
 * files use — headings, paragraphs, lists, tables, fenced code, blockquotes,
 * rules, and inline code/bold/italic/links — and a dependency would buy the
 * other 90% of CommonMark that neither document contains. If a doc grows a
 * construct this cannot render, it renders as literal text, which is visible
 * and fixable rather than silent.
 */
function renderMarkdown(src) {
  const out = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');

  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    // Relative links too, so a generated table can point at the record behind
    // each value. Restricted to ./ ../ and / on purpose: anything else — most
    // of all `javascript:` — must stay literal text rather than become a link.
    .replace(/\[([^\]]+)\]\((\.{0,2}\/[^)\s]*)\)/g, '<a href="$2">$1</a>')
    // Relative links point at the sibling documents in docs/, and most of those
    // are deliberately unpublished — the charter and the execution order stay
    // local. Linking them would 404; leaving the raw [text](file.md) on the page
    // looks broken. So the link text survives and the link does not.
    .replace(/\[([^\]]+)\]\((?!https?:)[^)\s]*\)/g, '$1');

  const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const body = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre class="doc-pre"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      // The page already has an <h1>, so document headings step down one level
      // and the page keeps exactly one top-level heading.
      const level = Math.min(6, h[1].length + 1);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); continue; }

    // Tables: a header row, a separator, then body rows.
    if (/^\|/.test(line) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|/.test(lines[i])) body.push(cells(lines[i++]));
      i--;
      out.push(`<div class="table-scroll"><table class="doc-table">
<thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead>
<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>
</table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      i--;
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }

    const listType = /^\s*[-*]\s+/.test(line) ? 'ul' : /^\s*\d+\.\s+/.test(line) ? 'ol' : null;
    if (listType) {
      const items = [];
      const match = listType === 'ul' ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      while (i < lines.length && match.test(lines[i])) items.push(lines[i++].replace(match, ''));
      i--;
      out.push(`<${listType}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${listType}>`);
      continue;
    }

    if (!line.trim()) continue;

    // Otherwise a paragraph: gather until a blank line or a block starts.
    const para = [line];
    while (i + 1 < lines.length && lines[i + 1].trim()
      && !/^(#{1,6}\s|```|\||>|\s*[-*]\s|\s*\d+\.\s|-{3,})/.test(lines[i + 1])) para.push(lines[++i]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Publishes a local reference document as a page. */
function docPage({ file, slug, title, description, lead }) {
  const src = readFileSync(file, 'utf8');
  // The file's own H1 becomes the page H1; the rest is rendered beneath.
  const firstHeading = /^#\s+(.*)$/m.exec(src);
  const body = renderMarkdown(src.replace(/^#\s+.*$/m, '').trim());

  return page({
    title: `${title} | LLM World`,
    description,
    canonical: `${BASE_URL}/${slug}/`,
    section: `${slug}/`,
    depth: 1,
    sprites: [],
    body: `
${crumbs('../', [esc(title)])}
${hero({ title: esc(firstHeading?.[1] ?? title), sub: esc(lead) })}
<div class="prose">${body}</div>
<p class="doc-cta">
  <a href="../data-quality/">See how every record scores against this →</a><br>
  <a href="../models/">Browse the records themselves →</a>
</p>`,
  });
}

/**
 * The context-window study: /analytics/context-windows/.
 *
 * Every figure and every sentence with a number in it is computed from
 * specifications.context_window at build time. That is the point — a
 * hand-written narrative about a moving dataset is wrong within a month, and
 * this one restates itself on every build.
 *
 * The chart is a STEP, not a line or a bar. A context window is a level that
 * holds from the day it ships until something larger ships: GPT-4's 8K did not
 * slide toward 128K over 426 days, it held at 8K and then jumped. A sloped line
 * would draw a rate of change that never existed, and bars would imply each
 * release is an independent measurement rather than a level that persisted.
 * Log scale, because 2K to 1.05M on a linear axis flattens everything before
 * 2024 into the baseline.
 */
function contextStudyPage() {
  const disclosed = releases
    .filter((r) => r.technical.context_window)
    .sort((a, b) => stamp(a) - stamp(b));

  // The frontier and the chart come from lib/chart.mjs, shared with the
  // homepage so the two cannot draw different histories of the same data.
  const ctxOf = (r) => r.technical.context_window;
  const frontier = contextFrontier(disclosed, ctxOf, stamp);

  const fmt = tokenLabel;
  const first = frontier[0], last = frontier[frontier.length - 1];
  const span = Math.round((stamp(last) - stamp(first)) / 86400000);
  const multiple = Math.round(ctxOf(last) / ctxOf(first));

  // Biggest single jump on the frontier, by multiple rather than absolute — a
  // 4x is the same engineering story at 8K as at 800K.
  let biggest = null;
  for (let i = 1; i < frontier.length; i++) {
    const factor = ctxOf(frontier[i]) / ctxOf(frontier[i - 1]);
    if (!biggest || factor > biggest.factor) biggest = { factor, from: frontier[i - 1], to: frontier[i] };
  }

  const chart = `<figure class="cs-figure">
${stepChartSvg(frontier, { contextOf: ctxOf, stampOf: stamp, dateOf: fullDate, escape: esc })}
<figcaption>Frontier context window, log scale. The line holds at each level until a
larger one ships — that is what the data says happened, and a sloped line would
invent a rate of change between two dated announcements.</figcaption>
</figure>`;

  const body = `
${crumbs('../../', ['Analytics', '../'], ['Context windows'])}
${hero({
  title: `How the context window grew ${multiple.toLocaleString('en-US')}×`,
  sub: `From ${fmt(first.technical.context_window)} to ${fmt(last.technical.context_window)} in ${
    span.toLocaleString('en-US')} days, measured across ${disclosed.length} releases that disclose one.`,
})}

<div class="prose">
<p>${frontier.length} of the ${disclosed.length} releases with a disclosed context window
set a new maximum. The rest shipped under a ceiling someone had already reached —
which is the useful shape here: the frontier moves in a few large steps, not
continuously.</p>

${chart}

<h2>Every step of the frontier</h2>
<p class="chart-note">A release appears here only if it disclosed a larger context
window than anything before it. ${releases.length - disclosed.length} of ${releases.length}
records disclose no context window at all and cannot appear — see
<a href="../../data-quality/">data quality</a>.</p>
${barRows(frontier.map((r, i) => ({
    name: `${r.model} · ${r.year}`,
    value: Math.log10(r.technical.context_window),
    display: i === 0 ? fmt(r.technical.context_window)
      : `${fmt(r.technical.context_window)} · ${Math.round(r.technical.context_window / frontier[i - 1].technical.context_window)}×`,
    href: `../../models/${esc(r.id)}/`,
  })))}

<h2>The largest single jump</h2>
<p>${esc(biggest.to.model)} multiplied the frontier by ${Math.round(biggest.factor)}×,
from ${fmt(biggest.from.technical.context_window)} to ${fmt(biggest.to.technical.context_window)},
${Math.round((stamp(biggest.to) - stamp(biggest.from)) / 86400000).toLocaleString('en-US')} days after
${esc(biggest.from.model)} set the previous mark. Both figures are traced to the
labs' own announcements — follow them from
<a href="../../models/${esc(biggest.to.id)}/">${esc(biggest.to.model)}</a>.</p>

<h2>What this cannot tell you</h2>
<p>A context window is what the lab says the model accepts. It is not a claim about
what the model uses well: retrieval quality across a full window is a benchmark
question, and this dataset records no benchmark it has not traced to a primary
source. Nor is the absence of a figure evidence of a small window —
${releases.length - disclosed.length} records disclose nothing here, and most of
those are proprietary models whose labs publish no specification at all.</p>
</div>

<p class="doc-cta">
  <a href="../">Back to analytics →</a><br>
  <a href="../../compare/">Compare two models side by side →</a>
</p>`;

  return page({
    title: 'How the context window grew — a technical study | LLM World',
    description: `From ${fmt(first.technical.context_window)} to ${fmt(last.technical.context_window)} in `
      + `${span.toLocaleString('en-US')} days: every step of the context-window frontier, traced to primary sources.`,
    canonical: `${BASE_URL}/analytics/context-windows/`,
    section: 'analytics/',
    depth: 2,
    sprites: [],
    body,
  });
}

/**
 * /changes/ — a changelog of the DATASET, not a feed of AI news.
 *
 * The distinction decides what this page is. "What's new in AI" is the thing
 * charter section 1 forbids the project becoming; "what did this dataset
 * assert, and when did it change its mind" is the opposite — it is the
 * corrections log rule R5 asks for, and no release tracker publishes one.
 *
 * The source is the repo's own history, because the dataset is version
 * controlled and that history is already the record of what changed. Nothing is
 * stored to make this page work: every commit touching data/llm-releases.json
 * is compared against its parent, so the changelog cannot drift from the data
 * the way a hand-maintained one would.
 *
 * CORRECTIONS are the part that matters. A value going from null to a figure is
 * research; a value going from one figure to a DIFFERENT figure means this site
 * published something wrong, which is exactly what a reader weighing our
 * trustworthiness wants to see admitted in public.
 */
function changesPage() {
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // Failures here are expected and handled by the callers — asking for the
        // root commit's parent is the normal case. Letting git print "fatal:
        // invalid object name" to the build log makes a healthy build look
        // broken, which is worse than useless: it trains you to ignore the one
        // line that might one day matter.
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return null; }
  };

  /** The parent commit, or null when there is none (the root). */
  const parentOf = (sha) => git(['rev-parse', '--verify', '--quiet', `${sha}^`])?.trim() || null;

  /** Whether a commit contains the dataset at all. */
  const hasData = (sha) => git(['cat-file', '-e', `${sha}:data/llm-releases.json`]) !== null;

  const SEP = '\u001f';
  const log = git(['log', '--format=%H%x1f%aI%x1f%s', '-n', '60', '--', 'data/llm-releases.json']);
  const commits = (log ?? '').trim().split('\n').filter(Boolean).map((l) => {
    const [sha, date, subject] = l.split(SEP);
    return { sha, date, subject };
  });

  const at = (sha) => {
    const raw = git(['show', sha + ':data/llm-releases.json']);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };

  const index = (doc) => new Map((doc?.releases ?? []).map((r) => [r.id, r]));
  const spec = (r, f) => f === 'license' ? r.access?.license : r.specifications?.language?.[f];
  const FIELDS = [['context_window', 'context window'], ['parameter_count', 'parameters'], ['license', 'licence']];

  const entries = [];
  for (const c of commits) {
    const now = index(at(c.sha));
    if (!now.size) continue;

    /**
     * "No parent to compare against" and "could not read the parent" are very
     * different, and treating them alike is how a changelog fabricates.
     *
     * The previous version read `sha^` and fell back to an empty map on any
     * failure, so an unreadable or unparseable parent would have published the
     * entire dataset as newly added on that date. It never fired, because the
     * only failing case was the root commit — where an empty map happens to be
     * the right answer. That is luck, not correctness, and the /changes/ page
     * is precisely where this project promises not to overclaim.
     */
    const parent = parentOf(c.sha);
    let before;
    if (!parent || !hasData(parent)) {
      // Nothing preceded this: the root commit, or the commit that first added
      // the dataset. Every record in it really is new.
      before = new Map();
    } else {
      const doc = at(parent);
      // Readable history, unreadable content — say nothing rather than guess.
      if (doc === null) continue;
      before = index(doc);
    }

    const added = [...now.keys()].filter((id) => !before.has(id));
    const removed = [...before.keys()].filter((id) => !now.has(id));

    const verified = [], corrections = [], researched = [];
    for (const [id, r] of now) {
      const p = before.get(id);
      if (!p) continue;

      if (p.provenance?.status !== 'verified' && r.provenance?.status === 'verified') verified.push(id);

      for (const [f, label] of FIELDS) {
        const a = spec(p, f), b = spec(r, f);
        if (a == null && b != null) researched.push({ id, label });
        // A value replaced by a DIFFERENT value: this site had it wrong.
        else if (a != null && b != null && a !== b) corrections.push({ id, label, from: a, to: b });
      }

      if (p.modalities == null && r.modalities != null) researched.push({ id, label: 'modalities' });
      const capsBefore = new Set(p.capabilities ?? []);
      const gained = (r.capabilities ?? []).filter((x) => !capsBefore.has(x));
      const lost = [...capsBefore].filter((x) => !(r.capabilities ?? []).includes(x));
      if (gained.length) researched.push({ id, label: 'capabilities (' + gained.map(tagLabel).join(', ') + ')' });
      // A capability taken back OFF a record is a correction, not research.
      if (lost.length) {
        corrections.push({ id, label: 'capability withdrawn', from: lost.map(tagLabel).join(', '), to: 'not evidenced' });
      }
    }

    if (!added.length && !removed.length && !verified.length && !corrections.length && !researched.length) continue;
    entries.push({ ...c, added, removed, verified, corrections, researched });
  }

  const link = (id) => `<a href="../models/${esc(id)}/">${esc(id)}</a>`;
  const group = (items) => {
    const by = new Map();
    for (const x of items) (by.get(x.id) ?? by.set(x.id, []).get(x.id)).push(x.label);
    return [...by.entries()];
  };

  const body = `
${crumbs('../', ['Changes'])}
${hero({
  title: 'What changed in the dataset',
  sub: `Every edit to the data, taken from the repository's own history —
what was added, what became verified, and what this site had wrong and fixed.`,
})}
<div class="prose">

<p class="doc-note">This is a log of the <strong>dataset</strong>, not of the industry.
It answers &ldquo;has this record changed since I cited it?&rdquo; and &ldquo;does this
project admit its mistakes?&rdquo; — not &ldquo;what shipped this week&rdquo;. For
releases, see <a href="../latest/">Latest</a>.</p>

${!entries.length ? `<p class="doc-note">No history is available in this build. The
changelog is generated from the repository's commits, and a shallow clone has none to
read.</p>` : `<ol class="chg-list">${entries.map((e) => `<li class="chg">
<p class="chg-when"><time datetime="${esc(e.date)}">${esc(e.date.slice(0, 10))}</time>
<a class="chg-sha" href="${REPO_URL}/commit/${esc(e.sha)}" rel="noopener">${esc(e.sha.slice(0, 7))}</a></p>
<p class="chg-subject">${esc(e.subject)}</p>
<ul class="chg-facts">
${e.corrections.length ? `<li class="chg-fix"><strong>Corrected</strong> ${
  e.corrections.slice(0, 8).map((x) => `${link(x.id)} ${esc(x.label)} ${esc(String(x.from))} &rarr; ${esc(String(x.to))}`).join('; ')}${
  e.corrections.length > 8 ? ` and ${e.corrections.length - 8} more` : ''}</li>` : ''}
${e.added.length ? `<li><strong>Added</strong> ${e.added.slice(0, 10).map(link).join(', ')}${
  e.added.length > 10 ? ` and ${e.added.length - 10} more` : ''}</li>` : ''}
${e.removed.length ? `<li><strong>Removed</strong> ${e.removed.map((x) => esc(x)).join(', ')}</li>` : ''}
${e.verified.length ? `<li><strong>Verified</strong> ${e.verified.slice(0, 10).map(link).join(', ')}${
  e.verified.length > 10 ? ` and ${e.verified.length - 10} more` : ''}</li>` : ''}
${e.researched.length ? `<li><strong>Researched</strong> ${group(e.researched).slice(0, 8).map(([id, labels]) =>
  `${link(id)} ${esc([...new Set(labels)].join(', '))}`).join('; ')}${
  group(e.researched).length > 8 ? ` and ${group(e.researched).length - 8} more records` : ''}</li>` : ''}
</ul>
</li>`).join('')}</ol>`}

<p class="doc-cta">
  <a href="../data-quality/">How records are judged &rarr;</a><br>
  <a href="../methodology/">The rules every figure had to pass &rarr;</a>
</p>
</div>
`;

  return page({
    title: 'What changed in the dataset — corrections and additions | LLM World',
    description: 'A changelog of the LLM World dataset: records added, records verified, '
      + 'and every figure this site published wrong and later corrected.',
    canonical: `${BASE_URL}/changes/`,
    section: 'changes/',
    depth: 1,
    sprites: [],
    body,
  });
}

/**
 * RSS 2.0 at /feed.xml — the 20 most recent releases and milestones.
 *
 * A feed is the one syndication format that costs nothing to maintain: it is
 * the same dataset in a different envelope, regenerated on every build, and it
 * cannot drift because there is nothing to keep in sync.
 *
 * pubDate must be RFC 822, not ISO 8601. Readers that parse strictly drop items
 * with an ISO date silently, which is the worst failure mode available — the
 * feed validates, serves, and simply appears empty.
 *
 * Dates carry no time of day here, so every item is stamped 00:00:00 GMT. That
 * is honest: the dataset records the day a model was announced, not the hour.
 */
const RFC822_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC822_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function rfc822(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${RFC822_DAY[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${RFC822_MON[d.getUTCMonth()]} `
    + `${d.getUTCFullYear()} 00:00:00 GMT`;
}

function feedXml() {
  const items = [
    ...releases.map((r) => ({
      title: `${r.model} — ${r.company}`,
      link: `${BASE_URL}/models/${r.id}/`,
      iso: isoDate(r),
      sort: stamp(r),
      guid: `${BASE_URL}/models/${r.id}/`,
      description: `${r.company} released ${r.model} on ${fullDate(r)}.`
        + (r.note ? ` ${r.note}` : ''),
    })),
    ...milestones.map((m) => ({
      title: `${m.title} — ${m.company}`,
      link: `${BASE_URL}/milestones/${m.id}/`,
      iso: m.date,
      sort: Date.parse(`${m.date}T00:00:00Z`),
      guid: `${BASE_URL}/milestones/${m.id}/`,
      description: `${m.note ?? m.title} Recorded as a milestone, not a model release.`,
    })),
  ].filter((i) => i.iso).sort((a, b) => b.sort - a.sort).slice(0, 20);

  const built = rfc822(data.updated) ?? rfc822(items[0]?.iso);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>LLM World — tracked model releases</title>
    <link>${BASE_URL}/</link>
    <atom:link href="${BASE_URL}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Every large language model release this project tracks, each traced to the lab's own announcement, paper, model card or documentation.</description>
    <language>en</language>
    <lastBuildDate>${built}</lastBuildDate>
    <docs>https://www.rssboard.org/rss-specification</docs>
${items.map((i) => `    <item>
      <title>${esc(i.title)}</title>
      <link>${esc(i.link)}</link>
      <guid isPermaLink="true">${esc(i.guid)}</guid>
      <pubDate>${rfc822(i.iso)}</pubDate>
      <description>${esc(i.description)}</description>
    </item>`).join('\n')}
  </channel>
</rss>
`;
}

/**
 * /analytics/pricing/ — a table, deliberately not a bar chart.
 *
 * Sixteen records carry pricing, and their observed_on dates span 2024-06-20 to
 * 2026-07-24 across fourteen distinct observations. Token prices moved by one
 * to two orders of magnitude in that window, so a bar chart of "input price per
 * million tokens" across those sixteen would rank them by WHEN SOMEBODY LOOKED,
 * not by price — and GPT-4 would render as the most expensive model on the site
 * because its figure is the oldest observation here.
 *
 * A caption cannot retract that. The entire proposition of a bar chart is that
 * the bars are comparable, and these are not. This is the same failure the
 * field rename already fixed once: observed_on exists because effective_from
 * presented a 2026 snapshot as a May-2024 launch price, off by up to 1,076
 * days.
 *
 * So the observation date is a column, sortable by eye, sitting beside every
 * figure — and the one chart on the page plots price AGAINST observation date,
 * which shows the confound instead of hiding it.
 */
function pricingPage() {
  const priced = releases
    .filter((r) => r.pricing?.length)
    .map((r) => ({ r, p: [...r.pricing].sort((a, b) => (b.observed_on ?? '').localeCompare(a.observed_on ?? ''))[0] }))
    .filter((x) => x.p?.rates)
    .sort((a, b) => (b.p.observed_on ?? '').localeCompare(a.p.observed_on ?? ''));

  const money = (n) => n == null ? MISSING_LABEL.unresearched
    : `$${n >= 1 ? n.toFixed(2).replace(/\.00$/, '') : n.toFixed(3).replace(/0$/, '')}`;

  const dates = priced.map((x) => x.p.observed_on).filter(Boolean).sort();
  const oldest = dates[0], newest = dates[dates.length - 1];
  const spread = Math.round((Date.parse(newest) - Date.parse(oldest)) / 86400000);

  // Source citation: the archived snapshot the figure was read from.
  const cite = (x) => {
    const id = x.p.sources?.[0];
    const src = id && x.r.sources.find((s) => s.id === id);
    if (!src) return '<span class="pr-nosrc">no source recorded</span>';
    const href = src.archived_url ?? src.url;
    return `<a href="${esc(href)}" rel="noopener">${esc(src.archived_url ? 'snapshot' : 'live page')}</a>`;
  };

  const rows = priced.map((x) => `<tr>
<th scope="row"><a href="../../models/${esc(x.r.id)}/">${esc(x.r.model)}</a>
<span class="pr-lab">${esc(x.r.company)}</span></th>
<td class="pr-num">${money(x.p.rates.input)}</td>
<td class="pr-num">${money(x.p.rates.output)}</td>
<td class="pr-when"><time datetime="${esc(x.p.observed_on ?? '')}">${esc(x.p.observed_on ?? 'undated')}</time></td>
<td class="pr-src">${cite(x)}</td>
</tr>`).join('');

  // The one chart worth drawing: price against WHEN it was observed.
  const W = 720, H = 280, PAD = { l: 54, r: 16, t: 16, b: 34 };
  const pts = priced.filter((x) => x.p.observed_on && x.p.rates.input != null);
  const t0 = Math.min(...pts.map((x) => Date.parse(x.p.observed_on)));
  const t1 = Math.max(...pts.map((x) => Date.parse(x.p.observed_on)));
  const vals = pts.map((x) => x.p.rates.input).filter((v) => v > 0);
  const lo = Math.log10(Math.min(...vals)), hi = Math.log10(Math.max(...vals));
  const px = (x) => PAD.l + (Date.parse(x.p.observed_on) - t0) / Math.max(1, t1 - t0) * (W - PAD.l - PAD.r);
  const py = (v) => H - PAD.b - (Math.log10(v) - lo) / Math.max(0.001, hi - lo) * (H - PAD.t - PAD.b);

  const ticks = [0.1, 1, 10, 100].filter((v) => Math.log10(v) >= lo - 0.5 && Math.log10(v) <= hi + 0.5);
  const grid = ticks.map((v) => `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}" class="cs-grid"/>
<text x="${PAD.l - 8}" y="${(py(v) + 4).toFixed(1)}" class="cs-tick" text-anchor="end">${money(v)}</text>`).join('');

  const dots = pts.map((x) => `<circle cx="${px(x).toFixed(1)}" cy="${py(x.p.rates.input).toFixed(1)}" r="4" class="cs-dot">
<title>${esc(x.r.model)} — ${money(x.p.rates.input)} per million input tokens, observed ${esc(x.p.observed_on)}</title></circle>`).join('');

  const yearsShown = [...new Set(pts.map((x) => x.p.observed_on.slice(0, 4)))].sort();
  const yearMarks = yearsShown.map((y) => {
    const at = pts.find((x) => x.p.observed_on.startsWith(y));
    return `<text x="${px(at).toFixed(1)}" y="${H - 12}" class="cs-tick" text-anchor="middle">${y}</text>`;
  }).join('');

  const body = `
${crumbs('../../', ['Analytics', '../'], ['Pricing'])}
${hero({
  title: 'What the labs charge',
  sub: `Published API prices for ${priced.length} of ${releases.length} tracked
releases, each read from the lab's own page on a recorded date.`,
})}

<div class="prose">
<p class="doc-note"><strong>These figures are not directly comparable.</strong> Each is a
price observed on a particular day, and those days span ${spread.toLocaleString('en-US')}
days — from ${esc(oldest)} to ${esc(newest)}. Two figures read years apart are not a
price comparison, and published prices are cut without notice, so any of these may be
stale. The observation date is in every row for that reason, and there is no chart
ranking these against each other, because a bar chart would assert a comparison the data
cannot support.</p>

<h2>Published prices, per million tokens</h2>
<p class="chart-note">Newest observation first. USD, per million tokens, as published by
the lab. Where a record carries several observations, the most recent is shown.</p>
<div class="table-scroll"><table class="pr-table">
<thead><tr>
<th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th>
<th scope="col">Observed</th><th scope="col">Source</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>

<h2>Price against when it was read</h2>
<p class="chart-note">The same figures plotted against their observation date, log scale.
This is the confound made visible — but not in the direction you might expect. Fourteen
of the sixteen were read within one recent stretch, and the vertical spread inside that
stretch is far wider than the gap to the two older readings: prices within a single week
range from $1.25 to $75, because they are different tiers of model, not different eras.
The date matters for whether two figures can be compared at all; it does not, on this
data, explain the spread.</p>
<figure class="cs-figure">
<svg viewBox="0 0 ${W} ${H}" role="img" class="cs-chart"
     aria-label="Input price per million tokens plotted against the date each price was observed, log scale.">
${grid}${dots}${yearMarks}
</svg>
<figcaption>Input price per million tokens, against observation date. Each point is one
release; hover for the model and the date.</figcaption>
</figure>

<h2>What is missing</h2>
<p>${releases.length - priced.length} of ${releases.length} records carry no pricing at
all. Open-weights releases often have no list price to record, and several proprietary
labs publish pricing only on pages that change without notice — which is why every figure
here is cited to a dated snapshot rather than a live page. No record carries more than one
observation yet, so price cuts are not yet visible; the schema holds a list precisely so
they can be, once a second reading exists.</p>
</div>

<p class="doc-cta">
  <a href="../">Back to analytics &rarr;</a><br>
  <a href="../../methodology/">Why a price is recorded as observed, not effective &rarr;</a>
</p>`;

  return page({
    title: 'What the labs charge — published API pricing | LLM World',
    description: `Published per-million-token API prices for ${priced.length} tracked releases, `
      + 'each cited to a dated snapshot, with the observation date beside every figure.',
    canonical: `${BASE_URL}/analytics/pricing/`,
    section: 'analytics/',
    depth: 2,
    sprites: [],
    body,
  });
}

/**
 * Labs against capabilities — restricted, because the full grid is mostly holes.
 *
 * All 17 labs by all 13 capabilities is 221 cells of which 145 are empty, and
 * eight labs have fewer than three researched records. An empty cell means "not
 * evidenced", but at that density it reads as "this lab does not do vision" —
 * which is absence rendered as measurement, the exact error the reasoning audit
 * removed from the dataset.
 *
 * So: labs with at least five researched records, capabilities evidenced on at
 * least three, and the denominator printed in every row. What is left is a
 * comparison the data can carry.
 */
function labCapabilityMatrix() {
  const known = releases.filter((r) => r.modalities);

  const byLab = new Map();
  for (const r of known) (byLab.get(r.company) ?? byLab.set(r.company, []).get(r.company)).push(r);
  const labs = [...byLab.entries()].filter(([, l]) => l.length >= 5).sort((a, b) => b[1].length - a[1].length);

  const totals = new Map();
  for (const r of known) for (const c of r.capabilities ?? []) totals.set(c, (totals.get(c) ?? 0) + 1);
  const caps = [...totals.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([c]) => c);

  if (!labs.length || !caps.length) return '';

  const hidden = byLab.size - labs.length;
  const head = caps.map((c) => `<th scope="col">${esc(tagLabel(c))}</th>`).join('');
  const rows = labs.map(([lab, list]) => `<tr>
<th scope="row"><a href="../companies/${companySlug(lab)}/">${esc(lab)}</a>
<span class="pr-lab">${list.length} researched</span></th>
${caps.map((c) => {
    const n = list.filter((r) => (r.capabilities ?? []).includes(c)).length;
    const pct = Math.round(n / list.length * 100);
    return `<td class="cap-cell"${n ? ` style="--fill:${(0.1 + pct / 100 * 0.9).toFixed(2)}"` : ''}>
<span class="cap-n">${n}</span><span class="cap-of">/${list.length}</span></td>`;
  }).join('')}
</tr>`).join('');

  return `<div class="table-scroll"><table class="cap-matrix">
<thead><tr><th scope="col">Lab</th>${head}</tr></thead>
<tbody>${rows}</tbody></table></div>
${hidden ? `<p class="chart-note">${hidden} lab${hidden === 1 ? '' : 's'} with fewer than five
researched releases ${hidden === 1 ? 'is' : 'are'} left out — at one or two records a row
says more about how much has been researched than about the lab.</p>` : ''}`;
}

function analyticsPage(byCompany, byYear) {
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const modalityYears = modalityEvolution();
  const capEvo = capabilityEvolution();

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
${crumbs('../', ['Analytics'])}
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
<p class="doc-cta"><a href="context-windows/">Read the full study: how the context window grew, step by step →</a></p>
<p class="doc-cta"><a href="pricing/">What the labs charge, and why the figures are not comparable →</a></p>

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

<h2>When each capability was first evidenced</h2>
<p class="chart-note">The earliest tracked release this dataset can SHOW carrying
each capability, with the source behind it on the model's page. Not a claim about
who did it first — only about what has been evidenced here, from the
${capEvo.researched} records whose capabilities have been researched.</p>
<ol class="cap-firsts">${capEvo.firsts.map(({ cap, r }) => `<li>
<span class="cap-first-name">${esc(tagLabel(cap))}</span>
<span class="cap-first-when"><time datetime="${isoDate(r)}">${fullDate(r)}</time></span>
<a class="cap-first-model" href="../models/${esc(r.id)}/">${esc(r.model)}</a>
</li>`).join('')}</ol>

<h2>Capability adoption over time</h2>
<p class="chart-note">Releases evidencing each capability, over the releases of that
year whose capabilities have been researched. Read the counts: the denominator is
small in early years, and a capability absent from a record means it has not been
evidenced, never that the model lacks it — see
<a href="../data-quality/">data quality</a>.</p>
${capabilityMatrix(capEvo)}

<h2>Which labs evidence which capabilities</h2>
<p class="chart-note">Counted over each lab's researched releases, not all of them, and
the denominator is in every cell. A zero means the capability has not been evidenced on
that lab's records — never that its models lack it. Labs with fewer than five researched
releases are excluded, because at that size a row measures our research rather than the
lab.</p>
${labCapabilityMatrix()}

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
${crumbs('../', ['Compare'])}
<div class="doc-hero"><div>
  <h1>Compare models</h1>
  <p class="doc-sub">Pick two to five releases and read them side by side</p>
</div></div>

<div class="cmp-pickers" id="cmp-pickers"></div>
<p class="chart-note" id="cmp-hint">Add a model to begin.</p>

<div class="cmp-scroll"><table class="cmp-table" id="cmp-table"></table></div>

<section class="cmp-changed" id="cmp-changed" hidden>
  <h2>What changed</h2>
  <p class="chart-note">Read in release order. A field is compared only when both
  releases state a value — where one of them does not, the field is listed as
  uncomparable rather than dropped, because a gap in our research is not a
  finding about the model.</p>
  <div id="cmp-changed-body"></div>
</section>

<p class="doc-share">
  <button type="button" class="copy-btn" data-copy="url" hidden>Copy link</button>
  <button type="button" class="copy-btn" data-copy="md" data-copy-title="Model comparison — LLM World" hidden>Copy as Markdown</button>
</p>

<noscript><p class="doc-note">The comparison picker needs JavaScript. Every model's
figures are also on its own page — start from <a href="../models/">the model index</a>.</p></noscript>

<p class="doc-cta"><a href="../analytics/">See release analytics →</a></p>

<script type="module">
// Same derivation the static pages use, from the same module — this page reads
// the raw dataset at runtime, so without it the canonical date would be
// computed twice by two different rules.
import { dateParts, contextWindow, parameterCount, fieldState, MISSING_LABEL, diffRecords } from '../lib/record.mjs';
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

  renderChanged(models);
}

/**
 * The diff between consecutive picks, in release order.
 *
 * The table above says what each model IS; this says what moved between them,
 * which is the question people are actually asking when they put two releases
 * side by side. diffRecords is the same function the model and family pages
 * use — it compares a field only when both records assert a value, so a null
 * never becomes "removed".
 *
 * Sorted by date rather than by pick order: "what changed" only means anything
 * in one direction, and a reader who added the newer model first should not be
 * told the context window shrank.
 */
function renderChanged(models) {
  const box = document.getElementById('cmp-changed');
  const body = document.getElementById('cmp-changed-body');
  const stamp = (r) => Date.UTC(r.year, r.month - 1, r.day || 1);
  const ordered = [...models].sort((a, b) => stamp(a) - stamp(b));
  body.replaceChildren();

  let shown = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1], next = ordered[i];
    const { changes, incomparable } = diffRecords(prev, next);
    if (!changes.length && !incomparable.length) continue;
    shown++;

    const sec = document.createElement('section');
    sec.className = 'cmp-diff';
    const h = document.createElement('h3');
    h.textContent = \`\${prev.model} → \${next.model}\`;
    sec.appendChild(h);

    if (changes.length) {
      const ul = document.createElement('ul');
      ul.className = 'cmp-diff-list';
      for (const c of changes) {
        const li = document.createElement('li');
        li.dataset.direction = c.direction;
        const label = document.createElement('span');
        label.className = 'cmp-diff-label';
        label.textContent = c.label;
        li.appendChild(label);
        const val = document.createElement('span');
        val.className = 'cmp-diff-value';
        // "first evidenced" carries a list, not a from/to pair.
        val.textContent = c.gained ? c.gained.join(', ') : \`\${c.from} → \${c.to}\`;
        li.appendChild(val);
        ul.appendChild(li);
      }
      sec.appendChild(ul);
    }

    if (incomparable.length) {
      const p = document.createElement('p');
      p.className = 'cmp-diff-gap';
      p.textContent = 'Not comparable: '
        + incomparable.map((x) => \`\${x.label} (\${x.why})\`).join('; ');
      sec.appendChild(p);
    }
    body.appendChild(sec);
  }

  box.hidden = shown === 0;
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
write('analytics/context-windows', contextStudyPage());
write('analytics/pricing', pricingPage());
write('api', apiPage());
write('data-quality', dataQualityPage());
write('changes', changesPage());

// The two documents that justify the dataset. They live in docs/ because they
// are edited alongside the rules they describe, and they are published because
// "why should I believe this figure?" deserves an answer with a URL.
write('methodology', docPage({
  file: 'docs/METHODOLOGY.md',
  slug: 'methodology',
  title: 'Methodology',
  description: 'How LLM World decides what counts as a source, what "verified" means, '
    + 'and why a missing value is left missing.',
  lead: 'What counts as evidence here, what the record statuses mean, and the rules '
    + 'every figure on this site had to pass.',
}));
write('taxonomy', docPage({
  file: 'docs/TAXONOMY.md',
  slug: 'taxonomy',
  title: 'Taxonomy',
  description: 'How LLM World classifies models: primary types, subtypes, modalities '
    + 'and capabilities, and how overlapping classifications resolve.',
  lead: 'The definitions behind every label on this site — model types, subtypes, '
    + 'modalities and capabilities, and how they overlap.',
}));
write('contribute', docPage({
  file: 'docs/CONTRIBUTING.md',
  slug: 'contribute',
  title: 'Contributing',
  description: 'How to add or correct a release in the LLM World dataset: the spec format, '
    + 'the enrichment pass, and the five rules every record has to pass.',
  lead: 'How to add a release, how to correct one, and the five rules every record '
    + 'has to pass before it can ship.',
}));

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
  }), { sitemap: false });
}

/* The interactive timeline moved off the root so the landing page can ask one
   question instead of presenting a control panel. It is emitted from
   timeline.html with asset paths lifted one level and the shared chrome
   swapped in, so there is still exactly one copy of the header and footer. */
{
  let page = timelineHtml
    .replace(/(href|src)="(?!https?:|#|mailto:|data:|\/)([^"]+)"/g, (m, attr, href) =>
      `${attr}="../${href === './' ? '' : href}"`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${BASE_URL}/timeline/">`);

  // Shared chrome, at this page's depth, with Timeline marked current.
  const swap = (name, shared) => {
    const a = page.indexOf(`<!-- shared:${name}-start`);
    const b = page.indexOf(`<!-- shared:${name}-end -->`);
    if (a < 0 || b < 0) throw new Error(`timeline.html is missing shared:${name} markers`);
    page = page.slice(0, page.indexOf('-->', a) + 3) + '\n' + shared + '\n' + page.slice(b);
  };
  page = page.replace('<!-- sprite -->', spriteSvg.trim());
  swap('header', chrome(SHARED_HEADER, '../', 'timeline/'));
  swap('footer', chrome(SHARED_FOOTER, '../'));

  write('timeline', page);
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
  }), { sitemap: false });
}
/* -------------------------------------------------------------------- posts
 *
 * Question-shaped pages: /posts/ and /posts/<slug>/.
 *
 * A post is a markdown file in content/posts/ with frontmatter. The prose is
 * written by a person; the numbers are not. A `history:` key expands to the
 * generated change table, its sources and its caveats, which means a post
 * cannot drift out of date as records are added — the thing that makes every
 * hand-written "state of AI models" page wrong within a month.
 *
 * The frontmatter deliberately carries the QUESTION as well as the title. These
 * pages exist to be found by someone asking something, and the question is what
 * gets indexed, quoted and linked.
 */
function readPosts() {
  const dir = 'content/posts';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const src = readFileSync(join(dir, file), 'utf8');
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
      if (!m) throw new Error(`content/posts/${file}: missing frontmatter block`);
      const meta = Object.fromEntries(
        m[1].split('\n').filter(Boolean).map((line) => {
          const i = line.indexOf(':');
          if (i < 0) throw new Error(`content/posts/${file}: bad frontmatter line "${line}"`);
          return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        }),
      );
      for (const k of ['title', 'question', 'date']) {
        if (!meta[k]) throw new Error(`content/posts/${file}: frontmatter needs "${k}"`);
      }
      return { ...meta, slug: file.replace(/\.md$/, ''), body: m[2].trim() };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * `draft: true` keeps a post out of the built site.
 *
 * Posts are written in batches and released one at a time, so the file existing
 * cannot be what publishes it. A draft is skipped completely — no page, no index
 * row, no sitemap entry — and the build says how many it skipped, because a post
 * silently absent from the site is indistinguishable from one you forgot.
 *
 * NOT a privacy mechanism. This repository is public: a draft's prose is readable
 * on GitHub the moment it is committed. `draft: true` controls what the SITE
 * publishes, not what the world can see. Anything genuinely unready to be read
 * belongs outside the repo until it is.
 */
const isDraft = (p) => String(p.draft).toLowerCase() === 'true';

/**
 * Post directives: the generated half of a post.
 *
 * A directive is one frontmatter key. It returns the markdown to append and the
 * CLAIMS that markdown asserts — the values a headline is computed from. Adding
 * a post type is one entry here, and it inherits the gate below for free.
 *
 * Each `run` receives the raw frontmatter value, so a directive owns its own
 * argument syntax rather than pushing a parser into the caller.
 */
const POST_DIRECTIVES = {
  /** `history: Company | field` */
  history(spec, post) {
    const [company, field] = String(spec).split('|').map((s) => s.trim());
    const h = fieldHistory(rawReleases, company, field);
    // A post naming a history the data cannot support fails the build rather
    // than publishing an empty table — a gap is reported, never rendered as a
    // finding.
    if (h.insufficient) {
      throw new Error(
        `content/posts/${post.slug}.md: "${company}" has ${h.known.length} recorded `
        + `${h.label} value(s). A history needs two.`,
      );
    }
    const caveats = historyCaveats(h);
    return {
      md: `\n\n${historyTable(h, (x) => `../../models/${x.id}/`)}`
        + `\n\n## Every change, and the document behind it\n\n${historySources(h)}`
        + (caveats.length
          ? `\n\n## What this does not claim\n\n${caveats.map((c) => `- ${c}`).join('\n')}`
          : ''),
      claims: historyClaims(h),
    };
  },

  /** `openweights: by-year` */
  openweights(spec, post) {
    if (spec !== 'by-year') {
      throw new Error(`content/posts/${post.slug}.md: unknown openweights mode "${spec}"`);
    }
    const ow = openWeightsByYear(rawReleases);
    const fr = openWeightsFrontier(rawReleases);
    const flips = ow.crossings.length;
    const level = frontierLevel(fr);
    return {
      md: `\n\n## How many releases, by licence\n\n${openWeightsTable(ow)}`
        + `\n\n## The largest context window on each side\n\n${openWeightsFrontierTable(fr)}`
        + `\n\n## What this does not claim\n\n`
        + `- **Release count is not capability.** The first table counts how often a model `
        + `shipped, not how good it was. In ${fr.at(-1).year} the proprietary total is `
        + `concentrated in a few labs that ship many increments.\n`
        + `- These are the ${ow.tracked} releases this dataset tracks, not every release `
        + `that happened. Each year's direction is evidenced; the absolute counts are a sample.\n`
        + `- \`access.open_weights\` is recorded on every record and must agree with the `
        + `\`open-weights\` tag, so unlike most fields here this one has no gaps.\n`
        + (flips
          ? `- The share crossed the 50% line ${flips} time${flips === 1 ? '' : 's'} `
            + `(${ow.crossings.map((c) => c.year).join(', ')}). A single year's shift is not a trend.\n`
          : '')
        + (level.length
          ? `- Context window is the only capability recorded on both sides here, and it is `
            + `one axis, not a ranking. Open weights led it, or came within `
            + `${LEVEL_TOLERANCE * 100}%, in ${level.map((r) => r.year).join(', ')}.\n`
          : '')
        + (frontierUnsourced(fr).length
          ? `- Marked ⚠︎: ${frontierUnsourced(fr).map((u) => `${u.model} (${u.year})`).join(', ')} `
            + `— in the dataset, but the context window is not yet traced to a primary source. `
            + `Treat any comparison resting on those as provisional.\n`
          : ''),
      claims: frontierClaims(fr),
    };
  },
};

/**
 * The gate: a post may not publish a claim nothing sources.
 *
 * Two drafts of the open-weights post asserted things the dataset could not back
 * — "open weights lost badly in 2026" from a release count, then "match the
 * frontier" on a Kimi K3 figure with no evidence[] entry. Both read as facts.
 * Neither would have been caught by validate (the records are fine) or by smoke
 * (the HTML is fine). The failure is one level up: a true dataset, a false
 * sentence.
 *
 * The escape hatch is deliberate. Some posts are worth publishing WITH the gap
 * showing — that is the whole ⚠︎ mechanism — so a post may opt out by naming the
 * reason in frontmatter:
 *
 *   unverified: allow — the 2026 open frontier is untraced; the page flags it
 *
 * What it cannot do is opt out silently. `allow` on its own is rejected: the
 * reason is the point, because it is what a reader would want to have been told.
 */
function gatePostClaims(post, claims) {
  const bad = claims.filter((c) => !c.sourced);
  if (!bad.length) return;

  const opt = post.unverified ?? '';
  const reason = /^allow\b[\s—:-]*(.*)$/.exec(opt)?.[1]?.trim();
  if (reason) return;

  throw new Error(
    `content/posts/${post.slug}.md publishes ${bad.length} claim(s) with no primary source:\n`
    + bad.map((c) => `    ${c.model} — ${c.label} = ${c.value} (${c.status})`).join('\n')
    + '\n  Trace them (scripts/attribute-facts.mjs), or say why they can ship anyway:\n'
    + '    unverified: allow — <reason a reader would accept>',
  );
}

function postPage(post) {
  let body = post.body;
  const claims = [];

  for (const [key, run] of Object.entries(POST_DIRECTIVES)) {
    if (!post[key]) continue;
    const { md, claims: got } = run(post[key], post);
    body += md;
    claims.push(...(got ?? []));
  }
  gatePostClaims(post, claims);

  return page({
    title: `${post.title} | LLM World`,
    description: post.question,
    canonical: `${BASE_URL}/posts/${post.slug}/`,
    section: 'posts/',
    depth: 2,
    sprites: [],
    body: `
${crumbs('../../', ['Posts', '../'], [esc(post.title)])}
${hero({ title: esc(post.title), sub: esc(post.question) })}
<div class="prose">${renderMarkdown(body)}</div>
<p class="doc-cta">
  <a href="../">More questions →</a><br>
  <a href="../../methodology/">How a value gets to "verified" →</a>
</p>`,
  });
}

function postsIndexPage(posts) {
  return page({
    title: 'Posts | LLM World',
    description: 'Questions about how AI models changed over time, answered from the '
      + 'dataset, with every value traced to the lab that published it.',
    canonical: `${BASE_URL}/posts/`,
    section: 'posts/',
    depth: 1,
    sprites: [],
    /* The list is the served markup; grid is a preference layered on top, so a
       reader without JavaScript gets the full index rather than an empty shell
       — the button ships hidden and is revealed only once this runs.
       Wrapped in an IIFE on purpose: page globals and inline-script identifiers
       share a scope here, and a bare `params` once shadowed URLSearchParams and
       killed the compare page silently. */
    head: `<script defer>
addEventListener('DOMContentLoaded',function(){(function(){
  var list=document.getElementById('posts-list'),btn=document.getElementById('posts-view');
  if(!list||!btn)return;
  var view='list';
  function apply(v){
    view=v;
    list.setAttribute('data-view',v);
    btn.setAttribute('aria-pressed',String(v==='grid'));
    btn.textContent=v==='grid'?'List':'Grid';
  }
  var wanted=new URLSearchParams(location.search).get('view');
  if(!wanted){try{wanted=localStorage.getItem('posts-view');}catch(e){}}
  apply(wanted==='grid'?'grid':'list');
  btn.hidden=false;
  btn.addEventListener('click',function(){
    apply(view==='grid'?'list':'grid');
    try{localStorage.setItem('posts-view',view);}catch(e){}
    var u=new URL(location.href);
    if(view==='grid')u.searchParams.set('view','grid');else u.searchParams.delete('view');
    history.replaceState(null,'',u);
  });
})();});
</script>`,
    body: `
${crumbs('../', ['Posts'])}
${hero({
      title: 'Posts',
      sub: `${posts.length} question${posts.length === 1 ? '' : 's'} answered from the dataset`,
    })}
<p class="chart-note">Each page answers one question. The prose is written; the
numbers, tables and sources are generated from the dataset on every build, so a
post cannot quietly go stale as records are added.</p>
<div class="view-switch"><button type="button" id="posts-view" aria-pressed="false"
  aria-controls="posts-list" hidden>Grid</button></div>
<ol class="doc-list" id="posts-list" data-view="list">${posts.map((p) => listRow({
      // A post about one lab carries that lab's hue, the same pair used on the
      // timeline chips, so a lab looks the same wherever you meet it.
      // A post about one lab carries that lab's monogram and hue. A post about
      // the whole dataset carries the site's own — "other" renders as an "OT"
      // badge, which reads as a lab nobody has heard of.
      company: p.history ? p.history.split('|')[0].trim() : 'LLM World',
      href: `${esc(p.slug)}/`,
      // The QUESTION is the link text: these pages exist to be found by someone
      // asking something, and the question is what gets indexed and quoted. The
      // meta column is sized for short labels, so the lab goes there, not the
      // title — a headline truncated mid-word reads as a bug.
      name: esc(p.question),
      meta: esc(p.history ? p.history.split('|')[0].trim() : 'Dataset'),
      num: esc(p.date),
    })).join('')}</ol>
`,
  });
}

const ALL_POSTS = readPosts();
const POSTS = ALL_POSTS.filter((p) => !isDraft(p));
const DRAFTS = ALL_POSTS.length - POSTS.length;
if (POSTS.length) {
  write('posts', postsIndexPage(POSTS));
  for (const p of POSTS) write(`posts/${p.slug}`, postPage(p));
}
// Drafts are rendered but not written, so the gate still runs on them. Finding
// out a post cannot be sourced at the moment you decide to publish it is finding
// out too late — and a draft that fails must not fail the BUILD, or the flag
// stops being a way to park unfinished work.
for (const p of ALL_POSTS.filter(isDraft)) {
  try {
    postPage(p);
    console.log(`  draft ready: ${p.slug}`);
  } catch (err) {
    console.log(`  draft NOT publishable: ${p.slug}\n    ${err.message.split('\n')[0]}`);
  }
}

write('compare', comparePage());

const BASE = BASE_URL;
const urls = [
  `${BASE}/`,
  ...[...WRITTEN].sort().map((p) => `${BASE}/${p}/`),
];
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${u}</loc><lastmod>${data.updated}</lastmod></url>`).join('\n')}\n</urlset>\n`);
writeFileSync(join(OUT, 'feed.xml'), feedXml());
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
    /**
     * Counts, so a badge can read them without downloading the dataset.
     *
     * The README used to state these in prose and went stale within days.
     * shields.io reads this endpoint, so the badge on the repository front page
     * cannot disagree with what was last deployed.
     */
    stats: {
      releases: releases.length,
      labs: new Set(releases.map((r) => r.company)).size,
      families: new Set(releases.map((r) => r.family)).size,
      verified: releases.filter((r) => r.provenance?.status === 'verified').length,
      open_weights: releases.filter((r) => r.access?.open_weights).length,
      non_language: releases.filter((r) => (r.classification?.primary_type ?? 'language') !== 'language').length,
      milestones: milestones.length,
    },
    endpoints: {
      models: `${BASE_URL}/api/models.json`,
      companies: `${BASE_URL}/api/companies.json`,
      csv: `${BASE_URL}/llm-releases.csv`,
    },
  });

  // The dataset as authored, not the view model — consumers pin against
  // schema_version and should get the real shape, derived fields excluded.
  writeJson('api/models.json', { ...META, releases: rawReleases });

  /**
   * Every evidenced value with the URL that states it, denormalised.
   *
   * In the dataset a claim cites a source ID and the URL lives in `sources`,
   * which is right for storage and useless over a wire — a consumer should not
   * have to join two collections to answer "where did this number come from".
   * This is the endpoint that makes the project's actual claim usable by a
   * machine: every figure, the lab page asserting it, and the snapshot proving
   * the page said so.
   *
   * More than one claim on a field means the sources disagree, and both are
   * emitted. Choosing a winner here would hide the most interesting thing a
   * record knows (METHODOLOGY §8, R4).
   */
  const claims = [];
  for (const r of rawReleases) {
    const byId = new Map((r.sources ?? []).map((s) => [s.id, s]));
    for (const [field, list] of Object.entries(r.evidence ?? {})) {
      for (const c of list) {
        claims.push({
          model_id: r.id,
          model: r.model,
          company: r.company,
          field,
          value: c.value,
          disputed: list.length > 1,
          sources: (c.sources ?? []).map((id) => byId.get(id)).filter(Boolean).map((s) => ({
            url: s.url,
            archived_url: s.archived_url ?? null,
            type: s.type,
            authority: s.authority,
            retrieved: s.retrieved ?? null,
          })),
        });
      }
    }
  }
  writeJson('api/claims.json', {
    ...META,
    note: 'One entry per evidenced value. `disputed: true` means sources disagree on '
      + 'this field and every competing value appears as its own entry. A field absent '
      + 'here is unresearched, never zero and never absent.',
    count: claims.length,
    claims,
  });

  /**
   * llms.txt — where an agent looks first.
   *
   * The site is built for people and the API for programs, and neither says out
   * loud what a retrieval pipeline most needs to know: which fields are thin,
   * and that a missing value is a research gap rather than a zero. A model that
   * reads a spec table with holes in it fills them in confidently. Saying so
   * here is cheaper than being misquoted.
   */
  const cov = (f) => releases.filter(f).length;
  writeFileSync(join(OUT, 'llms.txt'), [
    '# LLM World',
    '',
    `> A source-backed timeline of ${releases.length} AI model releases from `
      + `${new Set(releases.map((r) => r.company)).size} labs. Every value is traced to the `
      + "lab's own announcement, paper, model card or documentation, with an archived "
      + 'snapshot of the page that states it.',
    '',
    'Licence: CC BY 4.0 for the data (LICENSE-DATA), MIT for the code. Attribution required.',
    '',
    '## How to read a gap',
    '',
    'A missing field means NOBODY HAS TRACED IT YET. It never means zero, and it never',
    'means the model lacks that property. Capabilities in particular are recorded only',
    'where a primary source states them, so absence is silence, not denial.',
    '',
    'Field coverage, so you know what this dataset can and cannot answer:',
    '',
    ...Object.entries({
      context_window: cov((r) => r.specifications?.language?.context_window != null),
      parameter_count: cov((r) => r.specifications?.language?.parameter_count != null),
      capabilities: cov((r) => r.capabilities?.length),
      modalities: cov((r) => r.modalities),
      pricing: cov((r) => r.pricing),
      benchmarks: cov((r) => r.benchmarks?.length),
    }).map(([k, v]) => `- ${k}: ${v} of ${releases.length} (${Math.round(v / releases.length * 100)}%)`),
    '',
    'Benchmarks and pricing are sparse on purpose rather than by neglect: most labs',
    'publish benchmarks as images, and a price needs an archived page to evidence it.',
    'This dataset cannot rank models by performance. Do not ask it to.',
    '',
    '## Data',
    '',
    `- [Everything](${BASE_URL}/api/models.json): every record, as authored`,
    `- [Claims](${BASE_URL}/api/claims.json): every evidenced value with the URL stating it`,
    `- [Companies](${BASE_URL}/api/companies.json): labs and their releases`,
    `- [CSV](${BASE_URL}/llm-releases.csv): flat export`,
    `- [Index](${BASE_URL}/api/index.json): counts and endpoint discovery`,
    '',
    '## MCP',
    '',
    'An MCP server ships in the repository at mcp/server.mjs (no dependencies).',
    'It exposes search_models, get_model and dataset_stats, and answers with both',
    'matches and "not ruled out" — records meeting part of a query whose remaining',
    'fields are unevidenced. That second list is the point: it is how you avoid',
    'reporting a research gap as a negative.',
    '',
  ].join('\n') + '\n');

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

  console.log('  + export: api/index.json, api/models.json, api/companies.json,\n             api/claims.json, llms.txt, llm-releases.csv');
}

console.log(`built ${releases.length} model pages · ${byFamily.size} family pages · ${milestones.length} milestones · ${byCompany.size} company pages · ` +
  `${byYear.size} year pages · sitemap (${urls.length} urls)`);
if (!EXPORT) console.log('  bulk export skipped — pass --export to enable');

// Say what is queued. A draft that nobody remembers is a draft that never
// ships, and the same line for posts is what makes "what is waiting" answerable
// from a build rather than from memory.
if (draftMilestones.length) {
  console.log(`\n${draftMilestones.length} milestone draft(s) held back — verify, then remove \`draft: true\`:`);
  for (const m of draftMilestones) {
    const primary = (m.sources ?? []).some((x) => x.authority === 'primary');
    console.log(`  ${m.date}  ${m.title}${primary ? '' : '  (media-dated)'}`);
  }
  console.log('  node scripts/verify-milestones.mjs --drafts   checks each date against its source');
}
