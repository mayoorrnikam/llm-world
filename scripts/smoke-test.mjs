#!/usr/bin/env node
/**
 * Structural smoke test for the built site. No dependencies, no browser.
 *
 *   node scripts/smoke-test.mjs        (run `npm run build` first)
 *
 * Exists because three classes of bug reached the live site:
 *
 *   1. A syntax error in the compare page's inline module — a `params`
 *      helper shadowed `URLSearchParams` — which killed the whole page and
 *      rendered an empty shell. Every inline script is now syntax-checked.
 *   2. A dialog link left at the placeholder href="#", which did nothing
 *      when clicked. Placeholder hrefs now fail the build.
 *   3. Nav drift between the app and the generated pages, with the wrong
 *      section marked. Shared chrome is now asserted on every page.
 *
 * Exits non-zero on any failure.
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { logoSlug } from '../lib/record.mjs';

const fails = [];
const fail = (page, msg) => fails.push(`${page}: ${msg}`);

/* -------------------------------------------------------------- discovery */

function htmlFiles(dir = '.', acc = []) {
  for (const name of readdirSync(dir)) {
    if (['.git', 'node_modules', '.github', 'data', 'scripts', '.build-check'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) htmlFiles(full, acc);
    else if (extname(full) === '.html') acc.push(full);
  }
  return acc;
}

/** The sections the shared nav actually links to, read from its one source. */
const NAV_SECTIONS = new Set(
  [...(/<nav class="main-nav"[\s\S]*?<\/nav>/.exec(readFileSync('index.html', 'utf8'))?.[0] ?? '')
    .matchAll(/href="([^"#?]+)"/g)].map((m) => m[1]).filter((h) => h && h !== '/'),
);

const pages = htmlFiles();
if (pages.length < 10) {
  console.error(`FATAL: only ${pages.length} HTML files found — run \`npm run build\` first`);
  process.exit(1);
}

/* ------------------------------------------------------ 1. inline scripts */

/** The check that would have caught the compare crash. */
function checkInlineScripts(page, html) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  scripts.forEach(([, attrs, code], i) => {
    if (/type="application\/ld\+json"/.test(attrs)) {
      try { JSON.parse(code); } catch (e) { fail(page, `JSON-LD block ${i} is invalid: ${e.message}`); }
      return;
    }
    if (!code.trim()) return;
    const isModule = /type="module"/.test(attrs);
    const tmp = `.smoke-${process.pid}-${i}.${isModule ? 'mjs' : 'js'}`;
    try {
      writeFileSync(tmp, code);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message).split('\n').find((l) => /Error/.test(l));
      fail(page, `inline script ${i} has a syntax error — ${msg?.trim() ?? 'see node --check'}`);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  });
}

/* ----------------------------------------------------- 2. dead placeholders */

function checkPlaceholders(page, html) {
  // href="#" is a link that silently does nothing when clicked.
  for (const [, tag] of html.matchAll(/(<a\b[^>]*href="#"[^>]*>)/g)) {
    fail(page, `placeholder href="#" — links must resolve: ${tag.slice(0, 90)}`);
  }
  for (const [, tag] of html.matchAll(/(<a\b[^>]*href=""[^>]*>)/g)) {
    fail(page, `empty href: ${tag.slice(0, 90)}`);
  }
}

/* --------------------------------------------------- 3. internal link graph */

function checkLinks(page, html) {
  const base = dirname(page);
  for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^(https?:|data:|mailto:|#|javascript:)/.test(href)) continue;
    const [path] = href.split(/[?#]/);
    if (!path) continue;
    let target = resolve(base, path);
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
    if (!existsSync(target)) fail(page, `broken internal link → ${href}`);
  }
}

/* ------------------------------------------------------- 4. shared chrome */

function checkChrome(page, html) {
  if (!/<title>[^<]+<\/title>/.test(html)) fail(page, 'missing or empty <title>');

  const navs = html.match(/<nav class="main-nav"/g) ?? [];
  if (navs.length !== 1) fail(page, `expected exactly 1 shared nav, found ${navs.length}`);

  const current = html.match(/aria-current="page"/g) ?? [];
  // A page marks a nav item current only if it IS one of the nav's sections.
  // The landing page is not — it is the thing the nav hangs off — and neither
  // are the reference documents, which are reached from the footer. The rule
  // used to be "every page but index.html", which failed /methodology/ and
  // /taxonomy/ for correctly marking nothing. What it is really guarding is
  // drift between the nav and the page, so it asks the nav which sections
  // exist rather than assuming every page is one.
  const inNav = NAV_SECTIONS.has(page.split('/')[0] + '/');
  if (page === 'index.html') {
    if (current.length) fail(page, 'landing page should not mark a nav section current');
  } else if (inNav && current.length !== 1) {
    fail(page, `expected exactly 1 aria-current="page", found ${current.length}`);
  } else if (current.length > 1) {
    fail(page, `expected at most 1 aria-current="page", found ${current.length}`);
  }
  // Pages that are not themselves a nav section may still mark their parent —
  // /milestones/ marks Timeline — so they are allowed 0 or 1, never more.

  // The active marker must sit inside the nav, not on the brand logo.
  const nav = html.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  if (inNav && !nav.includes('aria-current="page"')) {
    fail(page, 'active nav marker is outside the nav');
  }

  if (!/<footer class="site-footer">/.test(html)) fail(page, 'missing shared footer');
}

/* -------------------------------------------------------------- 5. sources */

/**
 * Blanks out comments and string literals, leaving code positions intact.
 *
 * A scanner rather than a regex chain, because the regex version was wrong in a
 * way worth remembering: `const API = 'https://archive.org/…'` contains `//`,
 * so a line-comment pattern deleted the rest of the line — including the
 * closing quote. Every quote after that paired up shifted by one, and whole
 * declarations vanished from what the check believed was the code. It reported
 * archive-sources.mjs as using an unimported `FAILED` that is declared on line
 * 62. Splitting code from strings needs state, not pattern matching.
 *
 * Regex literals have to be skipped too, and for the same reason as strings
 * rather than a different one: detect-modalities.mjs matches contractions with
 * /does\s?n[o']?t have other senses/i. That apostrophe reads as an opening
 * quote, and everything to the next quote — most of the file, including its
 * writeFileSync — disappears. Telling a regex from division needs the previous
 * token, which is the one piece of context a scanner can cheaply keep.
 */
function stripNonCode(src) {
  let out = '', i = 0;
  const at = (s) => src.startsWith(s, i);
  // Last significant code character emitted; decides `/` = regex vs division.
  let prev = '';
  const REGEX_OK = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
  while (i < src.length) {
    if (src[i] === '/' && !at('//') && !at('/*')
        && (REGEX_OK.has(prev) || /\b(?:return|typeof|case|in|of|new|delete|void|do|else)$/.test(out.trimEnd()))) {
      // Walk the literal, honouring escapes and character classes (where an
      // unescaped `/` is legal and must not end it).
      let j = i + 1, klass = false, closed = false;
      for (; j < src.length && src[j] !== '\n'; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '[') klass = true;
        else if (src[j] === ']') klass = false;
        else if (src[j] === '/' && !klass) { closed = true; break; }
      }
      if (closed) {
        while (j + 1 < src.length && /[dgimsuvy]/.test(src[j + 1])) j++;
        out += src.slice(i, j + 1).replace(/[^\n]/g, ' ');
        i = j + 1;
        prev = 'x'; // a value, so a following `/` is division
        continue;
      }
      // Not a literal after all — fall through and treat it as an operator.
    }
    if (at('/*')) {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      // Keep newlines so line-anchored patterns still behave.
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (at('//')) {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, Math.min(j + 1, src.length)).replace(/[^\n]/g, ' ');
      i = j + 1;
      prev = 'x'; // a string is a value: a following `/` divides
    } else {
      if (!/\s/.test(src[i])) prev = src[i];
      out += src[i++];
    }
  }
  return out;
}

/**
 * Names a script uses from lib/ must actually be imported.
 *
 * This is the check that would have caught the real bug. Rewiring the
 * extractors deleted attribute-facts.mjs's import line; the file still parsed,
 * and running it with --limit=0 still passed, because the loop body that uses
 * those names never executed. Only a caller with real work to do would have
 * hit it — in other words, production.
 *
 * So this looks for shared helpers used in a file and asserts each is imported.
 * Cheap, and it fails on exactly the mistake that was made.
 */
function checkLibImports() {
  const exported = new Set(
    [...readFileSync('lib/record.mjs', 'utf8').matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1])
      .concat([...readFileSync('lib/source-text.mjs', 'utf8').matchAll(/export (?:function|const) (\w+)/g)].map((m) => m[1]))
      .concat(['FAILED', 'sourceText']),
  );

  for (const file of readdirSync('scripts').filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`)) {
    const src = readFileSync(file, 'utf8');
    const imported = new Set(
      [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*lib\/[^']*'/g)]
        .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)),
    );
    const code = stripNonCode(src);

    for (const name of exported) {
      if (imported.has(name)) continue;
      // Declared locally under the same name is fine.
      if (new RegExp(`(?:function|const|let|var)\\s+${name}\\b`).test(code)) continue;
      if (new RegExp(`\\b${name}\\s*\\(`).test(code) || new RegExp(`\\b${name}\\b`).test(code)) {
        fail(file, `uses "${name}" from lib/ but never imports it — this parses, and fails at runtime`);
      }
    }
  }
}

/**
 * Every company in the dataset must have its own logo and hue.
 *
 * Ai2 and MiniMax were added to the data and shipped with the generic "other"
 * mark, because the company → slug map existed in three files and adding a lab
 * only ever updated the dataset. Nothing failed; the labs just quietly looked
 * like nobody's. That is a design regression the build could not see.
 *
 * The colour token is checked in all three places CLAUDE.md requires it —
 * bare :root, prefers-color-scheme: dark, and [data-theme="dark"] — so an
 * explicit theme choice cannot fall back to a hue that was only half added.
 */
function checkCompanyLogos() {
  const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
  const sprite = readFileSync('sprite.svg', 'utf8');
  const css = readFileSync('styles.css', 'utf8');

  for (const company of [...new Set(data.releases.map((r) => r.company))].sort()) {
    const slug = logoSlug(company);
    if (slug === 'other') {
      fail('sprite.svg', `"${company}" has no logo — add it to COMPANY_SLUG in lib/record.mjs`);
      continue;
    }
    if (!sprite.includes(`<g id="ic-${slug}"`)) {
      fail('sprite.svg', `"${company}" maps to ic-${slug}, which is not in the sprite`);
    }
    const declared = (css.match(new RegExp(`--c-${slug}\\s*:`, 'g')) ?? []).length;
    if (declared < 3) {
      fail('styles.css', `--c-${slug} is declared ${declared}× — needs :root, `
        + `prefers-color-scheme: dark and [data-theme="dark"] (${company})`);
    }
  }
}

/**
 * A script that accepts --write must contain a write.
 *
 * hf-metadata.mjs read --write, mutated the records, counted them and printed
 * "wrote data/llm-releases.json" — with no writeFileSync anywhere in the file.
 * It ran clean, reported success, and changed nothing; `npm run enrich` called
 * it that way for weeks. Nothing else could catch this: the exit code is 0, the
 * output is a success report, and the dataset it claims to have edited is
 * simply unchanged. The only observable is the missing call itself.
 */
function checkWriteScripts() {
  for (const file of readdirSync('scripts').filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`)) {
    const code = stripNonCode(readFileSync(file, 'utf8'));
    if (!/--write/.test(readFileSync(file, 'utf8'))) continue;
    if (!/\bwriteFileSync\s*\(/.test(code)) {
      fail(file, 'takes --write but never calls writeFileSync — it reports a write it does not perform');
    }
  }
}

/**
 * Every data script must actually RUN, not merely parse.
 *
 * Rewiring the extractors once deleted the entire top of attribute-facts.mjs —
 * imports, constants and a helper — and `node --check` passed, because what
 * remained was still valid JavaScript. A syntax check cannot see a missing
 * import or an undefined constant; only executing the file can.
 *
 * `--limit=0` exercises every module-level line and then does no work: no
 * network, no writes, no dependence on what is in the dataset today. A script
 * that has been gutted fails here in under a second.
 */
function checkScriptsRun() {
  const scripts = [
    'attribute-facts', 'detect-modalities', 'detect-capabilities', 'detect-undisclosed',
    'extract-pricing', 'extract-benchmarks', 'hf-metadata', 'archive-sources',
    'state-reasons', 'discover-epoch', 'add-model', 'split-record',
  ];
  for (const name of scripts) {
    const file = `scripts/${name}.mjs`;
    if (!existsSync(file)) { fail(file, 'missing'); continue; }
    try {
      execFileSync(process.execPath, [file, '--limit=0'], {
        stdio: 'pipe',
        timeout: 30000,
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      // add-model and split-record need a spec and exit 1 without one; that is
      // them working. Anything else is a script that cannot start.
      const err = (e.stderr?.toString() || '').trim();
      if (/^usage:/m.test(err) || /missing epoch-notable-models\.csv/.test(err)) continue;
      const first = err.split('\n').find((l) => /Error|error/.test(l)) ?? `exit ${e.status}`;
      fail(file, `does not run — ${first.trim().slice(0, 120)}`);
    }
  }
}

function checkStandaloneScripts() {
  for (const f of ['app.js', 'scripts/build.mjs', 'scripts/validate-data.mjs', 'scripts/serve.mjs']) {
    if (!existsSync(f)) { fail(f, 'missing'); continue; }
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      fail(f, `syntax error — ${(e.stderr?.toString() || '').split('\n')[4]?.trim() ?? 'see node --check'}`);
    }
  }
}

/* ------------------------------------------------------------------- run */

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  checkInlineScripts(page, html);
  checkPlaceholders(page, html);
  checkLinks(page, html);
  checkChrome(page, html);
}
checkStandaloneScripts();
checkScriptsRun();
checkLibImports();
checkWriteScripts();
checkCompanyLogos();

const shown = fails.slice(0, 25);
for (const f of shown) console.error(`  FAIL  ${f}`);
if (fails.length > shown.length) console.error(`  … and ${fails.length - shown.length} more`);

console.log(`\nchecked ${pages.length} pages`);
if (fails.length) {
  console.error(`FAILED — ${fails.length} problem${fails.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('OK — inline scripts parse, links resolve, chrome is consistent');
