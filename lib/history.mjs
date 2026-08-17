/**
 * One field's history across one company, computed once.
 *
 * Both the post generator and the build read this. They used to each own a copy
 * of "find the change points", which is the shape of bug CLAUDE.md warns about:
 * a fact derived twice eventually disagrees with itself, and the disagreement
 * surfaces as a published page contradicting a published thread.
 *
 * The rules that matter are not the arithmetic:
 *
 *   A plateau is only a story above PLATEAU_MONTHS. Five months at one value is
 *   a release cadence; twenty is a decision. Announcing the first as though it
 *   were the second is the same overclaim as filling a null with a guess.
 *
 *   "Grew N×" is a trend claim, and first-to-last only supports one when the
 *   series climbs. Parameter counts fall — Meta reads 175B → 30B — so a
 *   non-monotonic series gets its endpoints stated and no trend asserted.
 *
 *   A value with no evidence[] entry is flagged, not hidden. Publishing an
 *   untraced number without saying so is the whole thing this project exists
 *   not to do.
 */

import { canonicalDate, fieldState, evidenceFor, appliesTo } from './record.mjs';

export const PLATEAU_MONTHS = 12;

export const FIELD_LABEL = {
  context_window: 'context window',
  parameter_count: 'parameters',
};

/** 200000 -> "200K", 1e6 -> "1M", 175e9 -> "175B". Labs write it this way. */
export function short(n) {
  if (n == null) return '—';
  if (n % 1_000_000_000 === 0) return `${n / 1_000_000_000}B`;
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  // K only below a million. 1,050,000 rendered as "1050K" sat beside a raw
  // "1,048,576" in the frontier table, where the entire point is that the two
  // are nearly equal — and the mismatched units hid it.
  if (n < 1_000_000 && n % 1000 === 0) return `${n / 1000}K`;
  return n.toLocaleString('en-US');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pretty = (iso) => {
  const [y, m, d] = iso.split('-');
  return `${MONTHS[+m - 1]} ${+d}, ${y}`;
};

export const monthsBetween = (a, b) => {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
};

const times = (n) => (n % 1 ? n.toFixed(1) : String(n));

/**
 * @returns {null | object} null when the company has fewer than two recorded
 *   values for the field — a real gap, and callers must say so rather than
 *   render an empty history.
 */
export function fieldHistory(releases, company, field) {
  const label = FIELD_LABEL[field] ?? field;

  const records = releases
    .filter((r) => r.company === company && appliesTo(r, field))
    .map((r) => {
      const value = fieldState(r, field) === 'recorded'
        ? r.specifications?.language?.[field] ?? null
        : null;
      const ev = evidenceFor(r, field);
      return {
        r,
        id: r.id,
        model: r.model,
        date: canonicalDate(r),
        value,
        sources: ev.sources,
        unsourced: value != null && ev.sources.length === 0,
        contested: ev.claims.length > 1,
      };
    })
    .filter((x) => x.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const known = records.filter((x) => x.value != null);
  if (known.length < 2) {
    return { company, field, label, records, known, insufficient: true };
  }

  const gaps = records.filter((x) => x.value == null);
  const changes = [];
  const plateaus = [];
  let run = [known[0]];
  for (let i = 1; i < known.length; i++) {
    const [prev, cur] = [known[i - 1], known[i]];
    if (cur.value === prev.value) { run.push(cur); continue; }
    changes.push({ from: prev, to: cur, factor: cur.value / prev.value });
    if (run.length > 1) plateaus.push(run);
    run = [cur];
  }
  if (run.length > 1) plateaus.push(run);

  const span = (p) => monthsBetween(p[0].date, p[p.length - 1].date);
  const longest = plateaus.slice().sort((a, b) => span(b) - span(a))[0];
  const notable = longest && span(longest) >= PLATEAU_MONTHS ? longest : null;

  const first = known[0];
  const last = known[known.length - 1];
  const overall = last.value / first.value;
  const monotonic = known.every((x, i) => i === 0 || x.value >= known[i - 1].value);
  const months = monthsBetween(first.date, last.date);

  const headline = notable
    ? `${company}'s ${label} did not move for ${span(notable)} months`
    : monotonic
      ? `${company}'s ${label} grew ${times(overall)}× in ${months} months`
      : `${company}'s ${label} went ${short(first.value)} → ${short(last.value)}, and not in a straight line`;

  return {
    company, field, label, records, known, gaps, changes, plateaus,
    longest, notable, span, first, last, overall, monotonic, months, headline,
    insufficient: false,
  };
}

/** The change history as a markdown table. `link` turns model names into links. */
export function historyTable(h, link) {
  const head = h.label[0].toUpperCase() + h.label.slice(1);
  const rows = h.records.map((x, i) => {
    const prev = h.records.slice(0, i).reverse().find((p) => p.value != null);
    const chg = x.value == null ? '_not researched_'
      : !prev ? 'first recorded'
        : x.value === prev.value ? '—'
          : `**${times(x.value / prev.value)}×**`;
    const name = link ? `[${x.model}](${link(x)})` : x.model;
    return `| ${x.date} | ${name}${x.unsourced ? ' ⚠︎' : ''} | ${short(x.value)} | ${chg} |`;
  });
  return [`| Date | Model | ${head} | Change |`, '|---|---|---|---|', ...rows].join('\n');
}

/** Every change point with the documents behind it. */
export function historySources(h) {
  return h.changes.map((c) => {
    const lines = c.to.sources.length
      ? c.to.sources.map((s) => `  - ${s.url}`).join('\n')
      : '  - _no source attached to this value yet_';
    return `- **${short(c.from.value)} → ${short(c.to.value)}**, ${pretty(c.to.date)} (${c.to.model})\n${lines}`;
  }).join('\n');
}

/**
 * Open weights against proprietary, by release year.
 *
 * This is the one field recorded on every record, so unlike every other history
 * on this site it has no gaps to disclaim — access.open_weights is required by
 * the validator and must agree with the `open-weights` tag.
 *
 * The count is of RELEASES TRACKED, not of releases that happened. A year where
 * this dataset has looked harder at open labs will read as a more open year, and
 * the page has to say so: the shape is real, the absolute numbers are a sample.
 */
export function openWeightsByYear(releases) {
  const years = new Map();
  for (const r of releases) {
    const date = canonicalDate(r);
    if (!date || typeof r.access?.open_weights !== 'boolean') continue;
    const y = date.slice(0, 4);
    if (!years.has(y)) years.set(y, { year: y, open: 0, closed: 0 });
    years.get(y)[r.access.open_weights ? 'open' : 'closed']++;
  }
  const rows = [...years.values()].sort((a, b) => a.year.localeCompare(b.year));
  for (const row of rows) {
    row.total = row.open + row.closed;
    row.share = row.total ? row.open / row.total : 0;
  }
  const totals = rows.reduce(
    (a, r) => ({ open: a.open + r.open, closed: a.closed + r.closed }),
    { open: 0, closed: 0 },
  );
  // The years where the majority flipped — the only claim worth a headline.
  const crossings = rows.filter((r, i) =>
    i > 0 && (r.share >= 0.5) !== (rows[i - 1].share >= 0.5));
  return { rows, totals, crossings, tracked: totals.open + totals.closed };
}

/**
 * The frontier on each side of the licence line, by year.
 *
 * This exists because openWeightsByYear() alone is dangerous. A reader — and the
 * person writing the post — sees "26 open, 65 proprietary" and concludes the
 * open side is losing. That is a count of RELEASES, and release count measures
 * how often a lab ships, not how good the models are: in 2026 the proprietary
 * total is concentrated in a handful of labs that ship many increments.
 *
 * On the one capability this dataset records for both sides, the counts and the
 * frontier disagree outright — so the two are always reported together, and a
 * volume table can never be published on its own.
 */
export function openWeightsFrontier(releases) {
  const years = new Map();
  for (const r of releases) {
    const date = canonicalDate(r);
    const ctx = fieldState(r, 'context_window') === 'recorded'
      ? r.specifications?.language?.context_window ?? null
      : null;
    if (!date || ctx == null || typeof r.access?.open_weights !== 'boolean') continue;
    const y = date.slice(0, 4);
    if (!years.has(y)) years.set(y, { year: y, open: null, closed: null });
    const side = r.access.open_weights ? 'open' : 'closed';
    const cur = years.get(y)[side];
    if (!cur || ctx > cur.value) {
      years.get(y)[side] = {
        value: ctx,
        model: r.model,
        id: r.id,
        // A frontier claim is only as good as the document behind it, and these
        // are the load-bearing numbers of the whole comparison. The 2026 open
        // figure had no evidence[] entry when this was written — publishing
        // "open matched the frontier" on an untraced value is exactly the claim
        // this project exists not to make.
        sourced: evidenceFor(r, 'context_window').sources.length > 0,
        status: r.provenance?.status,
      };
    }
  }
  return [...years.values()].sort((a, b) => a.year.localeCompare(b.year));
}

/** The frontier comparison as a markdown table. Unsourced values carry ⚠︎. */
export function openWeightsFrontierTable(rows) {
  const cell = (c) => (c ? `${short(c.value)} — ${c.model}${c.sourced ? '' : ' ⚠︎'}` : '—');
  return [
    '| Year | Largest open-weights context | Largest proprietary context |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.year} | ${cell(r.open)} | ${cell(r.closed)} |`),
  ].join('\n');
}

/**
 * How close counts as level.
 *
 * In 2026 the open frontier reads 1,048,576 and the proprietary one 1,050,000 —
 * a gap of 0.1%, which is a rounding difference between "2^20" and "a round
 * million", not a capability difference. A strict `>=` calls that a loss and a
 * generous eye calls it a tie, so the threshold is written down here instead of
 * being decided per post. Anything within 5% is level, and the pages say so.
 */
export const LEVEL_TOLERANCE = 0.05;

/** Years where open weights led, or came within LEVEL_TOLERANCE of, proprietary. */
export const frontierLevel = (rows) => rows.filter((r) =>
  r.open && r.closed && r.open.value >= r.closed.value * (1 - LEVEL_TOLERANCE));

/** The frontier values that are not yet traced to a primary source. */
export const frontierUnsourced = (rows) =>
  rows.flatMap((r) => ['open', 'closed']
    .filter((s) => r[s] && !r[s].sourced)
    .map((s) => ({ year: r.year, side: s, model: r[s].model })));

/** Open-weights share by year, as a markdown table. */
export function openWeightsTable(ow) {
  return [
    '| Year | Open weights | Proprietary | Open share |',
    '|---|---|---|---|',
    ...ow.rows.map((r) =>
      `| ${r.year} | ${r.open} | ${r.closed} | **${Math.round(r.share * 100)}%** |`),
    `| **All** | **${ow.totals.open}** | **${ow.totals.closed}** | **${
      Math.round((ow.totals.open / ow.tracked) * 100)}%** |`,
  ].join('\n');
}

/**
 * The values a post's story actually rests on.
 *
 * Not every row — the ones a headline is computed from. For a field history that
 * is the two endpoints and every change point: a plateau is defined by the moves
 * that bracket it, and a growth multiple is the first value divided by the last.
 * If one of those has no source, the sentence built on it has no source either,
 * however many well-cited rows sit around it.
 *
 * `/posts/google-deepmind-context-window/` is the case that prompted this. Six
 * changes, three of them untraced, and a headline reading "512×" whose
 * denominator — PaLM's 2,048 — was one of the three.
 */
export function historyClaims(h) {
  if (h.insufficient) return [];
  const seen = new Set();
  return [h.first, h.last, ...h.changes.map((c) => c.to)]
    .filter((x) => (seen.has(x.id) ? false : seen.add(x.id)))
    .map((x) => ({
      label: `${h.label} of ${x.model}`,
      model: x.model,
      id: x.id,
      value: x.value,
      sourced: !x.unsourced,
      status: x.r.provenance?.status,
    }));
}

/** The frontier cells a licence comparison rests on. */
export const frontierClaims = (rows) =>
  rows.flatMap((r) => ['open', 'closed']
    .filter((s) => r[s])
    .map((s) => ({
      label: `${r.year} ${s === 'open' ? 'open-weights' : 'proprietary'} frontier`,
      model: r[s].model,
      id: r[s].id,
      value: r[s].value,
      sourced: r[s].sourced,
      status: r[s].status,
    })));

/** What the history deliberately does not claim. */
export function historyCaveats(h) {
  const unsourced = h.records.filter((x) => x.unsourced).length;
  const contested = h.records.filter((x) => x.contested).length;
  return [
    h.gaps.length
      && `${h.gaps.length} of ${h.records.length} records have no ${h.label} recorded — shown above as gaps, not as "unchanged".`,
    unsourced
      && (unsourced === 1
        ? 'One value, marked ⚠︎, is in the dataset but not yet traced to a primary source.'
        : `${unsourced} values marked ⚠︎ are in the dataset but not yet traced to a primary source.`),
    contested
      && `${contested} value(s) have more than one sourced claim. Both are kept in the dataset; neither is picked here.`,
  ].filter(Boolean);
}
