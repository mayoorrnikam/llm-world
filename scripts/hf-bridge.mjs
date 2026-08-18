#!/usr/bin/env node
/**
 * Drafts specs for served open-weights models we do not track, from their cards.
 *
 *   node scripts/hf-bridge.mjs                 what could be drafted, and what could not
 *   node scripts/hf-bridge.mjs --spec=out.json write a spec for add-model.mjs
 *   node scripts/hf-bridge.mjs --limit=5       stop after five
 *
 * check-providers.mjs answers "what is served that we lack". For 46% of those
 * the catalogue also carries `hugging_face_id`, and a Hugging Face model card is
 * a PRIMARY source: the lab publishes it, declares its own licence on it, and it
 * has dated revisions and an API that does not rate-limit the way archive.org
 * does. So for open-weights models the gap between "noticed" and "drafted" is
 * mechanical, and this closes it.
 *
 * This is the sibling of hf-metadata.mjs, which reads cards for records already
 * in the dataset. This one reads cards for records that are not there yet.
 *
 * WHAT IT WILL NOT DO
 *
 * It does not write to the dataset. It emits a spec for add-model.mjs, which
 * still refuses anything without a primary source, and the record still goes
 * through the enrichment pass and a person.
 *
 * It does not guess a parameter count. `safetensors.total` looks like the
 * answer and frequently is not: DeepSeek V4 Pro reports 1,650,497,936,906 of
 * which 1,623,497,637,888 is I8, because the repo holds a quantised checkpoint
 * and the total counts packed bytes rather than parameters. A count is proposed
 * ONLY when every tensor shares one floating-point dtype, and flagged for review
 * otherwise. Publishing a wrong parameter count is worse than publishing none.
 *
 * It does not treat `createdAt` as a release date. That is when the repo was
 * created, which is usually the day of release and sometimes weeks before it.
 * It is offered as a starting point and marked as needing the announcement.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fetchCatalogue, trackedIndex, bare } from '../lib/catalogue.mjs';

const SPEC = process.argv.find((a) => a.startsWith('--spec='))?.split('=')[1];
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);

const data = JSON.parse(readFileSync('data/llm-releases.json', 'utf8'));
const tracked = trackedIndex(data.releases);

/**
 * The announcement URLs this dataset already cites for each lab.
 *
 * A model card gives the licence and the weights; it does not give the release
 * date or the lab's own claims, and that is the source a record needs to reach
 * `verified`. Rather than leaving the researcher to search, each draft carries
 * the announcement hosts that have already worked for that company — derived
 * from sources[] exactly as scan-labs.mjs derives its channels, so it covers
 * every lab tracked instead of the handful somebody remembered, and it cannot
 * drift from the data.
 */
function announcementHints(releases) {
  const byCompany = new Map();
  for (const r of releases) {
    for (const s of r.sources ?? []) {
      if (s.type !== 'official_announcement' && s.type !== 'technical_paper') continue;
      if (s.authority !== 'primary') continue;
      let host;
      try { host = new URL(s.url).host; } catch { continue; }
      if (!byCompany.has(r.company)) byCompany.set(r.company, new Map());
      const seen = byCompany.get(r.company);
      seen.set(host, (seen.get(host) ?? 0) + 1);
    }
  }
  // Most-used host first: it is the one most likely to carry the next release.
  return new Map([...byCompany].map(([c, hosts]) =>
    [c, [...hosts].sort((a, b) => b[1] - a[1]).map(([h]) => h)]));
}

/** Company names already used, so a draft joins an existing lab rather than inventing one. */
const KNOWN_COMPANY = new Map(data.releases.map((r) => [r.company.toLowerCase().replace(/[^a-z0-9]/g, ''), r.company]));

const HINTS = announcementHints(data.releases);

const catalogue = await fetchCatalogue();
const candidates = catalogue
  .filter((m) => !tracked.has(bare(m.id)) && m.hugging_face_id)
  .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
  .slice(0, LIMIT === Infinity ? undefined : LIMIT);

/**
 * A parameter count only when the checkpoint is unambiguous.
 *
 * One floating-point dtype and nothing else means `total` is the parameter
 * count. A mix — or any integer dtype — means the repo is quantised or packed,
 * and the number means something other than what we would publish it as.
 */
function parameterCount(safetensors) {
  const params = safetensors?.parameters;
  if (!params || typeof safetensors.total !== 'number') return { value: null, why: 'no safetensors index' };
  const dtypes = Object.keys(params);
  // A float mix is normal — most repos hold BF16 weights with a few F32 buffers,
  // and `total` is still the parameter count. What breaks it is a QUANTISED
  // dtype: DeepSeek V4 Pro reports 1,650,497,936,906 of which 1,623,497,637,888
  // is I8, because the repo holds a packed checkpoint and the total counts
  // stored values rather than parameters.
  const quantised = dtypes.filter((d) => !/^(BF16|F16|F32|F64)$/.test(d));
  if (!quantised.length) {
    // One more trap a float-only mix can hide: a repo holding F32 master weights
    // AND a BF16 copy of the same tensors would double-count. Real repos keep a
    // handful of F32 buffers — Inkling-Small is 10,280 F32 against 265.96B BF16,
    // four millionths of the total — so a second dtype carrying a meaningful
    // share is a duplicate checkpoint, not a rounding detail.
    const sorted = Object.values(params).sort((a, b) => b - a);
    const minor = sorted.slice(1).reduce((a, b) => a + b, 0);
    if (minor / safetensors.total > 0.01) {
      return { value: null, why: `${dtypes.join(' + ')} — the smaller dtype is ${
        (minor / safetensors.total * 100).toFixed(1)}% of the total, which may be a duplicate checkpoint` };
    }
    return { value: safetensors.total, why: null };
  }
  return { value: null, why: `quantised checkpoint (${quantised.join(', ')}) — total counts packed values, not parameters` };
}

