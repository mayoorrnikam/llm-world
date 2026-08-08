/* ==========================================================================
   LLM WORLD — swim-lane LLM release timeline

   Data contract: data/llm-releases.json
     { "updated": "YYYY-MM-DD",
       "releases": [ { id, model, company, year, month, day, tags[], note } ] }

   All state lives in the URL, so any view is linkable:
     ?year=2025&company=OpenAI,Anthropic&tag=reasoning&q=gpt&view=grid#gpt-5

   No build step, no dependencies. Served over HTTP it fetches the JSON;
   opened via file:// (where fetch is blocked) it falls back to a small
   inline sample so the page still renders.
   ========================================================================== */

/* ------------------------------------------------------------------ config */

/** Company → CSS custom property holding that company's hue.
 *  Colour is a SECONDARY channel: every card, chip and dialog prints the
 *  company name beside the swatch, so identity never rests on hue alone.
 *  Sixteen brands exceed the ~8-slot categorical ceiling — see README. */
const COMPANY_VAR = {
  'AI21 Labs': '--c-ai21',
  'AI21': '--c-ai21',
  'Anthropic': '--c-anthropic',
  'Mistral AI': '--c-mistral',
  'Mistral': '--c-mistral',
  'Alibaba Qwen': '--c-alibaba',
  'Alibaba': '--c-alibaba',
  'Qwen': '--c-alibaba',
  'Amazon': '--c-amazon',
  'Amazon Web Services': '--c-amazon',
  'NVIDIA': '--c-nvidia',
  'Nvidia': '--c-nvidia',
  'BigScience': '--c-bigscience',
  'OpenAI': '--c-openai',
  'Microsoft': '--c-microsoft',
  'xAI': '--c-xai',
  'Google DeepMind': '--c-google',
  'Google': '--c-google',
  'DeepSeek': '--c-deepseek',
  'Meta AI': '--c-meta',
  'Meta': '--c-meta',
  'Moonshot AI': '--c-moonshot',
  'Moonshot': '--c-moonshot',
  'Zhipu AI': '--c-zhipu',
  'Zhipu': '--c-zhipu',
  'Cohere': '--c-cohere',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Loose era labels, used only as colour-free context in the dialog. */
const ERAS = [
  [2022, 'Pre-ChatGPT scaling'],
  [2023, 'The assistant boom'],
  [2024, 'Multimodal & open weights'],
  [2025, 'Reasoning models'],
  [2026, 'Agentic systems'],
];

/** Used only when data/llm-releases.json cannot be fetched (e.g. file://). */
const FALLBACK_DATA = {
  updated: null,
  releases: [
    { id: 'gpt-4', model: 'GPT-4', company: 'OpenAI', year: 2023, month: 3, day: 14,
      tags: ['flagship', 'multimodal'],
      note: "OpenAI's flagship multimodal model — the first widely used system to accept both text and image inputs." },
    { id: 'claude-2', model: 'Claude 2', company: 'Anthropic', year: 2023, month: 7, day: 11,
      tags: ['flagship'],
      note: "Anthropic's second-generation assistant, shipping with a 100K-token context window at launch." },
    { id: 'llama-2', model: 'Llama 2', company: 'Meta AI', year: 2023, month: 7, day: 18,
      tags: ['open-weights'],
      note: "Meta's open-weights family (7B–70B), released for commercial use." },
    { id: 'gpt-4o', model: 'GPT-4o', company: 'OpenAI', year: 2024, month: 5, day: 13,
      tags: ['flagship', 'multimodal'],
      note: '"Omni" model with native audio, vision and text.' },
  ],
};

/* ------------------------------------------------------------------- state */

const state = {
  releases: [],
  updated: null,
  usingFallback: false,
  years: [],
  year: null,          // number, or 'all'
  companies: new Set(),
  tags: new Set(),
  query: '',
  view: 'lanes',       // 'lanes' | 'grid'
  visible: [],         // current filtered result set, date-sorted
  openId: null,
};

const el = (id) => document.getElementById(id);
const els = {};
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let transitioning = false;

/* -------------------------------------------------------------------- init */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  for (const id of ['search', 'search-clear', 'year-selector', 'spark', 'spark-track',
    'statbar', 'legend', 'tagbar', 'reset-btn', 'lanes', 'empty-state', 'empty-sub',
    'empty-action', 'data-status', 'modal', 'modal-close', 'modal-title', 'modal-company',
    'modal-date', 'modal-era', 'modal-tags', 'modal-note', 'modal-prev', 'modal-next',
    'modal-copy', 'help', 'help-btn', 'help-close', 'theme-toggle', 'refresh-btn',
    'live']) {
    els[camel(id)] = el(id);
  }

  initTheme();
  wireControls();

  await loadData();

  state.years = computeYears();
  readUrl();

  // A bare #release link should also land on that release's year, so the
  // timeline behind the dialog shows it in context.
  const target = state.releases.find(
    (r) => r.id === decodeURIComponent(location.hash.slice(1)));
  if (target && !new URLSearchParams(location.search).has('year')) {
    state.year = target.year;
  }

  buildYearSelector();
  buildLegend();
  buildTagBar();
  render();

  els.lanes.setAttribute('aria-busy', 'false');
  renderStatus();

  if (target) openModal(target);
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/* -------------------------------------------------------------------- data */

async function loadData() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch('data/llm-releases.json', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const norm = normalize(json);
    if (!norm.releases.length) throw new Error('no valid releases');
    Object.assign(state, norm);
  } catch {
    Object.assign(state, normalize(FALLBACK_DATA), { usingFallback: true });
  }
}

