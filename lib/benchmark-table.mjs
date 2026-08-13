/**
 * Reads a score out of a multi-column benchmark comparison table.
 *
 * WHY THIS IS NOT "THE NUMBER AFTER THE NAME"
 *
 * Modern announcements do not state scores in prose. They print a table
 * comparing the new model against its rivals, and once the HTML is flattened to
 * text a row looks like this:
 *
 *   GPQA Diamond 93.5 92.6 94.1 91.0 93.5 91.2
 *
 * Six numbers, one per column, and nothing in the row says which column is the
 * model being announced. Taking the first one is wrong often enough to be
 * dangerous: Alibaba's Qwen3.8-Max table runs
 *
 *   Opus4.8 | Fable5 | GPT5.6 Sol | Qwen3.7-Max | Qwen3.8-Max
 *
 * so the first number in every row is Claude Opus 4.8's score. Recording it
 * would publish a competitor's result as Alibaba's own claim, marked
 * `vendor_reported`, citing the lab's announcement. That is the worst failure
 * this file could have, and it is why the whole thing refuses rather than
 * guesses.
 *
 * HOW THE COLUMN IS IDENTIFIED
 *
 * Not by position — a character offset divided by a header length is a guess
 * wearing arithmetic. Every column is identified BY NAME, using the model names
 * this dataset already holds as a lexicon. A score is returned only when:
 *
 *   1. the data rows agree on how many columns there are,
 *   2. that many distinct model names are found in the header, and
 *   3. exactly one of them is the record's own model.
 *
 * Failing any of the three returns nothing. Identifying four columns out of
 * five is not "nearly right", it means the header was misread and the ordinal
 * is untrustworthy. A missing benchmark is a gap; a wrong one is a false claim
 * about a lab.
 */

/** Cell forms seen in real tables: 93.5, 43.5 / 56.0, 88%, --, —, or a dash. */
const CELL = String.raw`(?:\d{1,3}(?:\.\d+)?(?:\s*\/\s*\d{1,3}(?:\.\d+)?)?%?|--|—|–|-)`;
const CELL_RE = new RegExp(`^\\s*(${CELL})(?=\\s|$)`);

/** Compare names across punctuation, spacing and case differences. */
export const flatten = (s) => String(s).toLowerCase().replace(/[\s._\-()[\]]/g, '');

/**
 * The run of cells starting at `from`.
 *
 * A row ends at the first token that is not a cell — the next benchmark's name,
 * or a section heading like "Coding".
 */
export function rowValues(text, from) {
  const out = [];
  let i = from;
  for (;;) {
    const m = CELL_RE.exec(text.slice(i, i + 40));
    if (!m) break;
    out.push(m[1]);
    i += m[0].length;
    if (out.length > 24) return { values: [], end: from }; // not a table row
  }
  return { values: out, end: i };
}

/**
 * The first numeric value of a cell, or null when the cell is empty.
 *
 * "43.5 / 56.0" is a pass@1 / pass@k pair; the first figure is the plain score
 * and the only one comparable with a single-number cell.
 */
export function cellScore(cell) {
  if (/^(?:--|—|–|-)$/.test(cell)) return null;
  const m = /^(\d{1,3}(?:\.\d+)?)/.exec(cell);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * Every lexicon name found in `header`, in the order they appear.
 *
 * Overlapping matches are resolved by preferring the longest, so a header
 * containing "Qwen3.8-Max" is not also counted as "Qwen3.8".
 */
export function namesIn(header, lexicon) {
  const flat = flatten(header);
  const hits = [];
  for (const name of lexicon) {
    const f = flatten(name);
    if (f.length < 4) continue;
    let at = flat.indexOf(f);
    while (at >= 0) {
      hits.push({ at, len: f.length, name });
      at = flat.indexOf(f, at + 1);
    }
  }
  hits.sort((a, b) => a.at - b.at || b.len - a.len);

  const kept = [];
  for (const h of hits) {
    const last = kept[kept.length - 1];
    if (last && h.at < last.at + last.len) continue; // overlaps a longer match
    kept.push(h);
  }
  return kept;
}

/**
 * Which column belongs to `model`, or null when that cannot be established.
 *
 * `header` is the text immediately preceding the first data row; `width` is the
 * agreed column count. The three conditions in the file header are enforced
 * here, in order.
 */
export function columnFor(header, model, width, lexicon) {
  const found = namesIn(header, lexicon);
  if (found.length !== width) return null;

  const target = flatten(model);
  const mine = found.filter((h) => flatten(h.name) === target);
  if (mine.length !== 1) return null;

  return {
    index: found.indexOf(mine[0]),
    columns: found.map((h) => h.name),
  };
}