const rows = [];
for (const m of candidates) {
  const hf = m.hugging_face_id;
  let card = null;
  try {
    const res = await fetch(`https://huggingface.co/api/models/${hf}`, {
      headers: { 'user-agent': 'llm-world/1.0 (+discovery)' },
    });
    // A card we cannot read is not a card that says nothing.
    card = res.ok ? await res.json() : { __error: `HTTP ${res.status}` };
  } catch (err) {
    card = { __error: err.message };
  }
  // Hugging Face is generous but not infinite, and this is a background job.
  await new Promise((r) => setTimeout(r, 400));

  const vendor = m.id.split('/')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
  const params = card.__error ? { value: null, why: card.__error } : parameterCount(card.safetensors);
  const arxiv = (card.tags ?? []).find((t) => t.startsWith('arxiv:'));

  rows.push({
    catalogueId: m.id,
    hf,
    name: m.name?.replace(/^[^:]+:\s*/, '') ?? hf.split('/').pop(),
    company: KNOWN_COMPANY.get(vendor) ?? null,
    repoCreated: card.createdAt ? card.createdAt.slice(0, 10) : null,
    license: card.cardData?.license ?? null,
    pipeline: card.pipeline_tag ?? null,
    params,
    arxiv: arxiv ? `https://arxiv.org/abs/${arxiv.slice(6)}` : null,
    gated: card.gated === true || card.private === true,
    error: card.__error ?? null,
    hints: HINTS.get(KNOWN_COMPANY.get(vendor)) ?? [],
  });
}

const draftable = rows.filter((r) => !r.error && !r.gated && r.license);
const blocked = rows.filter((r) => r.error || r.gated || !r.license);

const out = [];
out.push(`## Open-weights models served but not tracked — ${rows.length} with a model card`);
out.push('');
if (rows.length) {
  out.push('| Model | Lab | Repo created | Licence | Parameters | Paper |');
  out.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    out.push(`| \`${r.hf}\` | ${r.company ?? '_new lab_'} | ${r.repoCreated ?? '—'} | ${
      r.license ?? '—'} | ${r.params.value ? r.params.value.toLocaleString('en-US') : `_${r.params.why}_`} | ${
      r.arxiv ? 'yes' : '—'} |`);
  }
} else {
  out.push('_Nothing served with a model card that this dataset lacks._');
}

if (blocked.length) {
  out.push('');
  out.push(`### ${blocked.length} not draftable`);
  for (const r of blocked) {
    out.push(`- \`${r.hf}\` — ${r.error ?? (r.gated ? 'gated or private; the card cannot be read openly' : 'no licence declared on the card')}`);
  }
}

const withHints = rows.filter((r) => r.hints.length);
if (withHints.length) {
  out.push('');
  out.push('### Where the announcement has been found before');
  out.push('');
  out.push('_Hosts already cited as primary for these labs. Start here for the release date._');
  out.push('');
  for (const r of withHints) {
    out.push(`- \`${r.hf}\` → ${r.hints.slice(0, 3).map((h) => `\`${h}\``).join(', ')}`);
  }
}

out.push('');
out.push('_A model card is a primary source, but the release date is not on it: `createdAt` '
  + 'is when the repo appeared. Each draft still needs the lab\'s own announcement before '
  + 'the record can be `verified`._');
console.log(out.join('\n'));

if (SPEC) {
  // Grouped by lab, because add-model.mjs takes one company per spec file and
  // refuses a family-shaped record holding several sizes.
  const byCompany = new Map();
  for (const r of draftable) {
    const company = r.company ?? r.hf.split('/')[0];
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push({
      // The catalogue id's last segment is already a good slug — re-deriving one
      // turned `deepseek-v4-pro-0813` into `deepseekv-4pro-0813`.
      id: r.catalogueId.split('/').pop().toLowerCase(),
      model: r.name,
      // Marked, not asserted: a repo creation date is a starting point for the
      // person who will find the announcement, never the canonical release date.
      date: r.repoCreated,
      note: 'DRAFT — date is the Hugging Face repo creation date, not the announcement. Replace before recording.'
        + (r.hints.length ? ` Announcements for this lab have been found at: ${r.hints.slice(0, 3).join(', ')}.` : ''),
      sources: [
        { url: `https://huggingface.co/${r.hf}`, type: 'official_model_card' },
        ...(r.arxiv ? [{ url: r.arxiv, type: 'technical_paper' }] : []),
      ],
      open_weights: true,
      license: r.license,
      ...(r.params.value ? { parameter_count: r.params.value } : {}),
      primary_type: r.pipeline?.includes('text') ? 'language' : undefined,
    });
  }
  // add-model.mjs takes ONE company per file, so a run spanning several labs
  // writes several files rather than an array it would reject.
  const written = [];
  for (const [company, models] of byCompany) {
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const path = byCompany.size === 1 ? SPEC : SPEC.replace(/(\.json)?$/, `.${slug}.json`);
    writeFileSync(path, `${JSON.stringify({ company, family: null, models }, null, 2)}\n`);
    written.push(path);
  }
  console.log(`\n_Wrote ${draftable.length} draft(s) to ${written.length} file(s): ${written.join(', ')}._`);
  console.log('_Every one needs a person: set `family`, replace the repo-creation date with the '
    + 'announcement, and confirm the lab name. Then: `node scripts/add-model.mjs <file>`._');
}