function normalize(json) {
  const list = Array.isArray(json?.releases) ? json.releases : [];
  const releases = list
    .filter((r) => r && typeof r.model === 'string' && r.model.trim())
    .map((r) => ({
      id: String(r.id || slug(r.model)),
      model: String(r.model).trim(),
      company: String(r.company || 'Unknown').trim(),
      year: Number(r.year),
      month: Number(r.month),
      day: Number(r.day) || 0,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      note: typeof r.note === 'string' ? r.note : '',
    }))
    .filter((r) => Number.isFinite(r.year) && r.month >= 1 && r.month <= 12)
    .sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day
      || a.model.localeCompare(b.model));

  return {
    updated: typeof json?.updated === 'string' ? json.updated : null,
    releases,
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function computeYears() {
  const seen = [...new Set(state.releases.map((r) => r.year))].sort((a, b) => a - b);
  if (!seen.length) return [new Date().getFullYear()];
  const out = [];
  for (let y = seen[0]; y <= seen.at(-1); y++) out.push(y);
  return out;
}

const varFor = (company) => COMPANY_VAR[company] || '--c-other';
const colorFor = (company) => `var(${varFor(company)})`;

/** Company glyph, as an <svg><use> into the sprite in index.html.
 *  The sprite id reuses the hue token's slug: `--c-openai` → `#ic-openai`.
 *  Purely decorative — the company name is always rendered next to it. */
function iconFor(company) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ic-${varFor(company).slice(4)}`);
  svg.appendChild(use);
  return svg;
}

const eraFor = (year) => {
  let label = ERAS[0][1];
  for (const [y, name] of ERAS) if (year >= y) label = name;
  return label;
};

/* --------------------------------------------------------------- URL state */

function readUrl() {
  const p = new URLSearchParams(location.search);

  const year = p.get('year');
  if (year === 'all') state.year = 'all';
  else if (year && state.years.includes(Number(year))) state.year = Number(year);
  else state.year = defaultYear();

  for (const c of (p.get('company') || '').split(',').filter(Boolean)) state.companies.add(c);
  for (const t of (p.get('tag') || '').split(',').filter(Boolean)) state.tags.add(t);

  state.query = p.get('q') || '';
  if (state.query) {
    els.search.value = state.query;
    els.searchClear.hidden = false;
  }
  if (p.get('view') === 'grid') state.view = 'grid';
  syncViewButtons();
}

function writeUrl() {
  const p = new URLSearchParams();
  if (state.year !== defaultYear()) p.set('year', String(state.year));
  if (state.companies.size) p.set('company', [...state.companies].join(','));
  if (state.tags.size) p.set('tag', [...state.tags].join(','));
  if (state.query) p.set('q', state.query);
  if (state.view !== 'lanes') p.set('view', state.view);

  const qs = p.toString();
  const hash = state.openId ? `#${encodeURIComponent(state.openId)}` : '';
  history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${hash}`);
}

/** The most recent year that actually has releases. */
function defaultYear() {
  const withData = state.years.filter((y) => state.releases.some((r) => r.year === y));
  return withData.at(-1) ?? state.years.at(-1);
}

/* ----------------------------------------------------------------- filters */

function matchesFilters(r) {
  if (state.companies.size && !state.companies.has(r.company)) return false;
  if (state.tags.size && ![...state.tags].every((t) => r.tags.includes(t))) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    const hay = `${r.model} ${r.company} ${r.tags.join(' ')} ${r.note}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Everything matching the chips/search, before the year narrows it. */
const filteredAllYears = () => state.releases.filter(matchesFilters);

/** The visible set: filters + the selected year. */
function computeVisible() {
  return filteredAllYears().filter((r) => state.year === 'all' || r.year === state.year);
}

const hasFilters = () => state.companies.size || state.tags.size || Boolean(state.query);

/* ------------------------------------------------------------------ render */

function render() {
  state.visible = computeVisible();

  const paint = () => {
    renderLanes();
    renderStats();
    renderSpark();
    renderYearCounts();
    syncChips();
  };

  // View Transitions give a free cross-fade where supported. Starting one
  // while another is mid-flight aborts the first and rejects its promises,
  // so serialise them and always handle the rejection.
  if (document.startViewTransition && !reduceMotion.matches && !transitioning) {
    transitioning = true;
    const vt = document.startViewTransition(paint);
    vt.finished.catch(() => {}).finally(() => { transitioning = false; });
    vt.ready.catch(() => {});
    vt.updateCallbackDone.catch(() => {});
  } else {
    paint();
  }

  els.resetBtn.hidden = !hasFilters();
  writeUrl();
}

function renderLanes() {
  const lanes = els.lanes;
  lanes.replaceChildren();
  lanes.dataset.view = state.view;

  const none = state.visible.length === 0;
  els.emptyState.hidden = !none;
  lanes.hidden = none;

  if (none) {
    els.emptySub.textContent = state.year === 'all'
      ? 'Nothing matches the current filters.'
      : `Nothing matches in ${state.year}. Other years may still have results.`;
    return;
  }

  if (state.view === 'grid') {
    const frag = document.createDocumentFragment();
    for (const r of state.visible) frag.appendChild(buildCard(r));
    lanes.appendChild(frag);
    return;
  }

  const years = state.year === 'all'
    ? [...new Set(state.visible.map((r) => r.year))].sort((a, b) => a - b)
    : [state.year];

  const frag = document.createDocumentFragment();
  for (const y of years) {
    if (state.year === 'all') frag.appendChild(buildYearHead(y));
    for (let m = 1; m <= 12; m++) {
      const inMonth = state.visible.filter((r) => r.year === y && r.month === m);
      // In the all-years view, empty months are noise — skip them.
      if (state.year === 'all' && !inMonth.length) continue;
      frag.appendChild(buildLane(m, inMonth));
    }
  }
  lanes.appendChild(frag);
}

function buildYearHead(year) {
  const head = document.createElement('div');
  head.className = 'lane-group-head';

  const y = document.createElement('span');
  y.className = 'lane-group-year';
  y.textContent = String(year);

  const n = state.visible.filter((r) => r.year === year).length;
  const c = document.createElement('span');
  c.className = 'lane-group-count';
  c.textContent = `${n} release${n === 1 ? '' : 's'}`;

  head.append(y, c);
  return head;
}

function buildLane(month, releases) {
  const lane = document.createElement('section');
  lane.className = 'lane';
  lane.setAttribute('aria-label', `${MONTHS[month - 1]}, ${releases.length} releases`);

  const label = document.createElement('div');
  label.className = 'lane-label';

  const abbr = document.createElement('span');
  abbr.className = 'lane-abbr';
  abbr.textContent = MONTHS[month - 1].slice(0, 3).toUpperCase();

  const name = document.createElement('span');
  name.className = 'lane-name';
  name.textContent = MONTHS[month - 1];

  const count = document.createElement('span');
  count.className = 'lane-count';
  count.textContent = String(releases.length);
  if (!releases.length) count.dataset.zero = 'true';

  label.append(abbr, name, count);

  const cards = document.createElement('div');
  cards.className = 'lane-cards';

  if (!releases.length) {
    const empty = document.createElement('p');
    empty.className = 'lane-empty';
    empty.textContent = 'no releases';
    cards.appendChild(empty);
  } else {
    for (const r of releases) cards.appendChild(buildCard(r));
  }

  lane.append(label, cards);
  return lane;
}

function buildCard(r) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  btn.style.setProperty('--c', colorFor(r.company));
  btn.dataset.id = r.id;
  btn.setAttribute('aria-label', `${r.model} by ${r.company}, ${fullDate(r)}. Open details.`);
  btn.addEventListener('click', () => openModal(r));

  const top = document.createElement('span');
  top.className = 'card-top';

  const name = document.createElement('span');
  name.className = 'card-name';
  highlight(name, r.model);

  top.append(iconFor(r.company), name);

  const company = document.createElement('span');
  company.className = 'card-company';
  highlight(company, r.company);

  const meta = document.createElement('span');
  meta.className = 'card-meta';

  const date = document.createElement('time');
  date.className = 'card-date';
  date.dateTime = isoDate(r);
  date.textContent = shortDate(r);
  meta.appendChild(date);

  for (const t of r.tags.slice(0, 3)) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = t;
    meta.appendChild(chip);
  }

  btn.append(top, company, meta);
  return btn;
}

