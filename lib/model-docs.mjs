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
 * Ensure the page a value was read from is a cited source, and return its id.
 *
 * WHY THIS EXISTS
 *
 * Every reader used to cite `sources[0]` for the price it had just parsed off a
 * docs page. That is only right when sources[0] happens to be that page, and an
 * audit of the 22 records carrying pricing found five where it was not:
 *
 *   claude-fable-5   $10/$50   cited to en.wikipedia.org/wiki/Claude_(language_model)
 *   gpt-5.6 luna     $0.2/$1.2 cited to en.wikipedia.org/wiki/GPT-5.6
 *   gpt-5.6 sol      $5/$30    cited to en.wikipedia.org/wiki/GPT-5.6
 *   gpt-5.6 terra    $2/$12    cited to en.wikipedia.org/wiki/GPT-5.6
 *   gpt-5.6 cyber    $12.5/$75 cited to an openai.com blog post
 *
 * The figures were right; the citation was fiction. None of those pages states
 * the number attached to it, and four are Wikipedia, which METHODOLOGY §5 bars
 * from backing a value at all. The other seventeen were correct by luck —
 * Anthropic's and xAI's announcements do print their prices — which is exactly
 * what let the bug sit unnoticed.
 *
 * A value and the page it came from travel together or the citation is decor.
 */
export function citeDocs(record, url, suffix = 'docs') {
  const existing = record.sources.find((s) => s.url === url);
  if (existing) return existing.id;
  let id = `${record.id}-${suffix}`;
  for (let n = 2; record.sources.some((s) => s.id === id); n++) id = `${record.id}-${suffix}${n}`;
  record.sources.push({
    id,
    url,
    type: 'official_documentation',
    authority: 'primary',
    archived_url: null,
    retrieved: null,
  });
  return id;
}

/**
 * Apply one lab's parsed specs to its records.
 *
 * `specs` is a Map keyed by whatever the lab calls the model; matching is by
 * flattened name, exact first. `docsUrl(record, key)` says which page the specs
 * were read from, so a recorded price can cite it rather than whatever happens
 * to sit at sources[0]. Returns what it changed so the caller can print it —
 * this never prints, because a library that logs is a library you cannot call
 * twice.
 */
export function applySpecs({ records, specs, write, today, priceNote, docsUrl, docsSuffix }) {
  const keys = [...specs.keys()];
  const results = [];

  for (const r of records) {
    const key = keys.find((k) => flat(k) === flat(r.model))
      ?? keys.find((k) => flat(k).startsWith(flat(r.model)));
    if (!key) { results.push({ record: r, status: 'not-served' }); continue; }

    const s = specs.get(key);
    const added = [];
    const deferred = [];

    if (r.specifications?.language
      && r.specifications.language.context_window == null && s.context_window) {
      added.push(`context ${s.context_window.toLocaleString('en-US')}`);
      if (write) r.specifications.language.context_window = s.context_window;
    }

    if (!r.modalities && s.modalities?.input?.length && s.modalities?.output?.length) {
      added.push(`modalities in ${s.modalities.input.join('/')} out ${s.modalities.output.join('/')}`);
      if (write) r.modalities = s.modalities;
    }

    const url = docsUrl?.(r, key) ?? null;

    if (!r.pricing && s.input_price != null && s.output_price != null) {
      // A price needs a snapshot, not just a source: METHODOLOGY §6 will not let
      // a live page evidence a past price, because the page will say something
      // else next quarter and the record would still claim it said this. Until
      // the page is archived the price is reported and withheld rather than
      // written — `archive-sources --save` supplies the snapshot, and the next
      // run picks the price up.
      const cited = url ? r.sources.find((x) => x.url === url) : null;
      if (!url) {
        deferred.push('price has no page to cite');
      } else if (!cited?.archived_url) {
        deferred.push(`$${s.input_price}/$${s.output_price} — ${cited ? 'page not archived yet' : 'page not yet a cited source'}`);
      } else {
        added.push(`$${s.input_price}/$${s.output_price} per 1M`);
        if (write) {
          // observed_on, not effective_from: this records what the page said
          // today, never when the price started.
          r.pricing = [{
            unit: 'per_million_tokens',
            rates: { input: s.input_price, output: s.output_price },
            currency: 'USD',
            observed_on: today,
            sources: [cited.id],
            ...(priceNote ? { note: priceNote } : {}),
          }];
        }
      }
    }

    // The page every value above came from becomes a citation on the record,
    // never an invisible provenance. It is also what makes the price recordable
    // on a later run: archive-sources can only snapshot a URL the data names.
    // `deferred` counts too, and must: a record whose only gap is a price would
    // otherwise never name the page, so archive-sources would never snapshot it
    // and the price would defer forever.
    if (write && url && (added.length || deferred.length)) citeDocs(r, url, docsSuffix);

    results.push({
      record: r, key, added, deferred,
      status: added.length ? 'filled' : deferred.length ? 'deferred' : 'complete',
    });
  }

  return results;
}

/**
 * Add capabilities a lab's docs affirm, and never remove any.
 *
 * Only additions, because TAXONOMY §4 reads an unlisted capability as "not
 * evidenced" rather than "absent". Google's pages print "Image generation: Not
 * supported" — one of the few places a lab states absence outright — and that
 * cannot be recorded here: the schema has no way to say "the lab says it
 * cannot", and writing it as silence is indistinguishable from never having
 * looked. So a No is read, and dropped.
 *
 * The mapping is the dangerous part and stays with each reader, because the
 * same word means different things per lab. Gemini lists "Code execution:
 * Supported", which is a sandboxed tool the API can call — not evidence the
 * model is good at coding, and mapping it to `coding` would put every Gemini
 * model into "best model for coding" on the strength of a feature flag.
 */
export function mergeCaps(record, caps, write) {
  const fresh = [...new Set(caps)].filter((c) => !(record.capabilities ?? []).includes(c));
  if (fresh.length && write) record.capabilities = [...(record.capabilities ?? []), ...fresh];
  return fresh;
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
    else console.log(`  ${x.added.length ? '✓' : '⋯'} ${name} ${[...x.added, ...(x.deferred ?? [])].join(' · ')}`);
  }
  const waiting = results.flatMap((x) => x.deferred ?? []);
  if (waiting.length) {
    console.log(`\n${waiting.length} price${waiting.length === 1 ? '' : 's'} withheld pending an archived snapshot`
      + ' of the page\n  that states them (METHODOLOGY §6). Run `node scripts/archive-sources.mjs --save`,'
      + '\n  then this again.');
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
  // Deferrals count as changes: applySpecs has just added the docs page as a
  // cited source so archive-sources can snapshot it. Returning only `filled`
  // would leave that citation unsaved and the price deferred forever.
  return filled.length + waiting.length;
}
