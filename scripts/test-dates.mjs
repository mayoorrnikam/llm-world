#!/usr/bin/env node
/**
 * Assertions for lib/dates.mjs. No framework, no dependencies.
 *
 *   node scripts/test-dates.mjs
 *
 * Exits non-zero on the first suite that fails, and `npm run smoke` runs it, so
 * a broken date parser fails the gate rather than a release date.
 *
 * The cases below are not invented shapes. They are the forms found on the
 * pages this dataset actually cites — huggingface.co model cards, anthropic.com
 * and blog.google announcements, arxiv abstracts, RSS pubDates, and the Chinese
 * pages Qwen, Zhipu and ByteDance publish alongside their English ones.
 *
 * The REFUSALS matter more than the parses. Every case in "ambiguous" is a
 * string that a helpful parser would happily turn into a wrong release date.
 */

import {
  scanDates, findDate, parseDate, dateForms, monthIndex, isValidYmd,
  orderFromLocale, orderFromHtml, orderFromSiblings, resolveOrder, describeAmbiguity,
} from '../lib/dates.mjs';

let failed = 0;
let checks = 0;
let suite = '';

const show = (v) => (v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function is(actual, expected, what) {
  checks++;
  if (show(actual) === show(expected)) return;
  failed++;
  console.error(`  FAIL  ${suite}: ${what}\n        expected ${show(expected)}\n        got      ${show(actual)}`);
}

function ok(cond, what) {
  is(Boolean(cond), true, what);
}

const group = (name, fn) => { suite = name; fn(); };

/* ------------------------------------------------------------------ parse */

group('ISO', () => {
  is(parseDate('2026-08-14'), '2026-08-14', 'ISO');
  is(parseDate('2026-8-4'), '2026-08-04', 'unpadded ISO');
  is(parseDate('2026/08/14'), '2026-08-14', 'slashed year-first');
  is(parseDate('2026.08.14'), '2026-08-14', 'dotted year-first');
  is(parseDate('2026-08-14T09:30:00Z'), '2026-08-14', 'ISO timestamp');
  is(findDate('Published 2026-02-14 04:00:00 +0800 CST'), '2026-02-14', 'qwen.ai dateline');
});

group('US', () => {
  is(parseDate('August 14, 2026'), '2026-08-14', 'Month D, YYYY');
  is(parseDate('Aug 14, 2026'), '2026-08-14', 'Mon D, YYYY');
  is(parseDate('Aug. 14, 2026'), '2026-08-14', 'Mon. D, YYYY');
  is(parseDate('August 14 2026'), '2026-08-14', 'no comma');
  is(parseDate('Jun 03, 2026'), '2026-06-03', 'blog.google padded day');
  is(parseDate('Sept 4, 2026'), '2026-09-04', 'Sept');
  is(parseDate('Sep. 4, 2026'), '2026-09-04', 'Sep.');
  is(parseDate('08/14/2026'), '2026-08-14', 'M/D/YYYY, day > 12 so self-evident');
});

group('UK/EU', () => {
  is(parseDate('14 August 2026'), '2026-08-14', 'D Month YYYY');
  is(parseDate('14 Aug 2026'), '2026-08-14', 'D Mon YYYY');
  is(parseDate('14 Aug. 2026'), '2026-08-14', 'D Mon. YYYY');
  is(parseDate('14/08/2026'), '2026-08-14', 'D/M/YYYY, day > 12 so self-evident');
  is(parseDate('14.08.2026'), '2026-08-14', 'D.M.YYYY, day > 12 so self-evident');
});

group('RFC 822 pubDate', () => {
  is(parseDate('Thu, 14 Aug 2026'), '2026-08-14', 'RSS pubDate, no time');
  is(parseDate('Thu, 14 Aug 2026 09:00:00 GMT'), '2026-08-14', 'RSS pubDate, full');
  is(parseDate('Mon, 02 May 2022 00:00:00 +0000'), '2022-05-02', 'padded day, GMT offset');
});

group('CJK', () => {
  is(parseDate('2026年8月14日'), '2026-08-14', 'Chinese');
  is(parseDate('2026年08月14日'), '2026-08-14', 'Chinese, padded');
  is(parseDate('发布于 2026 年 8 月 14 日'), '2026-08-14', 'Chinese with spaces');
  is(parseDate('2026年8月14日'), '2026-08-14', 'Japanese (identical shape)');
  is(parseDate('2026년 8월 14일'), '2026-08-14', 'Korean');
  is(parseDate('2026년 08월 14일'), '2026-08-14', 'Korean, padded');
});

group('ordinals', () => {
  is(parseDate('14th August 2026'), '2026-08-14', 'Dth Month YYYY');
  is(parseDate('August 14th, 2026'), '2026-08-14', 'Month Dth, YYYY');
  is(parseDate('1st September 2026'), '2026-09-01', '1st');
  is(parseDate('2nd September 2026'), '2026-09-02', '2nd');
  is(parseDate('3rd September 2026'), '2026-09-03', '3rd');
  is(parseDate('the 14th of August 2026'), '2026-08-14', '"of" between day and month');
});

/* -------------------------------------------------------------- ambiguity */

group('ambiguous — must refuse', () => {
  for (const raw of ['03/04/2026', '3/4/2026', '03.04.2026', '01/02/2026', '12/11/2026', '11/12/2026']) {
    is(parseDate(raw), null, `${raw} refused with no locale`);
    const [hit] = scanDates(raw);
    ok(hit?.ambiguous, `${raw} reported as ambiguous`);
    ok(hit?.readings?.dmy !== hit?.readings?.mdy, `${raw} carries two distinct readings`);
  }
  const [hit] = scanDates('03/04/2026');
  is(hit.readings, { dmy: '2026-04-03', mdy: '2026-03-04' }, 'both readings reported');
  ok(/2026-04-03/.test(describeAmbiguity(hit)) && /2026-03-04/.test(describeAmbiguity(hit)),
    'the refusal explains itself');

  is(findDate('Released 03/04/2026 by the lab.'), null, 'an ambiguous date in prose yields nothing');
});

group('ambiguity settled by evidence, never by default', () => {
  is(parseDate('03/04/2026', { order: 'dmy' }), '2026-04-03', 'day-first hint');
  is(parseDate('03/04/2026', { order: 'mdy' }), '2026-03-04', 'month-first hint');
  is(parseDate('05/05/2026'), '2026-05-05', 'same day either way, so not ambiguous');
  is(parseDate('31/12/2026'), '2026-12-31', '31 can only be a day');
  is(parseDate('12/31/2026'), '2026-12-31', 'and the other way round');

  is(orderFromLocale('en-US'), 'mdy', 'en-US is month-first');
  is(orderFromLocale('en-GB'), 'dmy', 'en-GB is day-first');
  is(orderFromLocale('de-LI'), 'dmy', 'unknown region falls back to the language');
  is(orderFromLocale('en'), null, '"en" does not say which English');
  is(orderFromLocale('en-CA'), null, 'Canada is genuinely mixed');
  is(orderFromLocale('zh-CN'), null, 'a year-first locale says nothing about D/M order');

  is(orderFromHtml('<html lang="en-US">'), 'mdy', 'lang attribute');
  is(orderFromHtml('<html lang="en"><meta property="og:locale" content="en_GB">'), 'dmy', 'og:locale');
  is(orderFromHtml('<html lang="en"><link rel="alternate" hreflang="en-US" href="/us">'), 'mdy',
    'a single hreflang');
  is(orderFromHtml('<html lang="en"><link hreflang="en-US"><link hreflang="en-GB">'), null,
    'two hreflangs cannot decide between themselves');
  is(orderFromHtml('<html lang="en">'), null, 'no signal at all');

  is(orderFromSiblings('posted 14/08/2026, updated 03/04/2026'), 'dmy', 'an unambiguous sibling');
  is(orderFromSiblings('posted 08/14/2026, updated 03/04/2026'), 'mdy', 'the other way');
  is(orderFromSiblings('posted 14/08/2026 and 08/14/2026'), null, 'siblings that disagree decide nothing');
  is(orderFromSiblings('posted 03/04/2026'), null, 'no unambiguous sibling');

  is(findDate('posted 14/08/2026, updated 03/04/2026',
    { order: resolveOrder({ text: 'posted 14/08/2026, updated 03/04/2026' }) }),
  '2026-08-14', 'the sibling settles the page');
  is(resolveOrder({ order: 'mdy', html: '<html lang="en-GB">' }), 'mdy', 'explicit beats markup');
  is(resolveOrder({ html: '<html lang="en-GB">', text: '08/14/2026' }), 'dmy', 'markup beats siblings');
  is(resolveOrder({}), null, 'nothing in, nothing out');
});

/* ------------------------------------------------------------- non-dates */

group('not dates', () => {
  is(parseDate('32/08/2026'), null, 'no 32nd day');
  is(parseDate('2026-02-30'), null, 'February has no 30th');
  is(parseDate('2026-13-01'), null, 'no 13th month');
  is(parseDate('1234.5.6'), null, 'a table figure, not a year');
  is(parseDate('v0.30.3'), null, 'a version string');
  is(parseDate('HMMT Feb 25 99.4 92.9'), null, 'a benchmark row is not a dateline');
  is(parseDate('August 2026'), null, 'a bare month is not a release date');
  is(parseDate('Qwen3.5-397B-A17B'), null, 'a model name');
  is(parseDate('53.9 33.5 29.5 46.1'), null, 'benchmark scores');
  is(findDate('scores 43.8 43.5 36.4 18.8 27.8 38.3'), null, 'a whole row of them');
});

/* ---------------------------------------------------------------- scanning */

group('scanning prose', () => {
  const text = 'Announced August 14, 2026. Knowledge cutoff 2026-02-01. Updated 14 Sept 2026.';
  const found = scanDates(text).map((h) => h.iso);
  is(found, ['2026-08-14', '2026-02-01', '2026-09-14'], 'every date, in the order written');
  is(scanDates(text)[0].format, 'month-first', 'the format is reported');

  // Overlapping patterns must not double-count one date.
  is(scanDates('2026-08-14').length, 1, 'one date, one hit');
  is(scanDates('Thu, 14 Aug 2026').length, 1, 'the weekday is not a second date');

  const mixed = scanDates('2026年8月14日 / August 14, 2026 / 14.08.2026');
  is(mixed.map((h) => h.iso), ['2026-08-14', '2026-08-14', '2026-08-14'],
    'the same day in three scripts');
});

/* -------------------------------------------------------------- generating */

group('dateForms', () => {
  const f = dateForms('2026-08-14');
  for (const want of [
    '2026-08-14', '2026/08/14',
    'August 14, 2026', 'August 14 2026', 'Aug 14, 2026', 'Aug. 14, 2026',
    '14 August 2026', '14 Aug 2026', '14 Aug. 2026',
    'August 14th, 2026', '14th August 2026',
    '2026年8月14日', '2026년 8월 14일',
    '14/08/2026', '08/14/2026', '14.08.2026',
  ]) ok(f.includes(want), `generates "${want}"`);

  const padded = dateForms('2026-06-03');
  for (const want of ['Jun 03, 2026', 'June 3, 2026', '03 June 2026', '3rd June 2026', '2026年6月3日']) {
    ok(padded.includes(want), `generates "${want}"`);
  }
  // The generator obeys the same refusal as the parser: 03/06/2026 would be
  // "found" on a page that meant 3 June, and attributed to it as 6 March.
  ok(!padded.some((x) => /^\d{1,2}[./]\d{1,2}[./]\d{4}$/.test(x)),
    'no bare numeric form when the day is <= 12');

  ok(dateForms('2026-08-14').every((x) => typeof x === 'string' && x.length),
    'every form is a usable string');

  const sept = dateForms('2026-09-04');
  ok(sept.includes('Sept 4, 2026') && sept.includes('Sept. 4, 2026'), 'Sept is spelled out too');

  const monthOnly = dateForms('2026-08');
  is(monthOnly.includes('August 2026'), true, 'month-only records get month forms');
  ok(!monthOnly.some((x) => /14/.test(x)), 'and no day is invented');

  ok(dateForms('2026-08-14', { loose: true }).includes('August 14'), 'loose adds the yearless form');
  ok(!dateForms('2026-08-14').includes('August 14'), 'and strict does not');
});

/* ----------------------------------------------------- round trip, the point */

group('parse and generate agree', () => {
  // Anything the generator emits, the parser must read back to the same day.
  // A form one side knows and the other does not is how a date gets read off a
  // page and then reported as untraceable to that same page.
  for (const iso of ['2026-08-14', '2026-06-03', '2026-09-04', '2024-05-13', '2022-05-02', '2026-12-31']) {
    for (const form of dateForms(iso)) {
      const back = parseDate(form);
      if (back !== iso) is(back, iso, `round trip "${form}"`);
      else checks++;
    }
  }
});

group('helpers', () => {
  is(monthIndex('September'), 9, 'full name');
  is(monthIndex('Sept.'), 9, 'abbreviation with a full stop');
  is(monthIndex('AUG'), 8, 'case insensitive');
  is(monthIndex('Fructidor'), 0, 'not a month');
  is(isValidYmd(2026, 2, 29), false, '2026 is not a leap year');
  is(isValidYmd(2024, 2, 29), true, '2024 is');
  is(isValidYmd(1200, 1, 1), false, 'before any language model');
});

/* -------------------------------------------------------------------- run */

console.log(`\n${checks} checks`);
if (failed) {
  console.error(`FAILED — ${failed} assertion${failed === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('OK — every format parses, and every ambiguous form is refused');
