#!/usr/bin/env node
/**
 * Data quality gate for data/llm-releases.json.
 *
 * Runs in CI on every push, so the kinds of defects found by hand during the
 * sourcing pass — a fabricated date, a duplicate id, a release with no source —
 * fail the build instead of reaching the published site.
 *
 *   node scripts/validate-data.mjs            check
 *   node scripts/validate-data.mjs --links    also verify every source URL resolves
 *
 * Exits non-zero if any error-level rule fails. Warnings never fail the build.
 */

import { readFileSync } from 'node:fs';
import {
  canonicalDate, fieldState, assertedValue, EVIDENCED_FIELDS,
} from '../lib/record.mjs';

const FILE = 'data/llm-releases.json';
const CHECK_LINKS = process.argv.includes('--links');

const errors = [];
const warnings = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const warn = (id, msg) => warnings.push(`${id}: ${msg}`);

const VALID_STATUS = new Set(['verified', 'partially_verified', 'unverified', 'conflicting', 'estimated']);

// Schema 1.6 vocabularies — defined in docs/TAXONOMY.md.
// `multimodal` was removed after the Stage 8 evaluation. All 24 records that
// derive as multimodal are correctly `language` — text-first models that also
// accept images. Multimodality is a property of `modalities`, which the schema
// already states exactly, so a type for it would say the same thing twice
// (TAXONOMY §2). Re-add it only if a model appears that no other type fits.
const VALID_PRIMARY_TYPE = new Set([
  'language', 'vision', 'image_generation', 'video_generation', 'audio',
  '3d', 'world_model', 'unknown',
]);
const VALID_SUBTYPE = new Set(['llm', 'slm', 'reasoning', 'embedding', 'reranker']);
const VALID_MODALITY = new Set(['text', 'image', 'audio', 'video', '3d', 'sensor', 'environment']);
const VALID_CAPABILITY = new Set([
  'reasoning', 'coding', 'vision', 'audio', 'video', 'tool_use', 'function_calling',
  'structured_output', 'agentic', 'long_context', 'multilingual',
  'image_generation', 'video_generation', 'speech_generation',
  'world_prediction', 'planning',
]);
// tags[] holds this project's own judgements only. Anything evidenced belongs
// in capabilities, modalities or access (TAXONOMY §5).
const VALID_TAG = new Set(['flagship', 'small-efficient', 'multimodal']);
const VALID_EVENT_TYPE = new Set([
  'announcement', 'paper', 'public_availability', 'api_availability',
  'weights_availability', 'major_update', 'retirement',
]);
const VALID_AUTHORITY = new Set(['primary', 'secondary', 'discovery']);
/** Fields a lab can decline to publish, and that we can evidence as withheld. */
const UNDISCLOSABLE = new Set(['parameter_count', 'context_window', 'license']);
/** Pricing units. Extensible on purpose: image and video models are not priced
 *  per token, and the charter asks for pricing that survives that (§25). */
const VALID_PRICING_UNIT = new Set([
  'per_million_tokens', 'per_image', 'per_second_of_video', 'per_minute_of_audio', 'per_request',
]);
/** Who ran the evaluation — more informative than the score itself. */
const VALID_EVALUATION_TYPE = new Set(['vendor_reported', 'independent', 'community']);
const VALID_SOURCE_TYPE = new Set([
  'official_announcement', 'official_documentation', 'official_model_card',
  'official_repository', 'technical_paper', 'independent_benchmark',
  'independent_analysis', 'news',
]);

let data;
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`FATAL: cannot parse ${FILE} — ${e.message}`);
  process.exit(1);
}

const releases = data.releases ?? [];
if (!releases.length) {
  console.error('FATAL: no releases in dataset');
  process.exit(1);
}

/* ------------------------------------------------------------ file level */

if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updated ?? '')) {
  err('<file>', `"updated" must be YYYY-MM-DD, got ${JSON.stringify(data.updated)}`);
}

const seenIds = new Map();
const seenNameDate = new Map();
/** Retired ids that must keep resolving → the record that absorbed them. */
const retiredIds = new Map();
// Compare against the end of today in UTC so a release published today passes.
const today = new Date();
const endOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59);

