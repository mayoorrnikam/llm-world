/**
 * Derived facts for a schema 1.6 record — the single definition of each.
 *
 * Imported by the browser app (`app.js`) and by the Node scripts alike, so a
 * plain ES module with no Node APIs and no dependencies.
 *
 * Everything here is DERIVED. Nothing in this file is stored in the dataset,
 * because a fact stored twice eventually disagrees with itself
 * (docs/METHODOLOGY.md §4). If you find yourself adding a field to the JSON
 * that could be computed here instead, compute it here instead.
 */

/** Tokens above which a context window counts as long. */
const LONG_CONTEXT_TOKENS = 200_000;

/**
 * The one date a model sits at on the timeline.
 *
 * Announcement, because that is the date almost universally reported and the
 * date the 1.5 dataset already encoded — choosing availability instead would
 * silently re-order the timeline against every cited source. Falls back to the
 * earliest evidenced event where no announcement exists (METHODOLOGY §3).
 *
 * @returns {string|null} `YYYY-MM-DD`, or `YYYY-MM` where the day is unknown.
 */
export function canonicalDate(r) {
  const events = Array.isArray(r?.events) ? r.events.filter((e) => e?.date) : [];
  if (!events.length) return null;
  const announced = events.find((e) => e.type === 'announcement');
  if (announced) return announced.date;
  return events.reduce((a, b) => (a.date <= b.date ? a : b)).date;
}

/** Canonical date split into numbers. `day` is 0 when only the month is known. */
export function dateParts(r) {
  const iso = canonicalDate(r);
  if (!iso) return { year: NaN, month: NaN, day: 0 };
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, month: m, day: d || 0 };
}

/** Sortable stamp for the canonical date. */
export function stamp(r) {
  const { year, month, day } = dateParts(r);
  return Date.UTC(year, (month || 1) - 1, day || 1);
}

