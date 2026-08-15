/**
 * One date vocabulary, in both directions.
 *
 * Two scripts do the same job from opposite ends:
 *
 *   scripts/draft-from-url.mjs   reads a date OUT of an announcement's prose
 *   scripts/attribute-facts.mjs  generates the written forms of a date we
 *   scripts/verify-facts.mjs     already hold, so it can be found in a source
 *
 * They need the identical vocabulary — the same month names, the same
 * separators, the same idea of what "14 August 2026" looks like — and they had
 * three partial copies of it between them. A vocabulary stored three times
 * eventually disagrees with itself (docs/METHODOLOGY.md §4), and here the
 * disagreement is expensive in a specific way: the parser accepting a form the
 * generator cannot produce means a date is read from a page and then reported
 * as untraceable to that same page.
 *
 * Node and browser alike: no imports, no Node APIs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT MATTERS: 03/04/2026 IS NOT A DATE
 *
 * `03/04/2026` is 3 April to most of the world and 4 March in the United
 * States, and nothing in the string says which. There is no majority to appeal
 * to and no "sensible default" — a default is a coin flip that publishes a
 * release date two months wrong and looks exactly as confident as a correct
 * one. So a purely numeric D/M/Y-or-M/D/Y form whose first two components are
 * both ≤ 12 is REFUSED: `scanDates` reports it as ambiguous with both readings
 * and an `iso` of null, and callers surface it for a person to settle.
 *
 * It is only resolved when something outside the digits settles it:
 *
 *   1. the string disambiguates itself — one component is > 12, so `14/08/2026`
 *      and `08/14/2026` both parse and mean the same day;
 *   2. the two readings are the same day anyway (`05/05/2026`);
 *   3. the page declares a locale that has one convention (`lang="en-US"`);
 *   4. an unambiguous numeric date elsewhere on the same page fixes the order,
 *      and every such sibling agrees.
 *
 * The dot form is refused on the same terms as the slash form. `14.08.2026` is
 * overwhelmingly European and `08.14.2026` is rare, but "rare" is not "never",
 * and the whole point is that the digits cannot tell us which page we are on.
 *
 * The same rule runs backwards in `dateForms`: a numeric slash/dot form is only
 * generated to search for when the day is > 12 and therefore self-evident.
 * Emitting `03/04/2026` as a form for 2026-03-04 would happily "find" it on a
 * page that meant 3 April, and attribute a date to a source that contradicts it.
 */

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A date outside this range is a number that happens to look like one.
 *
 * Announcement pages are dense with figures — the Qwen3.5 post carries whole
 * benchmark tables — and `1234.5.6` is shaped exactly like a dotted date. No
 * language model predates 1990 and none of them is dated after 2100, so the
 * range costs nothing and removes a class of false positive outright.
 */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

/** Written month → 1-12. Accepts full names, three-letter forms, "Sept", "Aug.". */
const MONTH_BY_NAME = new Map();
for (const [i, full] of MONTHS.entries()) {
  MONTH_BY_NAME.set(full.toLowerCase(), i + 1);
  MONTH_BY_NAME.set(full.slice(0, 3).toLowerCase(), i + 1);
}
// The one abbreviation that is neither the full name nor three letters, and the
// one blog.google and arxiv both use.
MONTH_BY_NAME.set('sept', 9);

export function monthIndex(name) {
  return MONTH_BY_NAME.get(String(name).trim().replace(/\.$/, '').toLowerCase()) ?? 0;
}

// Longest alternative first, so "September" is never eaten as "Sep" + "tember"
// and "Sept" is never eaten as "Sep" + "t".
const MONTH_WORD = [...MONTH_BY_NAME.keys()]
  .sort((a, b) => b.length - a.length)
  .join('|');

const ORDINAL = '(?:st|nd|rd|th)';

/* ------------------------------------------------------------------ basics */

/** Real calendar date, in a range a model release could plausibly sit in. */
export function isValidYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < MIN_YEAR || y > MAX_YEAR || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export const toIso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/* ------------------------------------------------------------- day order */

/**
 * Locales whose numeric dates have ONE convention, and which one.
 *
 * Deliberately an allowlist on both sides rather than "US or else". `en-CA` is
 * genuinely mixed and `en` alone does not say which English, so both are absent
 * and both therefore refuse. zh/ja/ko are absent too: they write year-first, so
 * a bare `03/04/2026` on such a page is not evidence of either order — it is
 * far more likely a fragment pasted from somewhere else.
 */