/** Sets text on `node`, wrapping search matches in <mark>. Never uses innerHTML. */
function highlight(node, text) {
  const q = state.query.trim();
  if (!q) { node.textContent = text; return; }

  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let from = 0;
  let at = lower.indexOf(needle);

  if (at === -1) { node.textContent = text; return; }

  while (at !== -1) {
    if (at > from) node.appendChild(document.createTextNode(text.slice(from, at)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(at, at + needle.length);
    node.appendChild(mark);
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) node.appendChild(document.createTextNode(text.slice(from)));
}

/* ------------------------------------------------------------------- dates */

const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (r) => `${r.year}-${pad2(r.month)}${r.day ? `-${pad2(r.day)}` : ''}`;
const shortDate = (r) => `${MONTHS[r.month - 1].slice(0, 3)}${r.day ? ` ${r.day}` : ''}`;
const fullDate = (r) => `${MONTHS[r.month - 1]}${r.day ? ` ${r.day}` : ''}, ${r.year}`;

/* ------------------------------------------------------- stats & sparkline */

function renderStats() {
  const v = state.visible;
  const companies = new Set(v.map((r) => r.company));
  const open = v.filter((r) => r.tags.includes('open-weights')).length;
  const scope = state.year === 'all' ? 'all years' : String(state.year);

  const busiest = (() => {
    if (!v.length) return '—';
    const counts = new Map();
    for (const r of v) counts.set(r.month, (counts.get(r.month) || 0) + 1);
    const [m, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return `${MONTHS[m - 1].slice(0, 3)} · ${n}`;
  })();

  const tiles = [
    ['Releases', String(v.length), scope],
    ['Companies', String(companies.size), companies.size === 1 ? [...companies][0] : 'shipping models'],
    ['Open weights', v.length ? `${Math.round((open / v.length) * 100)}%` : '—', `${open} of ${v.length}`],
    ['Busiest month', busiest, 'by release count'],
  ];

  els.statbar.replaceChildren(...tiles.map(([label, value, sub]) => {
    const box = document.createElement('div');
    box.className = 'stat';

    const l = document.createElement('p');
    l.className = 'stat-label';
    l.textContent = label;

    const val = document.createElement('p');
    val.className = 'stat-value';
    val.textContent = value;

    const s = document.createElement('p');
    s.className = 'stat-sub';
    s.textContent = sub;

    box.append(l, val, s);
    return box;
  }));

  announce(`${v.length} release${v.length === 1 ? '' : 's'} shown for ${scope}.`);
}

/** Releases per month for the selected year — one series, so one hue. */
function renderSpark() {
  if (state.year === 'all') { els.spark.hidden = true; return; }

  const counts = Array.from({ length: 12 }, (_, i) =>
    state.visible.filter((r) => r.month === i + 1).length);
  const max = Math.max(...counts, 1);

  els.spark.hidden = false;
  els.sparkTrack.setAttribute('aria-label',
    `Releases per month in ${state.year}: ` +
    counts.map((n, i) => `${MONTHS[i].slice(0, 3)} ${n}`).join(', '));

  els.sparkTrack.replaceChildren(...counts.map((n, i) => {
    const bar = document.createElement('span');
    bar.className = 'spark-bar';
    bar.style.height = `${Math.max(2, Math.round((n / max) * 26))}px`;
    bar.title = `${MONTHS[i]}: ${n} release${n === 1 ? '' : 's'}`;
    if (n === max && n > 0) bar.dataset.hot = 'true';
    if (n === 0) bar.dataset.zero = 'true';
    return bar;
  }));
}

/* ---------------------------------------------------------------- controls */

function buildYearSelector() {
  const mk = (value, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'year-btn';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'lanes');
    b.dataset.year = String(value);
    b.setAttribute('aria-selected', 'false');

    const t = document.createElement('span');
    t.textContent = label;
    const c = document.createElement('span');
    c.className = 'yb-count';
    b.append(t, c);

    b.addEventListener('click', () => selectYear(value));
    return b;
  };

  els.yearSelector.replaceChildren(
    ...state.years.map((y) => mk(y, String(y))),
    mk('all', 'All'),
  );

  els.yearSelector.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    stepYear(e.key === 'ArrowRight' ? 1 : -1, true);
  });
}