/* --------------------------------------------------------- release level */

for (const r of releases) {
  const id = r.id || `<missing id: ${r.model ?? '?'}>`;

  if (!r.id) err(id, 'missing id');
  else if (seenIds.has(r.id)) err(id, `duplicate id (also used by "${seenIds.get(r.id)}")`);
  else seenIds.set(r.id, r.model);

  if (!r.model?.trim()) err(id, 'missing model name');
  if (!r.company?.trim()) err(id, 'missing company');

  // classification (S1) — the discriminator every other model type depends on
  const cls = r.classification;
  if (!cls) err(id, 'missing classification block');
  else {
    if (!VALID_PRIMARY_TYPE.has(cls.primary_type)) {
      err(id, `unknown classification.primary_type "${cls.primary_type}"`);
    }
    if (cls.primary_type === 'language') {
      if (!VALID_SUBTYPE.has(cls.subtype)) err(id, `unknown language subtype "${cls.subtype}"`);
    } else if (cls.subtype != null && !VALID_SUBTYPE.has(cls.subtype)) {
      err(id, `unknown subtype "${cls.subtype}"`);
    }
    // A reasoning subtype without the capability is a contradiction (TAXONOMY §2).
    if (cls.subtype === 'reasoning' && !r.capabilities?.includes('reasoning')) {
      err(id, 'subtype "reasoning" but capabilities[] does not include reasoning');
    }
  }

  // modalities (S2) — null means "not yet researched", never "text only"
  if (r.modalities !== null) {
    const m = r.modalities;
    if (!m || !Array.isArray(m.input) || !Array.isArray(m.output)) {
      err(id, 'modalities must be null or { input: [], output: [] }');
    } else {
      for (const v of [...m.input, ...m.output]) {
        if (!VALID_MODALITY.has(v)) err(id, `unknown modality "${v}"`);
      }
      if (!m.input.length || !m.output.length) err(id, 'modalities.input and .output cannot be empty');
    }
  }

  // capabilities (S2) — evidenced claims only
  if (!Array.isArray(r.capabilities)) err(id, 'capabilities must be an array');
  else for (const c of r.capabilities) {
    if (!VALID_CAPABILITY.has(c)) err(id, `unknown capability "${c}"`);
  }

  // tags (S2) — editorial judgements only; evidenced facts live elsewhere
  if (!Array.isArray(r.tags)) err(id, 'tags must be an array');
  else for (const t of r.tags) {
    if (!VALID_TAG.has(t)) {
      err(id, `"${t}" is not an editorial tag — it belongs in capabilities, modalities or access`);
    }
  }

  // `multimodal` is a placeholder for unresearched modalities. Once modalities
  // are recorded it becomes derivable, and keeping the tag would store the same
  // fact twice (METHODOLOGY §4).
  if (r.modalities && r.tags?.includes('multimodal')) {
    err(id, 'modalities are recorded, so the "multimodal" tag is now derived — remove it');
  }

  // events (S4) — the canonical date is derived from these, so they carry the
  // load that year/month/day used to.
  const events = r.events;
  if (!Array.isArray(events) || !events.length) err(id, 'no events — every model needs at least one');
  else {
    const sourceIds = new Set((r.sources ?? []).map((s) => s.id));
    let sawAnnouncement = false;

    for (const e of events) {
      if (!VALID_EVENT_TYPE.has(e.type)) err(id, `unknown event type "${e.type}"`);
      if (e.type === 'announcement') sawAnnouncement = true;

      const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(e.date ?? '');
      if (!m) {
        err(id, `event date must be YYYY-MM-DD or YYYY-MM, got ${JSON.stringify(e.date)}`);
        continue;
      }
      const [, yy, mm, dd] = m.map(Number);
      if (yy < 2015 || yy > 2100) err(id, `implausible year ${yy} on ${e.type}`);
      if (mm < 1 || mm > 12) err(id, `month out of range on ${e.type}: ${mm}`);

      const stamp = Date.UTC(yy, mm - 1, dd || 1);
      // A real calendar date: Feb 30 would silently roll over to March otherwise.
      if (dd) {
        const back = new Date(stamp);
        if (back.getUTCMonth() !== mm - 1 || back.getUTCDate() !== dd) {
          err(id, `not a real date: ${e.date}`);
        }
      }
      if (stamp > endOfToday && r.provenance?.status !== 'estimated') {
        err(id, `${e.type} date is in the future — mark provenance.status "estimated" if intended`);
      }

      // Referential integrity: an event citing a source that isn't there is a
      // claim with no evidence behind it.
      if (!Array.isArray(e.sources) || !e.sources.length) {
        err(id, `event "${e.type}" has no sources`);
      } else for (const sid of e.sources) {
        if (!sourceIds.has(sid)) err(id, `event "${e.type}" cites unknown source "${sid}"`);
      }
    }

    if (!sawAnnouncement) warn(id, 'no announcement event — canonical date falls back to earliest');

    const key = `${r.model?.toLowerCase()}|${canonicalDate(r)?.slice(0, 7)}`;
    if (seenNameDate.has(key)) warn(id, `same model name and month as "${seenNameDate.get(key)}"`);
    else seenNameDate.set(key, r.id);
  }

  // sources (S3) — every value must trace to something a reader can open
  if (!Array.isArray(r.sources) || r.sources.length === 0) {
    err(id, 'no sources — every release must cite at least one');
  } else {
    const seenSourceIds = new Set();
    const seenUrls = new Set();
    const seenArchives = new Set();
    for (const s of r.sources) {
      if (!s.id) err(id, `source missing id: ${s.url}`);
      else if (seenSourceIds.has(s.id)) err(id, `duplicate source id "${s.id}"`);
      else seenSourceIds.add(s.id);

      if (!/^https?:\/\//.test(s.url ?? '')) err(id, `source url must be http(s): ${s.url}`);
      /**
       * One URL, many SNAPSHOTS, is not a duplicate citation.
       *
       * The rule below exists because two ids for one URL read as two
       * independent corroborations when they are one. That reasoning holds
       * only while both point at the same document — and a price history is
       * the case where they do not. Cohere's pricing page captured in April
       * 2024 says $0.50 per million and the same page captured in September
       * says $0.15; those are different documents that happen to share a URL,
       * and each observation has to cite the snapshot that states it.
       *
       * So duplicates are still an error, and the test is the archived_url. Two
       * sources for one page with no snapshot, or with the SAME snapshot, are
       * the double-counting this was written to stop. Two different dated
       * captures are the evidence a history is made of.
       */
      else if (seenUrls.has(s.url) && !s.archived_url) {
        err(id, `same URL cited twice under different ids, with no snapshot to `
          + `distinguish them: ${s.url}`);
      } else if (seenUrls.has(s.url) && seenArchives.has(s.archived_url)) {
        err(id, `same snapshot cited twice under different ids: ${s.archived_url}`);
      } else { seenUrls.add(s.url); if (s.archived_url) seenArchives.add(s.archived_url); }

      if (!VALID_SOURCE_TYPE.has(s.type)) err(id, `unknown source type "${s.type}"`);
      if (!VALID_AUTHORITY.has(s.authority)) err(id, `unknown source authority "${s.authority}"`);
      if (s.authority === 'discovery') {
        err(id, `source "${s.id}" is discovery-only and cannot be cited as evidence (METHODOLOGY §5)`);
      }
      // R1 — a live docs URL does not prove a past fact. Warn now, error at Stage 7.
      if (s.type === 'official_documentation' && !s.archived_url) {
        warn(id, `documentation source "${s.id}" has no archived_url (R1)`);
      }
    }
  }

  const p = r.provenance;
  if (!p) err(id, 'missing provenance block');
  else {
    if (!VALID_STATUS.has(p.status)) err(id, `unknown provenance.status "${p.status}"`);
    if (!Number.isInteger(p.confidence) || p.confidence < 0 || p.confidence > 100) {
      err(id, `confidence must be 0-100, got ${p.confidence}`);
    }
    if (p.status === 'verified' && !r.sources?.some((s) => s.authority === 'primary')) {
      err(id, 'marked verified but has no primary source');
    }

    /**
     * Verified means every value the record ASSERTS was found in a primary
     * source. Nothing recomputed that when a value changed, so correcting a
     * figure on a verified record left the badge claiming more than the
     * evidence did — seven records were in that state, five of them long
     * before the edit that exposed it.
     *
     * Having a primary source is not the same as having traced the value to
     * one, which is why the check above did not catch any of them.
     */
    if (p.status === 'verified') {
      const untraced = EVIDENCED_FIELDS.filter((f) => {
        const v = assertedValue(r, f);
        if (v == null) return false;
        return !(r.evidence?.[f] ?? []).some((e) => String(e.value) === String(v));
      });
      if (untraced.length) {
        err(id, `marked verified but ${untraced.join(' and ')} `
          + `${untraced.length === 1 ? 'is' : 'are'} not traced to any primary source `
          + `— run attribute-facts --redo, or downgrade the status`);
      }
    }
    if (p.status === 'unverified') err(id, 'unverified records are not publishable (METHODOLOGY §9)');

    // Anything short of verified must say WHY, in the record, in public. A bare
    // "partially_verified" tells a reader nothing about which fact is weak.
    // Warning now, error once every record has been through Stage 2.
    if (p.status !== 'verified' && !String(p.reason ?? '').trim()) {
      warn(id, `status "${p.status}" with no provenance.reason — say which fact is unproven`);
    }
    if (p.reason != null && typeof p.reason !== 'string') {
      err(id, 'provenance.reason must be a string');
    }
    // The bands are defined by evidence, not by feel (METHODOLOGY §9).
    if (p.status === 'verified' && p.confidence < 90) {
      warn(id, `verified but confidence ${p.confidence} — verified records sit in the 90–100 band`);
    }
  }

  // `kind` is gone: every record in this file is a model, and products live in
  // data/milestones.json (TAXONOMY §7). A leftover kind means a stale record.
  if ('kind' in r) err(id, 'remove "kind" — this file holds models only; products are milestones');
  if (!r.family?.trim()) err(id, 'missing family');

  // specifications (S5) — numbers are null until researched, never a guess (§1).
  for (const f of ['context_window', 'parameter_count']) {
    const v = r.specifications?.language?.[f];
    if (v != null && (typeof v !== 'number' || v <= 0)) {
      err(id, `specifications.language.${f} must be a positive number or null`);
    }
  }
  if (typeof r.access?.open_weights !== 'boolean') err(id, 'access.open_weights must be true or false');

  // A note is prose we write; parameter_count is a figure with sources behind
  // it. When the note states a different number, the record contradicts itself
  // in the two places a reader is most likely to look — Phi-3 described "a
  // 3.8-billion-parameter model" while recording 14B, evidenced twice.
  const noteParams = /(\d[\d.]*)[\s-](billion|trillion|million)[\s-]parameter/i.exec(r.note ?? '');
  if (noteParams) {
    const scale = { million: 1e6, billion: 1e9, trillion: 1e12 }[noteParams[2].toLowerCase()];
    const stated = Number(noteParams[1]) * scale;
    const recorded = r.specifications?.language?.parameter_count;
    // 10% tolerance. Labs name models by a rounded figure — Mistral 7B really
    // holds 7.3B parameters — and flagging that would be pedantry. The gap this
    // catches is the wrong-model kind: Phi-3's note was off by 3.7x.
    if (recorded != null && Math.abs(stated - recorded) / recorded > 0.10) {
      err(id, `note says ${noteParams[0]} but parameter_count is ${recorded.toLocaleString('en-US')}`);
    }
  }

  // undisclosed[] is a positive claim: we read the primary sources and the lab
  // does not publish this. It is only meaningful about a field that is null —
  // claiming a value is undisclosed while also recording it is a contradiction.
  if (r.undisclosed != null) {
    if (!Array.isArray(r.undisclosed)) err(id, 'undisclosed must be an array');
    else for (const f of r.undisclosed) {
      if (!UNDISCLOSABLE.has(f)) {
        err(id, `"${f}" cannot be marked undisclosed — expected one of ${[...UNDISCLOSABLE].join(', ')}`);
      } else if (fieldState(r, f) !== 'undisclosed') {
        err(id, `"${f}" is marked undisclosed but has a recorded value`);
      }
    }
  }

  // evidence (Stage 5) — which source states each published fact.
  if (r.evidence != null) {
    if (typeof r.evidence !== 'object' || Array.isArray(r.evidence)) {
      err(id, 'evidence must be an object keyed by field');
    } else {
      const sourceIds = new Set((r.sources ?? []).map((s) => s.id));
      for (const [field, claims] of Object.entries(r.evidence)) {
        if (!EVIDENCED_FIELDS.includes(field)) {
          err(id, `evidence for unknown field "${field}"`);
          continue;
        }
        if (!Array.isArray(claims) || !claims.length) {
          err(id, `evidence.${field} must be a non-empty array of claims`);
          continue;
        }
        for (const c of claims) {
          if (!('value' in c)) err(id, `evidence.${field} claim has no value`);
          if (!Array.isArray(c.sources) || !c.sources.length) {
            err(id, `evidence.${field} claim has no sources`);
          } else for (const sid of c.sources) {
            if (!sourceIds.has(sid)) err(id, `evidence.${field} cites unknown source "${sid}"`);
          }
        }

        // The record must not contradict its own evidence: whatever value it
        // publishes has to be one of the values its sources are said to state.
        const asserted = assertedValue(r, field);
        if (asserted != null && !claims.some((c) => c.value === asserted)) {
          err(id, `evidence.${field} backs ${claims.map((c) => JSON.stringify(c.value)).join(', ')} `
            + `but the record publishes ${JSON.stringify(asserted)}`);
        }

        // Two claims means the sources disagree. That is publishable, but it
        // has to be declared rather than left looking settled (R4).
        if (claims.length > 1 && p?.status !== 'conflicting') {
          err(id, `evidence.${field} records ${claims.length} competing values — `
            + `set provenance.status to "conflicting"`);
        }
      }
    }
  }

  // pricing (Stage 7) — historical, and only from a page that cannot change
  // under the citation.
  if (r.pricing != null) {
    if (!Array.isArray(r.pricing)) err(id, 'pricing must be an array');
    else {
      const byId = new Map((r.sources ?? []).map((s) => [s.id, s]));
      for (const p of r.pricing) {
        if (!VALID_PRICING_UNIT.has(p.unit)) {
          err(id, `unknown pricing unit "${p.unit}" — expected one of ${[...VALID_PRICING_UNIT].join(', ')}`);
        }
        if (!p.rates || typeof p.rates !== 'object' || !Object.keys(p.rates).length) {
          err(id, 'pricing entry has no rates');
        } else for (const [k, v] of Object.entries(p.rates)) {
          if (typeof v !== 'number' || v < 0) err(id, `pricing rate "${k}" must be a non-negative number`);
        }
        if (!/^[A-Z]{3}$/.test(p.currency ?? '')) err(id, `pricing currency must be a 3-letter code, got ${JSON.stringify(p.currency)}`);
        // observed_on, not effective_from: a snapshot proves what a page said
        // on the day it was captured, never when that price started.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.observed_on ?? '')) {
          err(id, `pricing observed_on must be YYYY-MM-DD, got ${JSON.stringify(p.observed_on)}`);
        }
        if ('effective_from' in p) {
          err(id, 'pricing uses observed_on — effective_from claims a start date no snapshot can prove');
        }

        if (!Array.isArray(p.sources) || !p.sources.length) err(id, 'pricing entry has no sources');
        else for (const sid of p.sources) {
          const s = byId.get(sid);
          if (!s) { err(id, `pricing cites unknown source "${sid}"`); continue; }
          // R1, enforced rather than warned from Stage 7: a live pricing page
          // proves today's price, never the price on effective_from.
          if (!s.archived_url) {
            err(id, `pricing cites "${sid}" which has no archived_url — a live pricing `
              + `page cannot evidence a past price (METHODOLOGY §6)`);
          }
          // METHODOLOGY §5: a secondary source may corroborate a date, never
          // back a value. Four prices reached production citing Wikipedia
          // articles that state no figure at all — the numbers were right and
          // the citations were fiction, which is precisely the failure this
          // dataset exists to make impossible. The writer that produced them is
          // fixed (lib/model-docs.mjs citeDocs); this is the gate that would
          // have caught it.
          if (s.authority !== 'primary') {
            err(id, `pricing cites "${sid}" (${s.url}) whose authority is `
              + `"${s.authority}" — only a primary source can back a value (METHODOLOGY §5)`);
          }
        }
      }
    }
  }

  // benchmarks (Stage 7) — dated assertions by a named party, not properties
  // of the model (METHODOLOGY §7).
  if (r.benchmarks != null) {
    if (!Array.isArray(r.benchmarks)) err(id, 'benchmarks must be an array');
    else {
      const sourceIds = new Set((r.sources ?? []).map((s) => s.id));
      for (const b of r.benchmarks) {
        if (!b.name?.trim()) err(id, 'benchmark has no name');
        if (typeof b.score !== 'number') err(id, `benchmark "${b.name}" score must be a number`);
        if (!VALID_EVALUATION_TYPE.has(b.evaluation_type)) {
          err(id, `benchmark "${b.name}" needs evaluation_type — who ran it matters more than the score`);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.reported_on ?? '')) {
          err(id, `benchmark "${b.name}" reported_on must be YYYY-MM-DD`);
        }
        if (!Array.isArray(b.sources) || !b.sources.length) err(id, `benchmark "${b.name}" has no sources`);
        else for (const sid of b.sources) {
          if (!sourceIds.has(sid)) err(id, `benchmark "${b.name}" cites unknown source "${sid}"`);
        }
        // Charter §26: no single number that claims to rank models overall.
        if (/^(overall|composite|average|aggregate|index|intelligence)\b/i.test(b.name ?? '')) {
          err(id, `"${b.name}" looks like a composite score — this project does not publish one`);
        }
      }
    }
  }

  // Retired ids must keep resolving and must not collide with a live record.
  for (const prev of r.previous_ids ?? []) {
    if (retiredIds.has(prev)) err(id, `previous_id "${prev}" also claimed by "${retiredIds.get(prev)}"`);
    else retiredIds.set(prev, r.id);
  }
}