const MONTH_FIRST = new Set(['en-us', 'en-ph', 'en-um']);
const DAY_FIRST = new Set([
  'en-gb', 'en-au', 'en-nz', 'en-ie', 'en-in', 'en-za', 'en-sg', 'en-ng', 'en-ke',
  'fr', 'fr-fr', 'fr-be', 'fr-ch', 'de', 'de-de', 'de-at', 'de-ch',
  'es', 'es-es', 'es-mx', 'es-ar', 'it', 'it-it', 'pt', 'pt-pt', 'pt-br',
  'nl', 'nl-nl', 'nl-be', 'sv', 'sv-se', 'da', 'da-dk', 'nb', 'nn', 'no', 'fi',
  'pl', 'cs', 'sk', 'ro', 'bg', 'el', 'hu', 'hr', 'sr', 'sl', 'uk', 'ru', 'ru-ru',
  'tr', 'tr-tr', 'id', 'id-id', 'ms', 'vi', 'vi-vn', 'th', 'hi', 'bn', 'ta',
  'ar', 'he', 'fa', 'ur',
]);

/** 'mdy' | 'dmy' | null for a BCP 47 tag. null means "this tag does not say". */
export function orderFromLocale(tag) {
  if (!tag) return null;
  const t = String(tag).trim().toLowerCase().replace(/_/g, '-');
  if (MONTH_FIRST.has(t)) return 'mdy';
  if (DAY_FIRST.has(t)) return 'dmy';
  // A region we do not know, but a language we do: de-LI follows de.
  const base = t.split('-')[0];
  if (base !== t) {
    if (MONTH_FIRST.has(base)) return 'mdy';
    if (DAY_FIRST.has(base)) return 'dmy';
  }
  return null;
}

/**
 * The order the page's own markup implies, or null.
 *
 * `<html lang>` first because it describes THIS document. `hreflang` is checked
 * last and only when the page advertises exactly one translation: a site that
 * ships en-US and en-GB links to both from every page, so treating hreflang as
 * a locale declaration would let the wrong sibling decide the date.
 */
export function orderFromHtml(html) {
  if (!html) return null;
  const lang = /<html[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html)?.[1];
  const fromLang = orderFromLocale(lang);
  if (fromLang) return fromLang;

  const og = /<meta[^>]*property\s*=\s*["']og:locale["'][^>]*content\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:locale["']/i.exec(html)?.[1];
  const fromOg = orderFromLocale(og);
  if (fromOg) return fromOg;

  const tags = new Set([...html.matchAll(/\bhreflang\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1].toLowerCase()).filter((t) => t !== 'x-default'));
  if (tags.size === 1) return orderFromLocale([...tags][0]);
  return null;
}

/**
 * The order fixed by the page's own unambiguous numeric dates, or null.
 *
 * A page that writes `14/08/2026` somewhere has told us it is day-first, and
 * that is evidence about the page rather than a guess about the world. If two
 * siblings disagree — which happens on pages that quote other people's
 * datelines — nothing is inferred.
 */
export function orderFromSiblings(text) {
  if (!text) return null;
  let found = null;
  NUMERIC_RE.lastIndex = 0;
  for (const m of String(text).matchAll(NUMERIC_RE)) {
    const [a, b, y] = [Number(m[1]), Number(m[3]), Number(m[4])];
    const dmy = isValidYmd(y, b, a);
    const mdy = isValidYmd(y, a, b);
    if (dmy === mdy) continue;             // both or neither: says nothing
    const order = dmy ? 'dmy' : 'mdy';
    if (found && found !== order) return null;
    found = order;
  }
  return found;
}

/** Explicit order beats the page's markup, which beats its other dates. */
export function resolveOrder({ order = null, html = null, text = null } = {}) {
  return order ?? orderFromHtml(html) ?? orderFromSiblings(text) ?? null;
}

/* --------------------------------------------------------------- patterns */

// Purely numeric, same separator twice. `-` is deliberately NOT a separator
// here: it collides with ISO and with the hyphens labs put in model names, and
// `08-14-2026` is not a form anyone we cite publishes.
//
// The lookaround excludes digits and separators, NOT commas and full stops: a
// date is followed by punctuation constantly ("posted 14/08/2026, updated…"),
// and an earlier version that refused a trailing comma silently stopped seeing
// exactly the dates that were written in a sentence.
const NUMERIC_RE = /(?<![\d./])(\d{1,2})([./])(\d{1,2})\2(\d{4})(?![\d/])/g;