/** Every event of a type, oldest first. */
export function eventsOfType(r, type) {
  return (r?.events ?? []).filter((e) => e.type === type)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** The date a fact became true — e.g. when weights were published. */
export function dateOfEvent(r, type) {
  return eventsOfType(r, type)[0]?.date ?? null;
}

export const contextWindow = (r) => r?.specifications?.language?.context_window ?? null;
export const parameterCount = (r) => r?.specifications?.language?.parameter_count ?? null;

/**
 * Why a field has no value. `null` alone cannot tell these apart, and they are
 * very different facts: one is a complete record, the other is a gap.
 *
 *   recorded      we have a value
 *   undisclosed   we read the primary sources and the lab does not publish it.
 *                 A positive claim, backed by having looked.
 *   unresearched  nobody has checked yet. The honest default.
 *
 * Rendering `unresearched` as "Not disclosed" would claim knowledge about the
 * lab's behaviour that nobody has established (docs/METHODOLOGY.md §1).
 */
export function fieldState(r, field) {
  const value = field === 'license'
    ? r?.access?.license
    : r?.specifications?.language?.[field];
  if (value != null) return 'recorded';
  return (r?.undisclosed ?? []).includes(field) ? 'undisclosed' : 'unresearched';
}

/** How a missing value should read to a person. */
export const MISSING_LABEL = {
  undisclosed: 'Not disclosed',
  unresearched: 'Not researched',
};

/**
 * Multimodal is a property of the modalities, never a stored flag.
 * `null` modalities mean "not yet researched", so this returns null rather than
 * false — absence of evidence must not render as a negative claim.
 */
export function isMultimodal(r) {
  const m = r?.modalities;
  if (!m) return null;
  return m.input.length > 1 || m.output.length > 1
    || !(m.input.length === 1 && m.input[0] === 'text'
      && m.output.length === 1 && m.output[0] === 'text');
}

/** Derived from the recorded number, so it can never disagree with it. */
export function hasLongContext(r) {
  const n = contextWindow(r);
  return n == null ? null : n >= LONG_CONTEXT_TOKENS;
}

/**
 * The chips shown in the UI: evidenced facts first, then our own judgements.
 *
 * The dataset keeps these apart on purpose (TAXONOMY §5) — this composes them
 * for display only. `?tag=` URLs filter against this list, which is why legacy
 * links keep working after the 1.6 split.
 */
export function displayTags(r) {
  const out = [...(r?.capabilities ?? [])];
  if (r?.access?.open_weights) out.push('open-weights');
  if (isMultimodal(r)) out.push('multimodal');
  if (hasLongContext(r)) out.push('long-context');
  for (const t of r?.tags ?? []) if (!out.includes(t)) out.push(t);
  return out;
}

/** True when a tag is our judgement rather than something a source states. */
export const isEditorialTag = (t) => t === 'flagship' || t === 'small-efficient';

/**
 * Display text for a chip. The stored value stays the filter key — `?tag=` URLs
 * and `data-tag` attributes must keep using the raw value, or saved links break.
 * This only changes what a reader sees.
 */
export const tagLabel = (t) => String(t).replace(/_/g, ' ');

/**
 * What changed between two generations of a family.
 *
 * The hard part is not computing differences — it is refusing to report ones
 * the data cannot support. Most fields in this dataset are sparse, and a naive
 * diff turns a research gap into a false claim about a lab:
 *
 *   Claude 3 Opus records `vision`; Claude 3.5 Sonnet records nothing. A plain
 *   set difference says "− vision", i.e. Anthropic REMOVED vision. What actually
 *   happened is that only some records have had capabilities researched.
 *
 * So a field is compared only when both records genuinely assert a value
 * (TAXONOMY §4: an unlisted capability means "not evidenced", never "absent").
 * Everything else is returned as `incomparable`, with the reason, to be shown
 * as a gap rather than hidden.
 *
 * @returns {{changes: object[], incomparable: object[]}}
 */
export function diffRecords(prev, next) {
  const changes = [];
  const incomparable = [];

  const numeric = (field, label, format) => {
    const a = fieldState(prev, field), b = fieldState(next, field);
    if (a !== 'recorded' || b !== 'recorded') {
      incomparable.push({
        label,
        why: [a, b].includes('unresearched')
          ? 'not researched on both releases'
          : 'not disclosed for both releases',
      });
      return;
    }
    const va = field === 'license' ? prev.access.license : prev.specifications.language[field];
    const vb = field === 'license' ? next.access.license : next.specifications.language[field];
    if (va === vb) return;
    changes.push({
      label,
      from: format ? format(va) : String(va),
      to: format ? format(vb) : String(vb),
      direction: typeof va === 'number' && typeof vb === 'number'
        ? (vb > va ? 'up' : 'down') : 'change',
    });
  };

  numeric('context_window', 'Context window', tokenText);
  numeric('parameter_count', 'Parameters', paramText);

  // Access is always recorded, so it is always comparable.
  if (prev.access.open_weights !== next.access.open_weights) {
    changes.push({
      label: 'Weights',
      from: prev.access.open_weights ? 'Open' : 'Proprietary',
      to: next.access.open_weights ? 'Open' : 'Proprietary',
      direction: next.access.open_weights ? 'up' : 'down',
    });
  }
  if (next.access.open_weights && prev.access.open_weights) numeric('license', 'Licence');

  // Capabilities and modalities were established in the same research pass, so
  // a record with modalities has had its capabilities read off a primary source.
  // Without that, an empty capabilities[] means "nobody looked", and comparing
  // it would manufacture a change that never happened.
  const researched = (r) => r.modalities != null;
  if (researched(prev) && researched(next)) {
    const gained = next.capabilities.filter((c) => !prev.capabilities.includes(c));
    const lost = prev.capabilities.filter((c) => !next.capabilities.includes(c));
    if (gained.length || lost.length) {
      changes.push({ label: 'Capabilities', gained, lost, direction: 'change' });
    }
    const ma = prev.modalities, mb = next.modalities;
    const modText = (m) => `${m.input.join(' + ')} → ${m.output.join(' + ')}`;
    if (modText(ma) !== modText(mb)) {
      changes.push({ label: 'Modalities', from: modText(ma), to: modText(mb), direction: 'change' });
    }
  } else {
    incomparable.push({ label: 'Capabilities and modalities', why: 'not researched on both releases' });
  }

  return { changes, incomparable };
}

const tokenText = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}K`;
const paramText = (n) => n >= 1e12 ? `${+(n / 1e12).toFixed(2)}T`
  : n >= 1e9 ? `${+(n / 1e9).toFixed(n < 1e10 ? 1 : 0)}B`
  : `${Math.round(n / 1e6)}M`;

/** Human labels for source types. Shared so the app and the static pages
 *  cannot describe the same source differently. */
export const SOURCE_LABEL = {
  official_announcement: 'Official announcement',
  official_documentation: 'Official documentation',
  official_model_card: 'Model card',
  official_repository: 'Code repository',
  technical_paper: 'Technical paper',
  independent_benchmark: 'Independent benchmark',
  independent_analysis: 'Independent analysis',
  news: 'News reporting',
};

/** Whether a source is the organisation that made the model, or someone else. */
export const AUTHORITY_LABEL = {
  primary: 'Primary',
  secondary: 'Secondary',
  discovery: 'Discovery only',
};
