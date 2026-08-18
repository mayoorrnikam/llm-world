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

/**
 * Readable text out of a PDF, without a dependency.
 *
 * Technical papers are primary sources and several are cited here, but they are
 * PDFs — so every tool that read sources as HTML saw nothing in them and
 * reported "no evidence found" when the evidence was simply in a format nobody
 * opened. Gemini 1's report states its context window in exactly that way.
 *
 * PDF text lives in Flate-compressed streams as literal strings fed to the Tj
 * operators. Inflating the streams and pulling the literals out gets readable
 * prose from the vast majority of published papers. It is not a parser: it
 * cannot handle encrypted or non-Flate PDFs, and word spacing is imperfect —
 * which is fine, because callers search for values rather than read it.
 *
 * @param {Uint8Array} bytes raw PDF
 * @param {(b: Uint8Array) => Uint8Array} inflate zlib inflateSync, injected so
 *   this module stays free of Node imports and usable in the browser.
 */
export function pdfText(bytes, inflate) {
  const latin1 = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin1)) !== null) {
    const start = m.index + m[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      const raw = Uint8Array.from(latin1.slice(start, end), (c) => c.charCodeAt(0) & 0xff);
      const text = Array.from(inflate(raw), (b) => String.fromCharCode(b)).join('');
      // Only content streams, which are the ones holding text. An earlier
      // version skipped "an image" in this catch, but images are Flate-
      // compressed too: inflate succeeds, returns pixel bytes, and the literal
      // regex below harvests every run of them that happens to sit between
      // parentheses. Gemini 3 Pro's model card came back as 395,000 characters
      // of bitmap at 12% printable — and callers cannot tell that from prose.
      // A text stream draws with BT…ET, which no image stream contains.
      if (/\bBT\b[\s\S]*\bET\b/.test(text)) out.push(text);
    } catch { /* not Flate, or encrypted — skip it */ }
  }
  const joined = out.join(' ');
  const literals = joined.match(/\((?:\\.|[^()\\])*\)/g) ?? [];
  const text = literals
    .map((l) => l.slice(1, -1))
    .join(' ')
    .replace(/\\([()\\])/g, '$1')
    .replace(/\s+/g, ' ');

  // Backstop: a subset/CID-encoded PDF inflates and passes the BT…ET test but
  // yields bytes mapped through a font's own encoding, which is not English.
  // Returning it would be worse than returning nothing, because "readable but
  // says nothing" is the input detect-undisclosed.mjs turns into a published
  // claim that the lab discloses nothing.
  const sample = text.slice(0, 4000);
  const legible = (sample.match(/[A-Za-z0-9 .,;:'"()\-]/g) ?? []).length / (sample.length || 1);
  if (legible < 0.8) return '';

  // Same argument by length. Gemini 3 Pro's model card is subset-encoded: it
  // survives both tests above and yields 102 characters of ligature fragments
  // ("ff fi fi fl…"). No cited primary source is genuinely that short, so this
  // is a failed extraction wearing the costume of a successful one.
  return text.length < 500 ? '' : text;
}

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

    /**
     * ADDITIONS ONLY, for the same reason capabilities are additions only.
     *
     * detect-modalities establishes a modality from what the primary sources
     * CLAIM; a modality the announcement never mentions is simply not listed.
     * So a modality present on the earlier record and absent from the later one
     * means "not evidenced here", not "the model lost it".
     *
     * Comparing GPT-4o with GPT-5 showed exactly this: both records verified,
     * and the diff read "in text, image, audio → in text, image", which renders
     * as OpenAI having removed audio from a shipping product. Nothing of the
     * sort happened — GPT-5's announcement does not discuss audio, and this
     * dataset does not read silence as denial (rule R5).
     *
     * A genuine narrowing is therefore reported as a research gap rather than a
     * regression. If a lab really does ship a text-only successor, that shows up
     * once its modalities are researched and cited, not by inference here.
     */
    const added = (a, b) => b.filter((x) => !a.includes(x));
    const gainedIn = added(ma.input, mb.input);
    const gainedOut = added(ma.output, mb.output);
    if (gainedIn.length || gainedOut.length) {
      changes.push({
        label: 'Modalities first evidenced',
        gained: [
          ...gainedIn.map((x) => `${x} in`),
          ...gainedOut.map((x) => `${x} out`),
        ],
        direction: 'change',
      });
    } else if (modText(ma) !== modText(mb)) {
      incomparable.push({
        label: 'Modalities',
        why: `${next.model} evidences fewer than ${prev.model}, which means not `
          + 'evidenced rather than removed',
      });
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

/**
 * Company → logo and colour slug. One copy, deliberately.
 *
 * There were three: app.js, search.js and scripts/build.mjs each carried their
 * own literal, and adding a lab meant remembering all three. Nobody did. Ai2
 * and MiniMax were added to the dataset and rendered with the generic "other"
 * mark on every surface — a lab present in the data and absent from the design.
 *
 * This is the same rule CLAUDE.md already states for the header, the footer and
 * the sprite: one source, read by both renderers. The map belongs here because
 * lib/record.mjs is the only module the browser and the build both import.
 *
 * Unknown companies fall back to `other`, which is a real mark rather than a
 * blank — but checkCompanyLogos() in scripts/smoke-test.mjs fails the build
 * when a company in the dataset lands there, so the fallback catches typos
 * rather than quietly absorbing new labs.
 */
export const COMPANY_SLUG = {
  'AI21 Labs': 'ai21', AI21: 'ai21',
  Anthropic: 'anthropic',
  'Mistral AI': 'mistral', Mistral: 'mistral',
  'Alibaba Qwen': 'alibaba', Alibaba: 'alibaba', Qwen: 'alibaba',
  Amazon: 'amazon', 'Amazon Web Services': 'amazon',
  NVIDIA: 'nvidia', Nvidia: 'nvidia',
  BigScience: 'bigscience',
  OpenAI: 'openai',
  Microsoft: 'microsoft',
  xAI: 'xai',
  'Google DeepMind': 'google', Google: 'google',
  DeepSeek: 'deepseek',
  'Meta AI': 'meta', Meta: 'meta',
  'Moonshot AI': 'moonshot', Moonshot: 'moonshot',
  'Zhipu AI': 'zhipu', Zhipu: 'zhipu',
  Cohere: 'cohere',
  'Allen Institute for AI': 'ai2', Ai2: 'ai2', AI2: 'ai2', AllenAI: 'ai2',
  MiniMax: 'minimax', Minimax: 'minimax',
  // The logo is FLUX's mark, which is how the lab brands its models and the
  // only mark lobe-icons carries for it.
  'Black Forest Labs': 'bfl', BFL: 'bfl', 'Black Forest Labs (BFL)': 'bfl',
  ByteDance: 'bytedance', 'ByteDance Seed': 'bytedance', Bytedance: 'bytedance',
  'Liquid AI': 'liquid', LiquidAI: 'liquid',
};

/** Slug for a company's logo (`#ic-<slug>`) and hue (`--c-<slug>`). */
export const logoSlug = (company) => COMPANY_SLUG[company] ?? 'other';

const MONOGRAM_SKIP = new Set(['ai', 'labs', 'lab', 'inc', 'ltd', 'the', 'of', 'for', 'and']);

/**
 * Initials for a lab with no logo — "MiniMax" → MM, "Allen Institute" → AI.
 *
 * The fallback used to be a generic grey mark, which is the one thing a
 * fallback should never be: it occupies the space identity lives in and says
 * nothing. Initials still name the lab, which is why every product that lists
 * organisations does this — Slack, Notion, Linear, GitHub.
 *
 * Skips the words that are shared across half the industry ("AI", "Labs"), so
 * two labs do not both come out as "A". Falls back to the first two letters for
 * single-word names, and to the internal capitals where a name has them.
 */
export function monogram(company) {
  const name = String(company ?? '').trim();
  if (!name) return '?';

  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const significant = words.filter((w) => !MONOGRAM_SKIP.has(w.toLowerCase()));
  const use = significant.length ? significant : words;

  if (use.length >= 2) return (use[0][0] + use[1][0]).toUpperCase();

  // Single word: always keep the first character, then the next capital if the
  // name has one. Taking capitals alone loses it — "xAI" came out "AI", which
  // is both wrong and the same initials as Ai2 and AI21.
  const word = use[0];
  const rest = word.slice(1);
  const nextCap = rest.match(/\p{Lu}|\p{N}/u)?.[0];
  return (word[0] + (nextCap ?? rest[0] ?? '')).toUpperCase();
}

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

/**
 * Where a release sits in its family: what came before, after, and beside it.
 *
 * DERIVED, NEVER STORED. `family` and the canonical date are both 100%
 * populated, and CLAUDE.md is explicit that a fact computable from another
 * field is computed rather than written down — two copies eventually disagree,
 * and a stored `predecessor` would rot the first time a record's date was
 * corrected.
 *
 * SAME-DAY RELEASES ARE SIBLINGS, NOT A CHAIN. Ordering a family purely by date
 * turns GPT-5.6 Sol, Luna and Terra into a three-step succession, which is a
 * confident falsehood about how OpenAI shipped them: they are one launch of
 * three sizes. Anything sharing a date is returned as a sibling and never as a
 * predecessor or successor.
 *
 * The relation is within a family only. Cross-family lineage — Gemma descending
 * from Gemini, say — is a judgement about model provenance that no field in this
 * dataset records, and guessing it from names would be exactly the kind of
 * plausible invention this project exists to avoid.
 *
 * @returns {{predecessor: object|null, successor: object|null, siblings: object[]}}
 */
export function lineageOf(record, all) {
  const family = record?.family;
  const on = canonicalDate(record);
  if (!family || !on) return { predecessor: null, successor: null, siblings: [] };

  const kin = all.filter((r) => r.family === family && r.id !== record.id && canonicalDate(r));
  const before = kin.filter((r) => canonicalDate(r) < on)
    .sort((a, b) => canonicalDate(b).localeCompare(canonicalDate(a)));
  const after = kin.filter((r) => canonicalDate(r) > on)
    .sort((a, b) => canonicalDate(a).localeCompare(canonicalDate(b)));

  return {
    predecessor: before[0] ?? null,
    successor: after[0] ?? null,
    siblings: kin.filter((r) => canonicalDate(r) === on)
      .sort((a, b) => a.model.localeCompare(b.model)),
  };
}