/**
 * Every shape a lab we cite actually publishes.
 *
 * `read` returns `{ y, m, d }`, or `{ ambiguous, readings }` when the digits
 * alone cannot settle it, or null when the numbers are not a date at all.
 */
const PATTERNS = [
  {
    name: 'iso',
    re: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g,
    read: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }),
  },
  {
    // 2026/08/14 and 2026.08.14 — year first, so the remaining two are
    // month-then-day by universal convention.
    name: 'iso-sep',
    re: /(?<![\d./])(\d{4})([./])(\d{1,2})\2(\d{1,2})(?![\d/])/g,
    read: (m) => ({ y: +m[1], m: +m[3], d: +m[4] }),
  },
  {
    // 2026年8月14日 — Chinese and Japanese share this exactly. Qwen, Zhipu and
    // ByteDance all publish Chinese pages, and none of the English patterns
    // sees a character of it.
    name: 'cjk',
    re: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g,
    read: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }),
  },
  {
    name: 'korean',
    re: /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g,
    read: (m) => ({ y: +m[1], m: +m[2], d: +m[3] }),
  },
  {
    // August 14, 2026 · Aug. 14, 2026 · August 14th 2026
    name: 'month-first',
    re: new RegExp(`\\b(${MONTH_WORD})\\.?\\s+(\\d{1,2})${ORDINAL}?\\s*,?\\s*(\\d{4})\\b`, 'gi'),
    read: (m) => ({ y: +m[3], m: monthIndex(m[1]), d: +m[2] }),
  },
  {
    // 14 August 2026 · 14th of August, 2026 · Thu, 14 Aug 2026 (the weekday and
    // comma are simply not part of the match, which is why RFC 822 pubDate
    // needs no pattern of its own).
    name: 'day-first',
    re: new RegExp(`\\b(\\d{1,2})${ORDINAL}?\\s+(?:of\\s+)?(${MONTH_WORD})\\.?,?\\s+(\\d{4})\\b`, 'gi'),
    read: (m) => ({ y: +m[3], m: monthIndex(m[2]), d: +m[1] }),
  },
  {
    name: 'numeric',
    re: NUMERIC_RE,
    read: (m, order) => readNumeric(+m[1], +m[3], +m[4], order),
  },
];

/** The heart of the ambiguity rule. See the header. */
function readNumeric(a, b, y, order) {
  const dmy = { y, m: b, d: a };
  const mdy = { y, m: a, d: b };
  const okDmy = isValidYmd(dmy.y, dmy.m, dmy.d);
  const okMdy = isValidYmd(mdy.y, mdy.m, mdy.d);

  if (okDmy && !okMdy) return dmy;          // 14/08 — the 14 can only be a day
  if (okMdy && !okDmy) return mdy;          // 08/31 — the 31 can only be a day
  if (!okDmy && !okMdy) return null;        // not a date at all
  if (a === b) return dmy;                  // 05/05 — one day either way

  if (order === 'dmy') return dmy;
  if (order === 'mdy') return mdy;
  return {
    ambiguous: true,
    readings: { dmy: toIso(dmy.y, dmy.m, dmy.d), mdy: toIso(mdy.y, mdy.m, mdy.d) },
  };
}

/* ---------------------------------------------------------------- scanning */

/**
 * Every date-shaped run in `text`, in the order they appear.
 *
 * Each entry is `{ text, index, format, iso, ambiguous, readings }`. `iso` is
 * null exactly when `ambiguous` is true; there is no third state and no entry
 * that quietly guessed.
 *
 * Options:
 *   order   'dmy' | 'mdy' — settles numeric forms. Pass `resolveOrder(...)`.
 *
 * Only complete dates are reported. A bare "August 2026" is a month, and a
 * month is not a release date — `dateForms` still generates month-only forms
 * for records whose day is unknown, but nothing here invents a day.
 */