// Checked after the loop so a retired id colliding with any live record is caught.
for (const [prev, owner] of retiredIds) {
  if (seenIds.has(prev)) err(owner, `previous_id "${prev}" collides with a live record`);
}

/* ------------------------------------------------------------- milestones */

/**
 * Milestones are dated events that mattered, model release or not. They are a
 * separate file because they are a different kind of thing — no parameters, no
 * context window, no family lineage — and giving them a row in the model table
 * meant a record where every specification was null (TAXONOMY §7).
 */
const VALID_MILESTONE_TYPE = new Set([
  'product_launch', 'architecture', 'context', 'multimodal',
  'open_weights', 'research', 'policy',
  // The execution layer around a model, which is a different kind of event from
  // shipping the model itself. Nineteen agent and harness milestones all typed
  // `product_launch` would have filed AutoGPT, Claude Code and OpenClaw under
  // the same label as ChatGPT — true but useless, since the index page facets
  // on this field and a facet everything shares filters nothing.
  'agent',
  // A coding harness (CLI, IDE, or wrapper around a model) is a distinct event
  // from shipping the model itself. Gemini CLI is not Gemini 2.5 Pro.
  'harness',
  // A protocol is not a product. MCP has no launch price, no users and no
  // owner in the way a product does; what it has is adoption. `architecture`
  // was the alternative and reads as MODEL architecture everywhere else here.
  'protocol',
]);

