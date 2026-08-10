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