export function scanDates(text, { order = null } = {}) {
  if (!text) return [];
  const src = String(text);
  const hits = [];

  for (const { name, re, read } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const got = read(m, order);
      if (!got) continue;
      if (got.ambiguous) {
        hits.push({
          text: m[0], index: m.index, format: name,
          iso: null, ambiguous: true, readings: got.readings,
        });
        continue;
      }
      if (!isValidYmd(got.y, got.m, got.d)) continue;
      hits.push({
        text: m[0], index: m.index, format: name,
        iso: toIso(got.y, got.m, got.d), ambiguous: false, readings: null,
      });
    }
  }

  // Patterns overlap by design — "2026-08-14" is scanned by more than one — so
  // the longest match wins its span and shorter ones inside it are dropped.
  hits.sort((x, y) => x.index - y.index || y.text.length - x.text.length);
  const kept = [];
  let end = -1;
  for (const h of hits) {
    if (h.index < end) continue;
    kept.push(h);
    end = h.index + h.text.length;
  }
  return kept;
}

/** The first date `text` states unambiguously, or null. */
export function findDate(text, opts) {
  return scanDates(text, opts).find((h) => !h.ambiguous)?.iso ?? null;
}

/** The dates `text` states that CANNOT be settled from the page. */
export function ambiguousDates(text, opts) {
  return scanDates(text, opts).filter((h) => h.ambiguous);
}

/** One trimmed string to ISO, or null. Same rules as the scanner. */
export function parseDate(raw, opts) {
  return findDate(String(raw ?? '').trim(), opts);
}

/** How to say "we refused this one" the same way everywhere. */
export function describeAmbiguity(hit) {
  return `"${hit.text}" is ${hit.readings.dmy} read day-first and ${hit.readings.mdy} `
    + 'read month-first — the page does not say which, so no date was taken from it';
}

/* -------------------------------------------------------------- generating */

/**
 * Every plausible written form of a date we already hold.
 *
 * Used to answer "does this source state this date", so breadth is the point:
 * a form we fail to generate becomes a record that stays partially_verified
 * because blog.google pads the day and we did not.
 *
 * `iso` may be `YYYY-MM` where the day is unknown, in which case month forms
 * are returned and no day is invented.
 *
 * Numeric slash/dot forms are generated ONLY when the day is > 12 and the
 * string therefore reads the same in both conventions — see the header.
 *
 * @param {string} iso `YYYY-MM-DD` or `YYYY-MM`
 * @param {{loose?: boolean}} [opts] `loose` adds the yearless "August 14",
 *   which is right for a whole-page scan and wrong for anything that treats a
 *   hit as attribution: "May 13" occurs on pages about other years.
 */
export function dateForms(iso, { loose = false } = {}) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return [String(iso)];
  const month = MONTHS[m - 1];
  const abbr = month.slice(0, 3);
  const mm = String(m).padStart(2, '0');

  if (!d) {
    return [...new Set([String(iso), `${y}-${mm}`,
      `${month} ${y}`, `${abbr} ${y}`,
      `${y}年${m}月`, `${y}年${mm}月`, `${y}년 ${m}월`, `${y}년 ${mm}월`])];
  }

  const dd = String(d).padStart(2, '0');
  const ord = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd'
    : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
  // "Sept" is the fourth spelling of September and the one arxiv uses.
  const abbrs = m === 9 ? [abbr, 'Sept'] : [abbr];

  const forms = [
    toIso(y, m, d), `${y}/${mm}/${dd}`, `${y}.${mm}.${dd}`,
    `${y}年${m}月${d}日`, `${y}年${mm}月${dd}日`,
    `${y}년 ${m}월 ${d}일`, `${y}년 ${mm}월 ${dd}일`,
  ];

  for (const name of [month, ...abbrs]) {
    for (const dot of name === month ? [''] : ['', '.']) {
      const w = `${name}${dot}`;
      for (const day of [String(d), dd]) {
        forms.push(`${w} ${day}, ${y}`, `${w} ${day} ${y}`, `${day} ${w} ${y}`);
      }
      forms.push(`${w} ${d}${ord}, ${y}`, `${w} ${d}${ord} ${y}`, `${d}${ord} ${w} ${y}`);
    }
    if (loose) forms.push(`${name} ${d}`, `${name} ${dd}`);
  }

  // Self-disambiguating numerics only.
  if (d > 12) {
    forms.push(`${dd}/${mm}/${y}`, `${mm}/${dd}/${y}`, `${d}/${m}/${y}`, `${m}/${d}/${y}`,
      `${dd}.${mm}.${y}`, `${mm}.${dd}.${y}`);
  }

  return [...new Set(forms)];
}
