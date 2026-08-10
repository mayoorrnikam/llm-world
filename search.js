/* ==========================================================================
   LLM WORLD — the landing page: ask the dataset a question.

   The timeline is a tool, and tools make poor front doors. This page asks one
   question instead, parses the answer into dataset filters (lib/query.mjs) and
   answers from the records themselves.

   No language model is involved. That is the point: every row shown is a
   record, and every record links to the sources behind its figures. An answer
   you can click through to a primary document is worth more here than one that
   reads fluently.

   All state lives in the URL (?q=), so any answer is linkable.
   ========================================================================== */

import { parse, run } from './lib/query.mjs';
import { canonicalDate, contextWindow, parameterCount, displayTags } from './lib/record.mjs';

const DATA_URL = new URL('data/llm-releases.json', import.meta.url);
const SPRITE_URL = new URL('sprite.svg', import.meta.url);

/** Company → logo slug. Identity rests on the mark and the name together, so
 *  results carry the logo the rest of the site uses (CLAUDE.md, design). */
const LOGO = {
  'AI21 Labs': 'ai21', Anthropic: 'anthropic', 'Mistral AI': 'mistral',
  'Alibaba Qwen': 'alibaba', Amazon: 'amazon', NVIDIA: 'nvidia',
  BigScience: 'bigscience', OpenAI: 'openai', Microsoft: 'microsoft', xAI: 'xai',
  'Google DeepMind': 'google', DeepSeek: 'deepseek', 'Meta AI': 'meta',
  'Moonshot AI': 'moonshot', 'Zhipu AI': 'zhipu', Cohere: 'cohere',
};
const logoFor = (company) => {
  const slug = LOGO[company] ?? 'other';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.setProperty('--c', `var(--c-${slug})`);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ic-${slug}`);
  svg.appendChild(use);
  return svg;
};

/* The theme button is part of the shared header, so it exists on this page —
   but its click handler lived in app.js, which the landing page does not load.
   The button rendered and did nothing. */
function initTheme() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const order = ['system', 'light', 'dark'];
  let now = localStorage.getItem('llm-world-theme');
  now = (now === 'light' || now === 'dark') ? now : 'system';
  const set = (mode) => {
    if (mode === 'system') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('llm-world-theme');
    } else {
      document.documentElement.dataset.theme = mode;
      localStorage.setItem('llm-world-theme', mode);
    }
    btn.dataset.themeState = mode;
    btn.setAttribute('aria-label', `Colour theme: ${mode}`);
    now = mode;
  };
  set(now);
  btn.addEventListener('click', () => set(order[(order.indexOf(now) + 1) % 3]));
}

const el = (id) => document.getElementById(id);
const form = el('ask-form');
const input = el('ask-input');
const reading = el('ask-reading');
const results = el('ask-results');

let records = [];
let vocab = { companies: [], families: [] };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]}${d ? ` ${d}` : ''}, ${y}`;
};
const tokens = (n) => n == null ? null
  : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M context` : `${Math.round(n / 1000)}K context`;
const params = (n) => n == null ? null
  : n >= 1e12 ? `${+(n / 1e12).toFixed(2)}T params`
  : n >= 1e9 ? `${+(n / 1e9).toFixed(n < 1e10 ? 1 : 0)}B params`
  : `${Math.round(n / 1e6)}M params`;

async function load() {
  // The logo sprite lives in one file; inline it so <use> can reach it.
  fetch(SPRITE_URL).then((r) => r.ok && r.text()).then((svg) => {
    if (!svg) return;
    const holder = document.createElement('div');
    holder.hidden = true;
    holder.innerHTML = svg;
    document.body.prepend(holder);
  }).catch(() => { /* results still read fine without logos */ });

  const res = await fetch(DATA_URL, { cache: 'no-store' });
  const json = await res.json();
  records = json.releases ?? [];
  vocab = {
    companies: [...new Set(records.map((r) => r.company))],
    families: [...new Set(records.map((r) => r.family))],
  };
}

function render(q) {
  results.replaceChildren();
  reading.hidden = true;

  const pulse = el('ask-pulse');
  if (pulse) pulse.hidden = Boolean(q.trim());

  if (!q.trim()) return;

  const parsed = parse(q, vocab);
  // run() ranks by name match and breaks ties by date, so no re-sort here.
  const { results: found, ignored, used } = run(records, parsed);

  // Say how the question was read, including anything left as plain text.
  const bits = parsed.terms.map((t) => t.label);
  // Only the words that actually narrowed anything; ignored ones are listed
  // separately rather than shown twice.
  if (used) bits.push(`text “${used}”`);
  reading.hidden = false;
  reading.replaceChildren();
  reading.append(`Read as: `);
  bits.forEach((b, i) => {
    if (i) reading.append(' + ');
    const chip = document.createElement('span');
    chip.className = 'read-chip';
    chip.textContent = b;
    reading.append(chip);
  });
  if (!bits.length) reading.append('everything');
  if (ignored.length) {
    const ig = document.createElement('span');
    ig.className = 'read-ignored';
    ig.textContent = ` · ignored ${ignored.map((w) => `“${w}”`).join(', ')}`;
    reading.append(ig);
  }

  const head = document.createElement('p');
  head.className = 'ask-count';
  head.textContent = found.length === 1
    ? `1 of ${records.length} records matches`
    : `${found.length} of ${records.length} records match`;
  results.append(head);

  // A capability filter returning almost nothing usually means the capability
  // is barely recorded, not that few models have it. Capabilities are only
  // written where a source states them, so say that rather than let a sparse
  // result read as a broken search.
  for (const t of parsed.terms.filter((x) => x.kind === 'capability')) {
    const recorded = records.filter((r) => r.capabilities?.includes(t.value)).length;
    if (recorded > records.length * 0.15) continue;
    const note = document.createElement('p');
    note.className = 'ask-none';
    note.append(`“${t.label}” is evidenced on only ${recorded} of ${records.length} records. `
      + 'Capabilities are recorded only where a primary source states them, so this is a gap '
      + 'in the dataset rather than in the models — ');
    const a = document.createElement('a');
    a.href = new URL('data-quality/', import.meta.url).pathname;
    a.textContent = 'see data quality';
    note.append(a, '.');
    results.append(note);
  }

  if (!found.length) {
    const none = document.createElement('p');
    none.className = 'ask-none';
    none.textContent = 'Nothing in the dataset matches all of those. '
      + 'Try removing a term — the reading above shows how the question was understood.';
    results.append(none);
    return;
  }

  const list = document.createElement('ol');
  list.className = 'ask-list';

  for (const r of found.slice(0, 40)) {
    const li = document.createElement('li');

    const a = document.createElement('a');
    a.className = 'ask-name';
    a.href = new URL(`models/${encodeURIComponent(r.id)}/`, import.meta.url).pathname;
    a.append(logoFor(r.company), document.createTextNode(r.model));

    const meta = document.createElement('span');
    meta.className = 'ask-meta';
    meta.textContent = `${r.company} · ${fmtDate(canonicalDate(r))}`;

    const facts = document.createElement('span');
    facts.className = 'ask-facts';
    const parts = [
      tokens(contextWindow(r)),
      params(parameterCount(r)),
      r.access?.open_weights ? 'open weights' : null,
      r.pricing?.[0]?.rates?.input != null ? `$${r.pricing[0].rates.input}/M in` : null,
    ].filter(Boolean);
    facts.textContent = parts.join(' · ');

    const chips = document.createElement('span');
    chips.className = 'ask-chips';
    for (const t of displayTags(r).slice(0, 4)) {
      const c = document.createElement('span');
      c.className = 'tag';
      c.textContent = t.replace(/_/g, ' ');
      chips.append(c);
    }

    li.append(a, meta, facts, chips);
    list.append(li);
  }

  results.append(list);

  if (found.length > 40) {
    const more = document.createElement('p');
    more.className = 'ask-none';
    more.textContent = `Showing the 40 most recent of ${found.length}.`;
    results.append(more);
  }
}

/**
 * What the dataset currently shows, before any question is asked.
 *
 * Every figure is computed from the records — no hand-written trivia that would
 * drift out of date the next time a release lands.
 */
function renderPulse() {
  const host = el('ask-pulse');
  if (!host || !records.length) return;

  const dated = records.filter((r) => canonicalDate(r));
  const byDate = [...dated].sort((a, b) =>
    String(canonicalDate(b)).localeCompare(String(canonicalDate(a))));
  const latest = byDate[0];

  const days = (iso) => Math.round((Date.now() - Date.parse(iso)) / 86400000);
  const last90 = dated.filter((r) => days(canonicalDate(r)) <= 90).length;
  const thisYear = new Date().getUTCFullYear();
  const inYear = dated.filter((r) => canonicalDate(r).startsWith(String(thisYear))).length;

  const open = records.filter((r) => r.access?.open_weights).length;
  const widest = records.reduce((a, r) =>
    (contextWindow(r) ?? 0) > (contextWindow(a) ?? 0) ? r : a, records[0]);

  // Median gap between consecutive releases across the whole dataset.
  const stamps = byDate.map((r) => Date.parse(canonicalDate(r))).sort((a, b) => a - b);
  const gaps = stamps.slice(1).map((t, i) => Math.round((t - stamps[i]) / 86400000))
    .sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

  const cards = [
    { k: 'Latest release', v: latest.model,
      s: `${latest.company} · ${fmtDate(canonicalDate(latest))}`,
      href: `models/${encodeURIComponent(latest.id)}/` },
    { k: 'Released in the last 90 days', v: String(last90),
      s: `${inYear} so far in ${thisYear}`, href: 'latest/' },
    { k: 'Widest context tracked', v: tokens(contextWindow(widest)).replace(' context', ''),
      s: widest.model, href: `models/${encodeURIComponent(widest.id)}/` },
    { k: 'Open weights', v: `${Math.round(open / records.length * 100)}%`,
      s: `${open} of ${records.length} releases`, href: 'analytics/' },
    { k: 'Typical gap between releases', v: median != null ? `${median} days` : '—',
      s: 'median across all tracked labs', href: 'analytics/' },
  ];

  const wrap = document.createElement('div');
  wrap.className = 'pulse-grid';
  for (const c of cards) {
    const a = document.createElement('a');
    a.className = 'pulse-card';
    a.href = new URL(c.href, import.meta.url).pathname;
    const k = document.createElement('span'); k.className = 'pulse-k'; k.textContent = c.k;
    const v = document.createElement('span'); v.className = 'pulse-v'; v.textContent = c.v;
    const sub = document.createElement('span'); sub.className = 'pulse-s'; sub.textContent = c.s;
    a.append(k, v, sub);
    wrap.append(a);
  }
  host.replaceChildren(wrap);
}

function submit(q, { push = true } = {}) {
  input.value = q;
  render(q);
  const url = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : location.pathname;
  if (push) history.replaceState(null, '', url);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(input.value);
});

// Answer as you type once the question is long enough to mean something.
let timer;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => { if (input.value.trim().length >= 3) submit(input.value); }, 220);
});

el('ask-examples').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-q]');
  if (!btn) return;
  submit(btn.dataset.q);
  input.focus();
});

initTheme();
await load();
renderPulse();
const initial = new URLSearchParams(location.search).get('q');
if (initial) submit(initial, { push: false });
input.focus();
