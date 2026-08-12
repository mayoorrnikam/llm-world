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

import { parse, run, answer } from './lib/query.mjs';
import { canonicalDate, contextWindow, parameterCount, displayTags, logoSlug, monogram } from './lib/record.mjs';

const DATA_URL = new URL('data/llm-releases.json', import.meta.url);
const SPRITE_URL = new URL('sprite.svg', import.meta.url);

const logoFor = (company) => {
  const slug = logoSlug(company);
  // Framed mark, same contract as the timeline and the static pages: hue on
  // the container, initials when there is no logo.
  if (slug === 'other') {
    const box = document.createElement('span');
    box.className = 'ask-mark mark-mono';
    box.style.setProperty('--c', 'var(--c-other)');
    box.setAttribute('aria-hidden', 'true');
    box.textContent = monogram(company);
    return box;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ic-${slug}`);
  svg.appendChild(use);

  const box = document.createElement('span');
  box.className = 'ask-mark';
  box.style.setProperty('--c', `var(--c-${slug})`);
  box.setAttribute('aria-hidden', 'true');
  box.appendChild(svg);
  return box;
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

  // A direct answer, when the question has one. It is computed from the same
  // matched set rendered below, so the headline and the list cannot disagree,
  // and it names the record it came from.
  const a = answer(found, { raw: q, terms: parsed.terms });
  if (a) {
    const box = document.createElement('div');
    box.className = 'ask-answer';
    const line = document.createElement('p');
    line.className = 'ask-answer-text';
    if (a.record) {
      const link = document.createElement('a');
      link.href = `models/${a.record.id}/`;
      link.textContent = a.text;
      line.append(link);
    } else {
      line.textContent = a.text;
    }
    box.append(line);
    if (a.detail) {
      const d = document.createElement('p');
      d.className = 'ask-answer-detail';
      d.textContent = a.detail;
      box.append(d);
    }
    results.append(box);
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
  // Below about a screenful there is nothing to scroll, and a capped box with
  // a fade over four results looks like a bug.
  if (found.length <= 6) list.classList.add('is-short');
  // A scrollable region has to be reachable by keyboard.
  else { list.tabIndex = 0; list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Results'); }
  // A new question starts at the top of its answers. Without this the browser
  // keeps the previous scroll offset and the first result renders half cut off.
  requestAnimationFrame(() => { list.scrollTop = 0; });

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
/**
 * The footer's "Browse by year" column, which was empty on this page alone.
 *
 * scripts/build.mjs fills it when it generates a page and app.js has it on the
 * timeline, but the landing page is neither — it is a hand-written file served
 * as-is, so the column rendered as a heading with nothing under it. The links
 * are worth having and the heading is already there; it just needed the one
 * renderer that was missing.
 */
function renderYearLinks() {
  const host = el('foot-yearlinks');
  if (!host || !records.length) return;
  const years = [...new Set(records.map((r) => Number(String(canonicalDate(r)).slice(0, 4))))]
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => b - a);
  host.replaceChildren(...years.map((y) => {
    const a = document.createElement('a');
    a.href = `timeline/${y}/`;
    a.textContent = String(y);
    return a;
  }));
}

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

  // A pool rather than a fixed five, shuffled on load.
  //
  // Rotating on a timer was the other option and it is worse here: this sits
  // directly under a field someone is about to type into, and text that moves
  // while you are reading it is a distraction, not life. Shuffling per visit
  // makes the page feel current without anything shifting under the cursor.
  const labs = new Set(records.map((r) => r.company));
  const archived = records.flatMap((r) => r.sources ?? []);
  const withArchive = archived.filter((s) => s.archived_url).length;
  const verified = records.filter((r) => r.provenance?.status === 'verified').length;
  const priced = records.filter((r) => r.pricing?.length);
  const cheapest = priced.length
    ? priced.reduce((a, r) => (r.pricing[0].rates.input < a.pricing[0].rates.input ? r : a))
    : null;
  const biggest = records.reduce((a, r) =>
    (parameterCount(r) ?? 0) > (parameterCount(a) ?? 0) ? r : a, records[0]);
  const busiest = [...labs].map((c) => ({ c, n: records.filter((r) => r.company === c).length }))
    .sort((a, b) => b.n - a.n)[0];
  const undisclosedParams = records.filter((r) => r.undisclosed?.includes('parameter_count')).length;

  const pool = [
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
    { k: 'Sources archived', v: `${Math.round(withArchive / Math.max(1, archived.length) * 100)}%`,
      s: `${withArchive} of ${archived.length} citations are dated snapshots`, href: 'methodology/' },
    { k: 'Records fully verified', v: String(verified),
      s: `of ${records.length} — the rest say why not`, href: 'data-quality/' },
    { k: 'Labs tracked', v: String(labs.size),
      s: `${busiest.c} has the most, at ${busiest.n}`, href: 'companies/' },
    { k: 'Largest disclosed model', v: biggest && parameterCount(biggest)
      ? `${Math.round(parameterCount(biggest) / 1e9)}B` : '—',
      s: biggest?.model ?? '', href: biggest ? `models/${encodeURIComponent(biggest.id)}/` : 'models/' },
    { k: 'Labs that publish no parameter count', v: String(undisclosedParams),
      s: 'recorded as undisclosed, not guessed', href: 'data-quality/' },
    cheapest && { k: 'Cheapest published price', v: `$${cheapest.pricing[0].rates.input}`,
      s: `${cheapest.model} · per million input tokens`, href: 'analytics/pricing/' },
  ].filter(Boolean);

  // Keep the latest release first — it is the one thing a returning visitor
  // came to check — and shuffle the rest.
  const rest = pool.slice(1);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const cards = [pool[0], ...rest.slice(0, 4)];

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
  syncControls();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  submit(input.value);
});

/**
 * The right-hand slot holds exactly one control: the keyboard hint when the
 * field is empty, the clear button as soon as there is something to clear.
 * Two affordances in one slot would either overlap or make the field wider
 * than it needs to be, and a clear button with nothing to clear is a dead
 * control the eye still has to skip.
 */
const clearBtn = el('ask-clear');
const keyHint = el('ask-key');

function syncControls() {
  const has = input.value.length > 0;
  if (clearBtn) clearBtn.hidden = !has;
  if (keyHint) keyHint.hidden = has;
}

clearBtn?.addEventListener('click', () => {
  input.value = '';
  syncControls();
  submit('');
  input.focus();
});

// Answer as you type once the question is long enough to mean something.
let timer;
input.addEventListener('input', () => {
  syncControls();
  clearTimeout(timer);
  timer = setTimeout(() => { if (input.value.trim().length >= 3) submit(input.value); }, 220);
});

// Escape clears from the keyboard, matching the button beside it.
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && input.value) {
    e.preventDefault();
    input.value = '';
    syncControls();
    submit('');
  }
});

// "/" focuses the field, which is what the hint in that slot promises.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  input.focus();
  input.select();
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
renderYearLinks();
const initial = new URLSearchParams(location.search).get('q');
if (initial) submit(initial, { push: false });
// After the initial query lands, so a shared link arrives with its clear
// control already showing rather than a keyboard hint over a full field.
syncControls();
input.focus();