const yearOrder = () => [...state.years, 'all'];

function stepYear(delta, focus = false) {
  const order = yearOrder();
  const i = order.indexOf(state.year);
  const next = order[(i + delta + order.length) % order.length];
  selectYear(next);
  if (focus) {
    els.yearSelector.querySelector(`[data-year="${next}"]`)?.focus();
  }
}

function selectYear(year) {
  if (state.year === year) return;
  state.year = year;
  render();
}

/** Year tabs show how many results each year holds under the current filters. */
function renderYearCounts() {
  const pool = filteredAllYears();
  for (const btn of els.yearSelector.querySelectorAll('.year-btn')) {
    const raw = btn.dataset.year;
    const value = raw === 'all' ? 'all' : Number(raw);
    const n = raw === 'all' ? pool.length : pool.filter((r) => r.year === value).length;

    btn.querySelector('.yb-count').textContent = n ? String(n) : '';
    btn.setAttribute('aria-selected', value === state.year ? 'true' : 'false');
    btn.tabIndex = value === state.year ? 0 : -1;
    btn.style.opacity = n ? '' : '0.45';
  }
}

function buildLegend() {
  const counts = new Map();
  for (const r of state.releases) counts.set(r.company, (counts.get(r.company) || 0) + 1);

  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  els.legend.replaceChildren(...sorted.map(([company, n]) => {
    const chip = mkChip(company, n, colorFor(company), iconFor(company));
    chip.addEventListener('click', () => toggleSet(state.companies, company));
    chip.dataset.company = company;
    return chip;
  }));
}

