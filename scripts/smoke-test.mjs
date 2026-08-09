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
  if (current.length !== 1) fail(page, `expected exactly 1 aria-current="page", found ${current.length}`);

  // The active marker must sit inside the nav, not on the brand logo.
  const nav = html.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';
  if (!nav.includes('aria-current="page"')) fail(page, 'active nav marker is outside the nav');

  if (!/<footer class="site-footer">/.test(html)) fail(page, 'missing shared footer');
}

/* -------------------------------------------------------------- 5. sources */

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

const shown = fails.slice(0, 25);
for (const f of shown) console.error(`  FAIL  ${f}`);
if (fails.length > shown.length) console.error(`  … and ${fails.length - shown.length} more`);

console.log(`\nchecked ${pages.length} pages`);
if (fails.length) {
  console.error(`FAILED — ${fails.length} problem${fails.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('OK — inline scripts parse, links resolve, chrome is consistent');
