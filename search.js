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
  const res = await fetch(DATA_URL, { cache: 'no-store' });
  const json = await res.json();
  records = json.releases ?? [];
  vocab = {
    companies: [...new Set(records.map((r) => r.company))],
    families: [...new Set(records.map((r) => r.family))],
  };
}

/** Newest first — a question about models almost always means recent ones. */
const byDateDesc = (a, b) => String(canonicalDate(b)).localeCompare(String(canonicalDate(a)));

function render(q) {
  results.replaceChildren();
  reading.hidden = true;

  if (!q.trim()) return;

  const parsed = parse(q, vocab);
  const found = run(records, parsed).sort(byDateDesc);

  // Say how the question was read, including anything left as plain text.
  const bits = parsed.terms.map((t) => t.label);
  if (parsed.free) bits.push(`text “${parsed.free}”`);
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

  const head = document.createElement('p');
  head.className = 'ask-count';
  head.textContent = found.length === 1
    ? '1 record matches'
    : `${found.length} records match`;
  results.append(head);

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
    a.textContent = r.model;

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

await load();
const initial = new URLSearchParams(location.search).get('q');
if (initial) submit(initial, { push: false });
input.focus();