function buildTagBar() {
  const counts = new Map();
  for (const r of state.releases) for (const t of r.tags) counts.set(t, (counts.get(t) || 0) + 1);

  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  els.tagbar.replaceChildren(...sorted.map(([tag, n]) => {
    const chip = mkChip(tag, n, null);
    chip.classList.add('chip-tag');
    chip.dataset.tag = tag;
    chip.addEventListener('click', () => toggleSet(state.tags, tag));
    return chip;
  }));
}

function mkChip(label, count, color, glyph) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.setAttribute('aria-pressed', 'false');
  if (color) chip.style.setProperty('--c', color);

  // Companies get their glyph; capability chips keep the neutral diamond.
  const dot = glyph ?? document.createElement('span');
  if (!glyph) dot.className = 'chip-dot';

  const name = document.createElement('span');
  name.textContent = label;

  const n = document.createElement('span');
  n.className = 'chip-count';
  n.textContent = String(count);

  chip.append(dot, name, n);
  return chip;
}

function toggleSet(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
  render();
}

function syncChips() {
  for (const chip of els.legend.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', state.companies.has(chip.dataset.company) ? 'true' : 'false');
  }
  for (const chip of els.tagbar.querySelectorAll('.chip')) {
    chip.setAttribute('aria-pressed', state.tags.has(chip.dataset.tag) ? 'true' : 'false');
  }
}

function resetFilters() {
  state.companies.clear();
  state.tags.clear();
  state.query = '';
  els.search.value = '';
  els.searchClear.hidden = true;
  render();
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  syncViewButtons();
  render();
}

function syncViewButtons() {
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.setAttribute('aria-pressed', b.dataset.view === state.view ? 'true' : 'false');
  }
}

/* ------------------------------------------------------------------- theme */

