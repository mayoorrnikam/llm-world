/**
 * The half of a docs reader that every lab shares.
 *
 * Four labs publish machine-readable specifications, and reading them turned
 * into four scripts with the same skeleton and one genuinely different organ:
 *
 *   resolve which page describes which record   ← shared
 *   fetch it                                    ← shared
 *   PARSE IT                                    ← never shared
 *   fill only fields the record lacks           ← shared
 *   report models the lab serves and we lack    ← shared
 *
 * WHY THE PARSER IS NOT SHARED, AND MUST NOT BE
 *
 * Each lab states the same facts in a different shape, and the differences are
 * precisely where a wrong number comes from:
 *
 *   xAI        a markdown pricing table — split on a pipe
 *   OpenAI     markdown bullets, where the HTML twin would have handed over
 *              128,000 as GPT-5.6 Sol's context window instead of 1,050,000
 *   Anthropic  a TRANSPOSED table: model names in the header row, one feature
 *              per row after it
 *   Google     prose blocks, plus a separate name→endpoint mapping
 *
 * A generic parser over those four is how you produce a confident wrong figure.
 * Each lab gets ~40 lines that understand its page, and everything around them
 * lives here once.
 *
 * TWO RULES THIS ENFORCES FOR EVERY LAB
 *
 * 1. FILL ONLY WHAT IS EMPTY. These pages describe what a lab serves TODAY, and
 *    a record describes a release. GPT-5.6 Sol's context window may well differ
 *    from the day it shipped. A figure already traced to a source outranks a
 *    scrape, always — otherwise enrichment quietly rewrites history.
 *
 * 2. REPORT, NEVER ADD. A docs page proves a model is served, not when it was
 *    released, and a record needs a date from the lab's own announcement.
 */

/** Compare names across punctuation, spacing and case. */
export const flat = (s) => String(s).toLowerCase().replace(/[\s._-]/g, '');

const UA = { 'user-agent': 'Mozilla/5.0 (compatible; llm-world docs reader)' };

/** Fetch text, or null. Never throws — a lab being down is not a crash. */
export async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000), headers: UA });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * A markdown table as rows of cells.
 *
 * Markdown is used wherever a lab offers it — three of the four do, at the same
 * path plus `.md` — because a delimited row cannot be misread the way flattened
 * HTML can. This is the single highest-value habit in these readers: look for
 * the .md before writing a single regex against prose.
 */
export const mdRows = (md) => md.split('\n')
  .filter((l) => l.trim().startsWith('|'))
  .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
  .filter((cells) => cells.length && !cells.every((c) => /^-+$/.test(c)));

/** "500k" → 500000, "1M" → 1000000, "1,050,000" → 1050000. */
export const tokens = (s) => {
  const t = String(s).replace(/,/g, '').trim();
  const m = /^([\d.]+)\s*([km])?/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1);
  return n > 0 ? Math.round(n) : null;
};

export const dollars = (s) => {
  const m = /\$\s*([\d.]+)/.exec(String(s));
  return m ? Number(m[1]) : null;
};

/**
 * Apply one lab's parsed specs to its records.
 *
 * `specs` is a Map keyed by whatever the lab calls the model; matching is by
 * flattened name, exact first. Returns what it changed so the caller can print
 * it — this never prints, because a library that logs is a library you cannot
 * call twice.
 */
export function applySpecs({ records, specs, write, today, priceNote, sourceOf }) {
  const keys = [...specs.keys()];
  const results = [];

  for (const r of records) {
    const key = keys.find((k) => flat(k) === flat(r.model))
      ?? keys.find((k) => flat(k).startsWith(flat(r.model)));
    if (!key) { results.push({ record: r, status: 'not-served' }); continue; }

    const s = specs.get(key);
    const added = [];

    if (r.specifications?.language
      && r.specifications.language.context_window == null && s.context_window) {
      added.push(`context ${s.context_window.toLocaleString('en-US')}`);
      if (write) r.specifications.language.context_window = s.context_window;
    }

    if (!r.modalities && s.modalities?.input?.length && s.modalities?.output?.length) {
      added.push(`modalities in ${s.modalities.input.join('/')} out ${s.modalities.output.join('/')}`);
      if (write) r.modalities = s.modalities;
    }

    if (!r.pricing && s.input_price != null && s.output_price != null) {
      added.push(`$${s.input_price}/$${s.output_price} per 1M`);
      if (write) {
        // observed_on, not effective_from: this records what the page said
        // today, never when the price started.
        r.pricing = [{
          unit: 'per_million_tokens',
          rates: { input: s.input_price, output: s.output_price },
          currency: 'USD',
          observed_on: today,
          sources: [sourceOf?.(r) ?? r.sources[0].id],
          ...(priceNote ? { note: priceNote } : {}),
        }];
      }
    }

    results.push({ record: r, key, added, status: added.length ? 'filled' : 'complete' });
  }

  return results;
}

/** Models a lab serves that no record matches. Reported, never added. */
export const untrackedIn = (specs, records) =>
  [...specs.keys()].filter((k) => !records.some((r) => flat(r.model) === flat(k)));

/** One report shape for every lab, so their output reads the same. */
export function report(lab, results, untracked, { write, note } = {}) {
  const filled = results.filter((x) => x.status === 'filled');
  for (const x of results) {
    const name = x.record.model.padEnd(18);
    if (x.status === 'not-served') console.log(`  · ${name} not served by the API`);
    else if (x.status === 'complete') console.log(`  · ${name} nothing to add`);
    else console.log(`  ✓ ${name} ${x.added.join(' · ')}`);
  }
  if (untracked.length) {
    console.log(`\nNOT TRACKED — ${lab} serves these and this dataset has no record:`);
    console.log('  ' + untracked.join('\n  '));
    console.log('  A docs page proves a model is served, not when it shipped.'
      + ' Each still needs the lab\'s own announcement for a date.');
  }
  if (note) console.log(`\n${note}`);
  console.log(`\n${filled.length} record${filled.length === 1 ? '' : 's'} with something to add`);
  if (!write) console.log('dry run — pass --write to record');
  return filled.length;
}
