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
/** Fields that only mean something for a language model. */
const LANGUAGE_ONLY = new Set(['context_window', 'parameter_count']);

/**
 * Whether a field is even a question for this record.
 *
 * An image-generation model has no context window. Reporting that as a missing
 * value would count a category error as a research gap and drag every coverage
 * figure down with it.
 */
export function appliesTo(r, field) {
  if (!LANGUAGE_ONLY.has(field)) return true;
  return (r?.classification?.primary_type ?? 'language') === 'language';
}

export function fieldState(r, field) {
  if (!appliesTo(r, field)) return 'not_applicable';
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
  not_applicable: 'Not applicable',
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

/** Fields that can carry fact-level evidence. Deliberately three, not all. */
export const EVIDENCED_FIELDS = ['release_date', 'context_window', 'parameter_count'];

/** The value a record actually publishes for an evidenced field. */
export function assertedValue(r, field) {
  if (field === 'release_date') return canonicalDate(r);
  return r?.specifications?.language?.[field] ?? null;
}

/**
 * Who says so, for one fact.
 *
 * Returns the claims recorded for a field — each a value and the sources that
 * state it. More than one claim means credible sources disagree, and both are
 * kept: silently picking a winner is invisible to the reader and is the most
 * damaging thing this dataset could do (docs/METHODOLOGY.md §8).
 *
 * @returns {{claims: object[], agreed: boolean, sources: object[]}}
 */
export function evidenceFor(r, field) {
  const claims = r?.evidence?.[field] ?? [];
  const byId = new Map((r?.sources ?? []).map((s) => [s.id, s]));
  const resolved = claims.map((c) => ({
    value: c.value,
    sources: (c.sources ?? []).map((id) => byId.get(id)).filter(Boolean),
  }));
  return {
    claims: resolved,
    agreed: resolved.length === 1,
    // Every source backing the value this record actually publishes.
    sources: resolved.find((c) => c.value === assertedValue(r, field))?.sources ?? [],
  };
}

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
      // A field that does not apply to one of them is not a gap in the data —
      // comparing an image model's context window to a text model's is a
      // category error, not a missing value.
      if (a === 'not_applicable' || b === 'not_applicable') return;
      incomparable.push({
        label,
        why: [a, b].includes('unresearched')
          ? 'not researched on both releases'
          : 'not disclosed for both releases',
      });
      return;
    }
    // Optional chaining: a non-language record has no language bucket at all.
    const va = field === 'license' ? prev.access.license : prev.specifications?.language?.[field];
    const vb = field === 'license' ? next.access.license : next.specifications?.language?.[field];
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
    // ADDITIONS ONLY, and never described as "gained".
    //
    // capabilities[] is not an exhaustive audit of any record — it holds what
    // has been evidenced so far, and TAXONOMY §4 is explicit that an unlisted
    // capability means "not evidenced", never "absent". So a set difference in
    // the losing direction is uninterpretable: when Claude Opus 4.8 lists
    // `agentic` and Claude Fable 5 does not, nothing was removed; Fable 5's
    // agentic behaviour simply has not been cited yet. Reporting "− agentic"
    // would invent a regression in a shipping product.
    //
    // Additions are reported as first evidence, which is what they are.
    const gained = next.capabilities.filter((c) => !prev.capabilities.includes(c));
    if (gained.length) {
      changes.push({ label: 'Capabilities first evidenced', gained, direction: 'change' });
    }
    const ma = prev.modalities, mb = next.modalities;
    // No arrow inside the value: the diff already uses one between old and new,
    // and "text + image → text → text + image + audio → …" is unreadable.
    const modText = (m) => `in ${m.input.join(', ')} · out ${m.output.join(', ')}`;
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