function initTheme() {
  const saved = localStorage.getItem('llm-world-theme');
  applyTheme(saved === 'light' || saved === 'dark' ? saved : 'system');
}

function applyTheme(mode) {
  if (mode === 'system') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('llm-world-theme');
  } else {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem('llm-world-theme', mode);
  }
  els.themeToggle.dataset.themeState = mode;
  els.themeToggle.setAttribute('aria-label', `Colour theme: ${mode}`);
}

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const now = els.themeToggle.dataset.themeState || 'system';
  applyTheme(order[(order.indexOf(now) + 1) % order.length]);
}

/* ------------------------------------------------------------------ dialog */

function openModal(r) {
  state.openId = r.id;

  els.modal.style.setProperty('--c', colorFor(r.company));
  els.modalTitle.textContent = r.model;
  els.modalCompany.textContent = r.company;
  els.modalDate.textContent = fullDate(r);
  els.modalEra.textContent = eraFor(r.year);

  els.modalTags.replaceChildren(...r.tags.map((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = t;
    return chip;
  }));

  els.modalNote.replaceChildren();
  highlight(els.modalNote, r.note || 'No note recorded for this release.');

  const i = state.visible.findIndex((x) => x.id === r.id);
  els.modalPrev.disabled = i <= 0;
  els.modalNext.disabled = i === -1 || i >= state.visible.length - 1;
  els.modalCopy.textContent = 'Copy link';

  if (!els.modal.open) els.modal.showModal();
  writeUrl();
}

function stepModal(delta) {
  const i = state.visible.findIndex((x) => x.id === state.openId);
  const next = state.visible[i + delta];
  if (next) openModal(next);
}

async function copyLink() {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    els.modalCopy.textContent = 'Copied ✓';
  } catch {
    els.modalCopy.textContent = 'Press ⌘C';
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(els.modalTitle);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  setTimeout(() => { els.modalCopy.textContent = 'Copy link'; }, 1800);
}

/* ------------------------------------------------------------ data refresh */

/** How old `updated` may get before the footer flags the data as stale. */
const STALE_AFTER_DAYS = 10;
/** Don't re-check on window focus more often than this. */
const RECHECK_AFTER_MS = 6 * 60 * 60 * 1000;

let lastCheck = Date.now();
let refreshing = false;

/** Whole calendar days between `iso` (a date-only stamp) and today, so a file
 *  stamped yesterday reads "yesterday" rather than "2 days ago". */
const daysSince = (iso) => {
  const then = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const now = new Date();
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((todayUTC - then) / 86400000);
};

/** "yesterday" / "3 days ago" — falls back to the raw date if unparseable. */
function relativeDay(iso) {
  const days = daysSince(iso);
  if (days === null) return iso;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const d = days;
  if (d < 1) return 'today';
  if (d < 30) return rtf.format(-d, 'day');
  if (d < 365) return rtf.format(-Math.round(d / 30), 'month');
  return rtf.format(-Math.round(d / 365), 'year');
}

function renderStatus(note) {
  if (state.usingFallback) {
    els.dataStatus.textContent =
      'built-in sample data — serve over HTTP to load data/llm-releases.json';
    els.dataStatus.dataset.warn = 'true';
    return;
  }

  const age = state.updated ? daysSince(state.updated) : null;
  const stale = age !== null && age > STALE_AFTER_DAYS;

  let text = `${state.releases.length} releases`;
  if (state.updated) text += ` · updated ${relativeDay(state.updated)}`;
  if (stale) text += ' · source may be stale';
  if (note) text += ` · ${note}`;

  els.dataStatus.textContent = text;
  if (stale) els.dataStatus.dataset.warn = 'true';
  else delete els.dataStatus.dataset.warn;
}

