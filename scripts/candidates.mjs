#!/usr/bin/env node
/**
 * What the labs announced that nobody has looked at yet — once.
 *
 *   node scripts/candidates.mjs                  new candidates, last 4 days
 *   node scripts/candidates.mjs --days=10        widen the window
 *   node scripts/candidates.mjs --record         remember what was reported
 *   node scripts/candidates.mjs --all            ignore what was reported before
 *
 * It joins the two channels that found every release in October 2026's
 * updates — the labs' dated changelogs (sweep-changelogs) and their newsroom
 * feeds (check-feeds) — and reports only what it has not reported before.
 *
 * WHY THIS EXISTS
 *
 * scan.yml already ran twice a day, and it did see Claude Haiku 5.5. It said so
 * in the 100th comment on one issue, as a "backlog" line between `capabilities`
 * and `clock`, in a comment that repeated the same list every twelve hours. A
 * report nobody reads is the same as no report. So this one says each thing
 * once, and the workflow gives each day that has news its own issue.
 *
 * WHAT IT DOES NOT DO: add anything. A changelog line or a headline is a lead.
 * The record still needs the lab's own page, its date and a snapshot, and a
 * decision model still has to pass all four parts of TAXONOMY §6a.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const DAYS = Number(arg('days', 4));
const RECORD = process.argv.includes('--record');
const ALL = process.argv.includes('--all');
const SEEN_FILE = 'data/seen-announcements.json';

/** Each channel is a child process, so one that hangs or throws costs only itself. */
function run(script, args) {
  try {
    const out = execFileSync('node', [script, ...args, '--json'], {
      encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (e) {
    return { error: (e.stderr || e.message || String(e)).toString().split('\n')[0] };
  }
}

const sweep = run('scripts/sweep-changelogs.mjs', [`--days=${DAYS}`]);
const feeds = run('scripts/check-feeds.mjs', [`--days=${DAYS}`]);

const seen = new Set(existsSync(SEEN_FILE) ? JSON.parse(readFileSync(SEEN_FILE, 'utf8')).seen : []);
const norm = (s) => String(s).toLowerCase().replace(/&#x27;|&quot;|&amp;/g, '').replace(/\s+/g, ' ').trim();

const LABEL = {
  'new-id': 'prints an API id no record carries',
  decision: 'reads like a decision model or endpoint (TAXONOMY §6a)',
  new: 'announces something, names no tracked model',
};

const items = [];
for (const r of sweep.results ?? []) {
  for (const e of r.entries) {
    if (!e.flag) continue;
    items.push({
      key: `sweep|${r.lab}|${e.date}|${norm(e.text).slice(0, 120)}`,
      date: e.date, lab: r.lab, where: r.url, channel: 'changelog',
      why: e.flag === 'new-id' ? `${LABEL['new-id']}: ${e.newIds.join(', ')}` : LABEL[e.flag],
      text: e.text.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 300),
    });
  }
}
// A tracked model arriving on someone else's platform is distribution, not a
// release: "Grok 4.7 on Microsoft Foundry", "Claude Haiku 5.5 is now available in …".
const RESOLD = /\bis now available (?:in|on)\b|\bon (?:microsoft foundry|amazon bedrock|vertex ai|google cloud)\s*$/i;
for (const f of [...(feeds.found ?? []), ...(feeds.novel ?? [])].filter((x) => !RESOLD.test(x.title))) {
  items.push({
    key: `feed|${f.link || norm(f.title)}`,
    date: new Date(f.date).toISOString().slice(0, 10), lab: f.lab, where: f.link, channel: 'feed',
    why: (feeds.novel ?? []).includes(f) ? 'a newsletter names a lab this dataset does not track' : 'the lab published a launch-shaped post',
    text: f.title,
  });
}

const fresh = items.filter((i) => ALL || !seen.has(i.key)).sort((a, b) => b.date.localeCompare(a.date));

const broken = [
  ...(sweep.error ? [`sweep-changelogs — ${sweep.error}`] : (sweep.unreadable ?? []).map((l) => `${l} changelog — did not answer`)),
  ...(feeds.error ? [`check-feeds — ${feeds.error}`] : (feeds.failed ?? [])),
];

const lines = [];
lines.push(`## ${fresh.length} new candidate${fresh.length === 1 ? '' : 's'}, last ${DAYS} days\n`);
if (!fresh.length) lines.push('_Nothing the labs dated or published that has not been reported before._\n');
for (const i of fresh) {
  lines.push(`- [ ] **${i.lab}** · ${i.date} · ${i.channel} — ${i.why}`);
  lines.push(`  ${i.text}`);
  if (i.where) lines.push(`  ${i.where}`);
}
if (broken.length) {
  lines.push('\n### Channels that did not answer\n');
  for (const b of broken) lines.push(`- ${b}`);
  lines.push('\nA channel that cannot be read is not a quiet day.');
}
lines.push('\n### Still needs a person or an agent\n');
for (const [lab, why] of sweep.blind ?? []) lines.push(`- **${lab}** — ${why}`);
lines.push('\nRun the "update LLM World" routine in CLAUDE.md against these: verify each candidate on the '
  + "lab's own page, take the date it states, and exclude serving tiers, product features and agent "
  + 'products (those are `agent` milestones).');
console.log(lines.join('\n'));

if (RECORD) {
  for (const i of items) seen.add(i.key);
  // Bounded: a key older than the widest window anyone runs is never asked about again.
  const keep = [...seen].slice(-3000);
  writeFileSync(SEEN_FILE, `${JSON.stringify({ note: 'Announcements candidates.mjs has reported. Reported, not tracked.', seen: keep }, null, 2)}\n`);
}

// For the workflow: 0 new means stay quiet.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `count=${fresh.length}\n`, { flag: 'a' });
}
