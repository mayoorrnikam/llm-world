#!/usr/bin/env node
/**
 * Data quality gate for data/llm-releases.json.
 *
 * Runs in CI on every push, so the kinds of defects found by hand during the
 * sourcing pass — a fabricated date, a duplicate id, a release with no source —
 * fail the build instead of reaching the published site.
 *
 *   node scripts/validate-data.mjs            check
 *   node scripts/validate-data.mjs --links    also verify every source URL resolves
 *
 * Exits non-zero if any error-level rule fails. Warnings never fail the build.
 */

import { readFileSync } from 'node:fs';

const FILE = 'data/llm-releases.json';
const CHECK_LINKS = process.argv.includes('--links');

const errors = [];
const warnings = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

const VALID_STATUS = new Set(['verified', 'partially_verified', 'unverified', 'conflicting', 'estimated']);
const VALID_KIND = new Set(['model', 'product', 'milestone']);
const VALID_SOURCE_TYPE = new Set([
  'official_announcement', 'paper', 'repository', 'model_card', 'documentation', 'secondary',
]);

let data;
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`FATAL: cannot parse ${FILE} — ${e.message}`);
  process.exit(1);
}

const releases = data.releases ?? [];
if (!releases.length) {
  console.error('FATAL: no releases in dataset');
  process.exit(1);
}

/* ------------------------------------------------------------ file level */

if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updated ?? '')) {
  err('<file>', `"updated" must be YYYY-MM-DD, got ${JSON.stringify(data.updated)}`);
}

const seenIds = new Map();
const seenNameDate = new Map();
// Compare against the end of today in UTC so a release published today passes.
const today = new Date();
const endOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59);

/* --------------------------------------------------------- release level */

for (const r of releases) {
  const id = r.id || `<missing id: ${r.model ?? '?'}>`;

  if (!r.id) err(id, 'missing id');
  else if (seenIds.has(r.id)) err(id, `duplicate id (also used by "${seenIds.get(r.id)}")`);
  else seenIds.set(r.id, r.model);

  if (!r.model?.trim()) err(id, 'missing model name');
  if (!r.company?.trim()) err(id, 'missing company');

  // dates
  const { year, month, day } = r;
  if (!Number.isInteger(year) || year < 2015 || year > 2100) err(id, `implausible year ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) err(id, `month out of range: ${month}`);
  if (day != null && (!Number.isInteger(day) || day < 0 || day > 31)) err(id, `day out of range: ${day}`);

  if (Number.isInteger(year) && Number.isInteger(month)) {
    const stamp = Date.UTC(year, month - 1, day || 1);
    // A real calendar date: Feb 30 would silently roll over to March otherwise.
    if (day) {
      const back = new Date(stamp);
      if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
        err(id, `not a real date: ${year}-${month}-${day}`);
      }
    }
    if (stamp > endOfToday && r.provenance?.status !== 'estimated') {
      err(id, `release date is in the future — mark provenance.status "estimated" if intended`);
    }
    const key = `${r.model?.toLowerCase()}|${year}-${month}`;
    if (seenNameDate.has(key)) warn(id, `same model name and month as "${seenNameDate.get(key)}"`);
    else seenNameDate.set(key, r.id);
  }

  // provenance — every release must be traceable (§7)
  if (!Array.isArray(r.sources) || r.sources.length === 0) {
    err(id, 'no sources — every release must cite at least one');
  } else {
    for (const s of r.sources) {
      if (!/^https?:\/\//.test(s.url ?? '')) err(id, `source url must be http(s): ${s.url}`);
      if (!VALID_SOURCE_TYPE.has(s.type)) err(id, `unknown source type "${s.type}"`);
    }
  }

  const p = r.provenance;
  if (!p) err(id, 'missing provenance block');
  else {
    if (!VALID_STATUS.has(p.status)) err(id, `unknown provenance.status "${p.status}"`);
    if (!Number.isInteger(p.confidence) || p.confidence < 0 || p.confidence > 100) {
      err(id, `confidence must be 0-100, got ${p.confidence}`);
    }
    if (p.status === 'verified' && !r.sources?.some((s) => s.type !== 'secondary')) {
      err(id, 'marked verified but has no primary source');
    }
  }

  if (!VALID_KIND.has(r.kind)) err(id, `unknown kind "${r.kind}"`);
  if (!r.family?.trim()) err(id, 'missing family');

  // Numeric fields are null until researched — never a guess, never a string (§7).
  for (const f of ['context_window', 'parameter_count']) {
    const v = r.technical?.[f];
    if (v != null && (typeof v !== 'number' || v <= 0)) err(id, `technical.${f} must be a positive number or null`);
  }
  if (typeof r.access?.open_weights !== 'boolean') err(id, 'access.open_weights must be true or false');

  // Cross-check the two places open-weights status is recorded.
  if (r.access?.open_weights !== r.tags?.includes('open-weights')) {
    err(id, 'access.open_weights disagrees with the open-weights tag');
  }
}

/* ------------------------------------------------------------ link check */

if (CHECK_LINKS) {
  const urls = [...new Set(releases.flatMap((r) => (r.sources ?? []).map((s) => s.url)))];
  process.stdout.write(`checking ${urls.length} source URLs…\n`);
  const results = await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetch(u, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world link-check)' },
      });
      return [u, res.status];
    } catch {
      return [u, 0];
    }
  }));
  for (const [u, status] of results) {
    // 401/403/405 mean the host blocks bots, not that the page is gone.
    if (status === 0 || status === 404 || status === 410) {
      warn('<links>', `unreachable (${status || 'network error'}): ${u}`);
    }
  }
}

/* ---------------------------------------------------------------- report */

const stats = {
  releases: releases.length,
  companies: new Set(releases.map((r) => r.company)).size,
  families: new Set(releases.map((r) => r.family)).size,
  verified: releases.filter((r) => r.provenance?.status === 'verified').length,
};
console.log(
  `${stats.releases} releases · ${stats.companies} companies · ${stats.families} families · ` +
  `${stats.verified} verified`,
);

for (const w of warnings) console.log(`  WARN  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);

if (errors.length) {
  console.error(`\nFAILED — ${errors.length} error${errors.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`\nOK${warnings.length ? ` — ${warnings.length} warning(s)` : ''}`);
