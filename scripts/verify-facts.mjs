#!/usr/bin/env node
/**
 * Checks recorded values against the primary sources that are supposed to
 * evidence them.
 *
 *   node scripts/verify-facts.mjs                  every record
 *   node scripts/verify-facts.mjs --ids=gpt-4o     just these
 *   node scripts/verify-facts.mjs --out=report.md  write the report
 *
 * For each record it reads the ARCHIVED primary sources and asks a narrow,
 * mechanical question: does the source text actually contain the value we
 * claim? Dates, context windows and parameter counts are all checked in the
 * several forms a lab might write them ("128,000", "128K", "128k context").
 *
 * WHAT THIS IS NOT: it is not a judgement that a record is correct. A number
 * appearing on a page is evidence, not proof — the page might be describing a
 * different model in a family, or a later revision. It narrows human review to
 * the records where a claimed value cannot be found at all, which are the ones
 * actually worth a person's time.
 *
 * It never edits the dataset. Promotion to `verified` stays a human decision
 * (docs/METHODOLOGY.md §9).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalDate, contextWindow, parameterCount } from '../lib/record.mjs';
// The project's one date vocabulary — shared with attribute-facts.mjs, which
// asks the same question of the same pages, and with draft-from-url.mjs, which
// reads dates out of them.
import { dateForms } from '../lib/dates.mjs';

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const IDS = arg('ids')?.split(',').filter(Boolean);
const OUT = arg('out');
const CONCURRENCY = Number(arg('jobs') ?? 5);

/** Every plausible way a lab might write this token count. */
function tokenForms(n) {
  const forms = [String(n), n.toLocaleString('en-US')];
  if (n % 1000 === 0) {
    const k = n / 1000;
    forms.push(`${k}K`, `${k}k`, `${k},000`);
  }
  if (n % 1_000_000 === 0) {
    const m = n / 1_000_000;
    forms.push(`${m}M`, `${m}m`, `${m} million`);
  }
  if (n === 1_048_576) forms.push('1M', '1m', '1 million', '1,048,576');
  return [...new Set(forms)];
}

/** Every plausible way a lab might write this parameter count. */
function paramForms(n) {
  const forms = [String(n), n.toLocaleString('en-US')];
  if (n >= 1e12) {
    const t = +(n / 1e12).toFixed(2);
    forms.push(`${t}T`, `${t} trillion`, `${Math.round(n / 1e9)}B`, `${Math.round(n / 1e9)} billion`);
  } else if (n >= 1e9) {
    const b = +(n / 1e9).toFixed(n < 1e10 ? 1 : 0);
    forms.push(`${b}B`, `${b}b`, `${b} billion`, `${b}-billion`);
  }
  return [...new Set(forms)];
}

// `loose` keeps the yearless "August 14" this script has always accepted. It is
// right here and wrong in attribute-facts.mjs: this narrows human review to the
// records where a value cannot be found AT ALL, so a weak hit costing a person
// nothing is better than a miss costing them a page read; attribution records
// which source states a fact, and "May 13" appears on pages about other years.
function formsForDate(iso) {
  return dateForms(iso, { loose: true });
}

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world verify)' },
    });
    if (!res.ok) return null;
    return textOf(await res.text());
  } catch {
    return null;
  }
}

const targets = IDS ? data.releases.filter((r) => IDS.includes(r.id)) : data.releases;

const rows = [];
let done = 0;

async function check(r) {
  const archived = r.sources.filter((s) => s.archived_url && s.authority === 'primary');
  const corpus = [];
  for (const s of archived) {
    const t = await fetchText(s.archived_url);
    if (t) corpus.push({ id: s.id, text: t });
  }

  const findIn = (forms) => {
    for (const c of corpus) {
      const hit = forms.find((f) => c.text.includes(f));
      if (hit) return { source: c.id, form: hit };
    }
    return null;
  };

  const date = canonicalDate(r);
  const ctx = contextWindow(r);
  const par = parameterCount(r);

  const result = {
    id: r.id,
    model: r.model,
    status: r.provenance.status,
    readable: corpus.length,
    sources: archived.length,
    date: date ? findIn(formsForDate(date)) : null,
    context: ctx != null ? findIn(tokenForms(ctx)) : 'n/a',
    params: par != null ? findIn(paramForms(par)) : 'n/a',
  };

  done++;
  process.stderr.write(`  ${done}/${targets.length} ${r.id}\n`);
  return result;
}

const queue = [...targets];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
  while (queue.length) rows.push(await check(queue.shift()));
}));

rows.sort((a, b) => targets.findIndex((t) => t.id === a.id) - targets.findIndex((t) => t.id === b.id));

const mark = (v) => v === 'n/a' ? '–' : v ? `found (${v.form})` : '**NOT FOUND**';
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };

say(`# Fact check against primary sources`);
say();
say(`${rows.length} records · generated ${new Date().toISOString().slice(0, 10)}`);
say();
say(`"found" means the recorded value appears verbatim in an archived primary`);
say(`source. That is evidence, not proof — see the header of this script.`);
say();
say(`| record | status | sources read | date | context | parameters |`);
say(`|---|---|---|---|---|---|`);
for (const r of rows) {
  say(`| \`${r.id}\` | ${r.status} | ${r.readable}/${r.sources} | ${mark(r.date)} | ${mark(r.context)} | ${mark(r.params)} |`);
}

const unreadable = rows.filter((r) => r.readable === 0);
const dateMissing = rows.filter((r) => r.readable > 0 && r.date === null);
const clean = rows.filter((r) => r.readable > 0 && r.date
  && r.context !== null && r.params !== null);

say();
say(`## Summary`);
say();
say(`- **${clean.length}** records had every recorded value found in a primary source`);
say(`- **${dateMissing.length}** could not have their date confirmed from the source text`);
say(`- **${unreadable.length}** had no readable archived primary source`);
say();
if (dateMissing.length) {
  say(`### Date not found — review these first`);
  for (const r of dateMissing) say(`- \`${r.id}\` (${r.model})`);
  say();
}
if (unreadable.length) {
  say(`### No readable source`);
  for (const r of unreadable) say(`- \`${r.id}\` (${r.model})`);
}

if (OUT) {
  writeFileSync(OUT, lines.join('\n') + '\n');
  process.stderr.write(`\nwrote ${OUT}\n`);
}