/** Re-fetch the JSON and rebuild everything, keeping filters that still apply. */
async function refreshData(silent = false) {
  if (refreshing) return;
  refreshing = true;
  lastCheck = Date.now();
  els.refreshBtn.dataset.spinning = 'true';
  els.refreshBtn.disabled = true;

  const before = state.releases.length;
  const previous = new Set(state.releases.map((r) => r.id));

  await loadData();

  // Companies/tags may have appeared or vanished; drop filters that no longer exist.
  const companies = new Set(state.releases.map((r) => r.company));
  const tags = new Set(state.releases.flatMap((r) => r.tags));
  for (const c of state.companies) if (!companies.has(c)) state.companies.delete(c);
  for (const t of state.tags) if (!tags.has(t)) state.tags.delete(t);

  state.years = computeYears();
  if (state.year !== 'all' && !state.years.includes(state.year)) state.year = defaultYear();

  buildYearSelector();
  buildLegend();
  buildTagBar();
  render();

  const added = state.releases.filter((r) => !previous.has(r.id)).length;
  const delta = state.releases.length - before;

  // "no changes" describes this fetch; "source may be stale" describes the
  // file's own date. Both can be true, so keep them from reading as a
  // contradiction ("may be out of date · up to date").
  renderStatus(silent ? '' : added ? `${added} new` : 'no changes');
  if (!silent) {
    announce(added
      ? `${added} new release${added === 1 ? '' : 's'} loaded.`
      : 'Data is up to date.');
  }

  els.refreshBtn.dataset.spinning = 'false';
  els.refreshBtn.disabled = false;
  refreshing = false;
  return { added, delta };
}

/* ---------------------------------------------------------------- announce */

let announceTimer;
function announce(msg) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { els.live.textContent = msg; }, 250);
}

/* ------------------------------------------------------------------- wiring */

function wireControls() {
  // search, debounced so typing stays smooth
  let searchTimer;
  els.search.addEventListener('input', () => {
    els.searchClear.hidden = !els.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = els.search.value.trim();
      render();
    }, 130);
  });

  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.search.value) {
      e.stopPropagation();
      els.search.value = '';
      els.searchClear.hidden = true;
      state.query = '';
      render();
    }
  });

  els.searchClear.addEventListener('click', () => {
    els.search.value = '';
    els.searchClear.hidden = true;
    state.query = '';
    els.search.focus();
    render();
  });

  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => setView(b.dataset.view));
  }

  els.themeToggle.addEventListener('click', cycleTheme);
  els.refreshBtn.addEventListener('click', () => refreshData());

  // Coming back to a long-open tab is the moment stale data shows up, so
  // re-check quietly then — but no more than once every few hours.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.usingFallback || Date.now() - lastCheck < RECHECK_AFTER_MS) return;
    refreshData(true);
  });
  els.resetBtn.addEventListener('click', resetFilters);
  els.emptyAction.addEventListener('click', resetFilters);

  els.modalClose.addEventListener('click', () => els.modal.close());
  els.modalPrev.addEventListener('click', () => stepModal(-1));
  els.modalNext.addEventListener('click', () => stepModal(1));
  els.modalCopy.addEventListener('click', copyLink);

  els.helpBtn.addEventListener('click', () => els.help.showModal());
  els.helpClose.addEventListener('click', () => els.help.close());

  // <dialog> closes itself on Esc and returns focus to the invoking card on
  // its own, so this only has to drop the deep link from the URL.
  els.modal.addEventListener('close', () => {
    state.openId = null;
    writeUrl();
  });

  // click on the backdrop (outside the panel) dismisses
  for (const d of [els.modal, els.help]) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }

  els.modal.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepModal(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); stepModal(1); }
  });

  // Pasting a #release link while the page is already open changes only the
  // fragment, so no reload fires — pick it up here.
  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id || id === state.openId) return;
    const hit = state.releases.find((r) => r.id === id);
    if (hit) openModal(hit);
  });

  document.addEventListener('keydown', onGlobalKey);
}

function onGlobalKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // A release dialog owns its own arrow keys; only `?` reaches past it.
  if (els.modal.open) {
    if (e.key === '?') { e.preventDefault(); els.help.showModal(); }
    return;
  }

  if (e.key === '/' && !typing) {
    e.preventDefault();
    els.search.focus();
    els.search.select();
    return;
  }
  if (e.key === '?' && !typing) {
    e.preventDefault();
    els.help.open ? els.help.close() : els.help.showModal();
    return;
  }
  if (typing || els.modal.open || els.help.open) return;

  switch (e.key.toLowerCase()) {
    case 'arrowleft':  e.preventDefault(); stepYear(-1); break;
    case 'arrowright': e.preventDefault(); stepYear(1); break;
    case 'v': setView(state.view === 'lanes' ? 'grid' : 'lanes'); break;
    case 't': cycleTheme(); break;
    case 'a': selectYear(state.year === 'all' ? defaultYear() : 'all'); break;
    case 'r': refreshData(); break;
  }
}
