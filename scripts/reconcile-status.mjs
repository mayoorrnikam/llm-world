#!/usr/bin/env node
/**
 * Makes provenance.status agree with the evidence actually on the record.
 *
 *   node scripts/reconcile-status.mjs           report disagreements
 *   node scripts/reconcile-status.mjs --write   correct them
 *
 * THE BADGE HAS DRIFTED IN BOTH DIRECTIONS
 *
 * Overstating was caught first: seven records were badged `verified` while
 * asserting figures no primary source contained, because nothing recomputed the
 * status when a value changed. The validator now errors on that.
 *
 * Understating is the same bug pointing the other way, and it was larger. 53
 * records sat at `partially_verified` while their own reason field read "Cited
 * to the lab's own announcement, and every value it asserts was found there" —
 * which is the definition of verified, written on a record claiming it was not.
 * attribute-facts traced the values; nothing ever went back to raise the badge.
 *
 * Under-claiming is not the safe direction. A dataset whose whole proposition
 * is calibrated provenance is wrong when it says "partly evidenced" about a
 * fully evidenced record, and a reader who checks and finds the badge too
 * modest learns the badge means nothing — the same lesson as finding it too
 * generous.
 *
 * WHAT IT WILL NOT DO
 *
 * Only `partially_verified` → `verified`, and only when EVERY value the record
 * asserts is traced to a source whose authority is primary. Tracing to a
 * secondary source does not count, however complete: METHODOLOGY §5 lets a
 * secondary corroborate a date and never back a value. Nothing is downgraded
 * here — the validator already errors on an overstated badge, which is a
 * failure to fix rather than a status to quietly rewrite.
 */

import { readFileSync } from 'node:fs';
import { saveDataset } from '../lib/dataset.mjs';
import { EVIDENCED_FIELDS, assertedValue } from '../lib/record.mjs';

const WRITE = process.argv.includes('--write');
const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));

/**
 * Every asserted field traced to a PRIMARY source, or the reason it is not.
 *
 * The authority check is the point. A value can be traced to a source that
 * merely reports it, and that is exactly what partially_verified describes.
 */
function assess(r) {
  const byId = new Map(r.sources.map((s) => [s.id, s]));
  const gaps = [];
  let traced = 0;

  for (const f of EVIDENCED_FIELDS) {
    const v = assertedValue(r, f);
    if (v == null) continue;
    const backing = (r.evidence?.[f] ?? [])
      .filter((e) => String(e.value) === String(v))
      .flatMap((e) => e.sources ?? [])
      .map((sid) => byId.get(sid))
      .filter(Boolean);
    if (!backing.length) { gaps.push(`${f} untraced`); continue; }
    if (!backing.some((s) => s.authority === 'primary')) {
      gaps.push(`${f} traced only to ${[...new Set(backing.map((s) => s.authority))].join('/')}`);
      continue;
    }
    traced++;
  }
  return { gaps, traced };
}

const candidates = data.releases.filter((r) => r.provenance?.status === 'partially_verified');
console.log(`${candidates.length} partially_verified records\n`);

const upgrade = [], keep = [];
for (const r of candidates) {
  const { gaps, traced } = assess(r);
  if (gaps.length || !traced) { keep.push({ r, gaps }); continue; }
  upgrade.push({ r, traced });
}

for (const { r, traced } of upgrade.slice(0, 20)) {
  console.log(`  ↑ ${r.id.padEnd(24)} ${traced} field${traced === 1 ? '' : 's'} primary-traced`
    + `  (confidence ${r.provenance.confidence})`);
}
if (upgrade.length > 20) console.log(`  … and ${upgrade.length - 20} more`);

const why = {};
for (const { gaps } of keep) for (const g of gaps) why[g.replace(/^\w+ /, (m) => m)] = (why[g] ?? 0) + 1;
console.log(`\nstaying partially_verified: ${keep.length}`);
for (const [g, n] of Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`   ${String(n).padStart(3)}  ${g}`);
}

if (WRITE && upgrade.length) {
  for (const { r } of upgrade) {
    r.provenance.status = 'verified';
    // Verified records sit in the 90–100 band. A record whose every value is
    // traced to the lab's own words belongs at the floor of that band, not
    // below it — the old number was set before the tracing existed.
    if ((r.provenance.confidence ?? 0) < 90) r.provenance.confidence = 90;
  }
  saveDataset(data);
  console.log(`\nupgraded ${upgrade.length} records`);
} else if (!WRITE) {
  console.log(`\n${upgrade.length} would be upgraded — dry run, pass --write`);
}