let milestones = [];
try {
  milestones = JSON.parse(readFileSync('data/milestones.json', 'utf8')).milestones ?? [];
} catch (e) {
  if (e.code !== 'ENOENT') err('<milestones>', `cannot parse data/milestones.json — ${e.message}`);
}

const seenMilestoneIds = new Set();
for (const m of milestones) {
  const id = m.id || `<missing id: ${m.title ?? '?'}>`;

  if (!m.id) err(id, 'milestone missing id');
  else if (seenMilestoneIds.has(m.id)) err(id, 'duplicate milestone id');
  else seenMilestoneIds.add(m.id);

  // A milestone id must not collide with a model id — they share a URL space
  // in the reader's mind even though they sit in different directories.
  if (seenIds.has(m.id)) {
    warn(id, `milestone id also used by a model record — check this is intentional`);
  }

  if (!m.title?.trim()) err(id, 'milestone missing title');
  if (!VALID_MILESTONE_TYPE.has(m.type)) err(id, `unknown milestone type "${m.type}"`);

  if (m.significance !== null && m.significance !== undefined) {
    if (!['canonical', 'major', 'notable'].includes(m.significance)) {
      err(id, `unknown significance "${m.significance}" — must be canonical, major, notable, or null`);
    }
  }
  if (m.why_it_matters !== undefined && m.why_it_matters !== null && typeof m.why_it_matters !== 'string') {
    err(id, 'why_it_matters must be a string');
  }

  const d = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(m.date ?? '');
  if (!d) err(id, `milestone date must be YYYY-MM-DD, got ${JSON.stringify(m.date)}`);
  else {
    const [, yy, mm, dd] = d.map(Number);
    const stamp = Date.UTC(yy, mm - 1, dd || 1);
    if (dd) {
      const back = new Date(stamp);
      if (back.getUTCMonth() !== mm - 1 || back.getUTCDate() !== dd) {
        err(id, `not a real date: ${m.date}`);
      }
    }
    if (stamp > endOfToday && m.provenance?.status !== 'estimated') {
      err(id, 'milestone date is in the future');
    }
  }

  // Every milestone requires evidence — charter §40, and the same rule the
  // model records live under.
  if (!Array.isArray(m.sources) || !m.sources.length) {
    err(id, 'milestone has no sources — every milestone requires evidence');
  } else for (const s of m.sources) {
    if (!/^https?:\/\//.test(s.url ?? '')) err(id, `source url must be http(s): ${s.url}`);
    if (!VALID_SOURCE_TYPE.has(s.type)) err(id, `unknown source type "${s.type}"`);
    if (!VALID_AUTHORITY.has(s.authority)) err(id, `unknown source authority "${s.authority}"`);
  }

  if (!VALID_STATUS.has(m.provenance?.status)) {
    err(id, `unknown provenance.status "${m.provenance?.status}"`);
  }
  if (m.provenance?.status === 'verified' && !m.sources?.some((s) => s.authority === 'primary')) {
    err(id, 'milestone marked verified but has no primary source');
  }
}

/* ------------------------------------------------------------ link check */

if (CHECK_LINKS) {
  const urls = [...new Set(releases.flatMap((r) => (r.sources ?? []).map((s) => s.url)))];
  process.stdout.write(`checking ${urls.length} source URLs…\n`);
  const results = await Promise.all(urls.map(async (u) => {
    try {
      const res = await fetch(u, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; llm-world link-check)' },
      });
      return [u, res.status];
    } catch {
      return [u, 0];
    }
  }));
  for (const [u, status] of results) {
    // 401/403/405 mean the host blocks bots, not that the page is gone.
    if (status === 0 || status === 404 || status === 410) {
      warn('<links>', `unreachable (${status || 'network error'}): ${u}`);
    }
  }
}

/* ---------------------------------------------------------------- report */

const stats = {
  releases: releases.length,
  milestones: milestones.length,
  companies: new Set(releases.map((r) => r.company)).size,
  families: new Set(releases.map((r) => r.family)).size,
  verified: releases.filter((r) => r.provenance?.status === 'verified').length,
  canonical: milestones.filter((m) => m.significance === 'canonical').length,
  major: milestones.filter((m) => m.significance === 'major').length,
  harness: milestones.filter((m) => m.type === 'harness').length,
};
console.log(
  `${stats.releases} releases · ${stats.milestones} milestones · ${stats.companies} companies · ` +
  `${stats.families} families · ${stats.verified} verified · ${stats.canonical} canonical · ` +
  `${stats.major} major · ${stats.harness} harness`,
);

for (const w of warnings) console.log(`  WARN  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);

if (errors.length) {
  console.error(`\nFAILED — ${errors.length} error${errors.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`\nOK${warnings.length ? ` — ${warnings.length} warning(s)` : ''}`);
