#!/usr/bin/env node
/**
 * An MCP server over the dataset. Zero dependencies, like everything else here.
 *
 *   node mcp/server.mjs          speaks JSON-RPC over stdio
 *
 * Claude Desktop / Claude Code config:
 *
 *   { "mcpServers": { "llm-world": { "command": "/opt/homebrew/bin/node",
 *       "args": ["/absolute/path/to/llm-world/mcp/server.mjs"] } } }
 *
 * The absolute path to node is not fussiness. A macOS GUI app inherits
 * /usr/bin:/bin:/usr/sbin:/sbin, never the PATH from a shell profile, so a Node
 * from nvm or Homebrew simply is not there — `"command": "node"` fails to spawn
 * and the client reports nothing useful. `which node` in a terminal answers
 * about a different PATH than the one Claude Desktop has.
 *
 * WHY THIS EXISTS, WHEN api/models.json ALREADY DOES
 *
 * A JSON file answers "give me everything". An agent asks "which model should I
 * use for X", and the gap between those is where models invent things.
 *
 * This project's one unclaimed advantage is that every value can be traced to
 * the lab that stated it. That is worth far more to a retrieval pipeline than
 * to a person: a person reading a spec table forgives a missing figure, and a
 * pipeline asked for a context window it does not have will produce a
 * confident, plausible, wrong one. So every answer here carries its evidence,
 * and — more importantly — says when it has none.
 *
 * THE PART THAT MATTERS: UNKNOWN IS AN ANSWER
 *
 * search_models returns two lists. `matches` are records the dataset can stand
 * behind. `not_ruled_out` are records that meet part of the query and rest on a
 * field nobody has evidenced, each saying which field. That distinction is the
 * whole reason to prefer this over scraping a spec site: "Claude Opus 5's
 * coding ability is not evidenced here" is a true and useful sentence, and it
 * is not one a spec table can produce.
 *
 * It is also this project's own rule, arrived at painfully. TAXONOMY §4 reads
 * an unlisted capability as "not evidenced" rather than "absent", and the
 * search box shipped for months treating the two as the same thing — which
 * silently dropped every Anthropic model from a question about coding.
 *
 * NOTHING HERE COMPUTES A FACT. Every tool reads the dataset and returns what
 * a lab stated plus where it said it. There is no ranking, no "best", no
 * inference — benchmarks cover 7% of records, and a leaderboard built on that
 * would be the one part of this project that is not evidence.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse, run, answer } from '../lib/query.mjs';
import { canonicalDate, contextWindow, parameterCount, displayTags } from '../lib/record.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(ROOT, 'data/llm-releases.json'), 'utf8'));
const releases = data.releases ?? [];
const vocab = {
  companies: [...new Set(releases.map((r) => r.company))],
  families: [...new Set(releases.map((r) => r.family).filter(Boolean))],
};

/** A source as something an agent can actually fetch. */
const citation = (r, id) => {
  const s = r.sources.find((x) => x.id === id);
  if (!s) return null;
  return {
    url: s.url,
    archived_url: s.archived_url ?? null,
    type: s.type,
    authority: s.authority,
    retrieved: s.retrieved ?? null,
  };
};

/**
 * Every evidenced value, denormalised.
 *
 * In the dataset a claim cites a source ID and the URL lives elsewhere, which
 * is right for storage and useless over a wire: a consumer should not have to
 * join two tables to answer "where did this number come from". More than one
 * claim on a field means the sources disagree and both are returned — picking a
 * winner here would hide the most interesting thing the record knows.
 */
function claimsFor(r) {
  const out = {};
  for (const [field, claims] of Object.entries(r.evidence ?? {})) {
    out[field] = claims.map((c) => ({
      value: c.value,
      sources: (c.sources ?? []).map((id) => citation(r, id)).filter(Boolean),
    }));
  }
  return out;
}

const brief = (r) => ({
  id: r.id,
  model: r.model,
  company: r.company,
  family: r.family ?? null,
  released: canonicalDate(r),
  type: r.classification?.primary_type ?? 'language',
  context_window: contextWindow(r) ?? null,
  parameter_count: parameterCount(r) ?? null,
  open_weights: r.access?.open_weights ?? null,
  input_price_per_mtok: r.pricing?.[0]?.rates?.input ?? null,
  capabilities: r.capabilities ?? [],
  modalities: r.modalities ?? null,
  provenance: r.provenance?.status ?? null,
  url: `https://mayoorrnikam.github.io/llm-world/models/${r.id}/`,
});

const full = (r) => ({
  ...brief(r),
  tags: displayTags(r),
  events: r.events ?? [],
  undisclosed: r.undisclosed ?? [],
  provenance_reason: r.provenance?.reason ?? null,
  claims: claimsFor(r),
  sources: r.sources.map((s) => citation(r, s.id)),
});

const TOOLS = [
  {
    name: 'search_models',
    description:
      'Search AI model releases in natural language ("open weights over 100B", '
      + '"anthropic models in 2026", "coding with 1M context"). Returns matches AND '
      + 'not_ruled_out — records meeting part of the query whose remaining fields are '
      + 'unevidenced. Absence of a field NEVER means the model lacks that property; it '
      + 'means nobody has traced it to the lab yet. Do not report an unevidenced field '
      + 'as a "no".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The question, in plain language.' },
        limit: { type: 'number', description: 'Max matches to return (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_model',
    description:
      'Full record for one model id, including every claim with the primary and '
      + 'archived URL that states it. Use this to cite a figure.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Model id, e.g. "claude-opus-5".' } },
      required: ['id'],
    },
  },
  {
    name: 'dataset_stats',
    description:
      'Coverage of the dataset: record counts, verification status, and how many '
      + 'records carry each field. Read this before treating a gap as a fact — a field '
      + 'at 11% coverage cannot support a comparison.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, args = {}) {
  if (name === 'search_models') {
    const parsed = parse(String(args.query ?? ''), vocab);
    const { results, near, ignored, used } = run(releases, parsed);
    const a = answer(results, { raw: String(args.query ?? ''), terms: parsed.terms });
    return {
      understood_as: parsed.terms.map((t) => t.label),
      free_text: used || null,
      ignored_words: ignored,
      direct_answer: a ? a.text : null,
      match_count: results.length,
      matches: results.slice(0, Number(args.limit) || 20).map(brief),
      not_ruled_out: near.slice(0, 20).map((n) => ({
        ...brief(n.record),
        unevidenced: n.why,
        note: `Meets the rest of the query. ${n.why.join(', ')} not evidenced for this `
          + 'record — that is a gap in the dataset, not a "no" from the model.',
      })),
    };
  }

  if (name === 'get_model') {
    const id = String(args.id ?? '');
    const r = releases.find((x) => x.id === id)
      ?? releases.find((x) => x.model.toLowerCase() === id.toLowerCase());
    if (!r) {
      const near = releases.filter((x) => x.id.includes(id) || x.model.toLowerCase().includes(id.toLowerCase()));
      return { error: `no model with id "${id}"`, did_you_mean: near.slice(0, 8).map((x) => x.id) };
    }
    return full(r);
  }

  if (name === 'dataset_stats') {
    const n = releases.length;
    const status = {};
    for (const r of releases) status[r.provenance?.status ?? 'none'] = (status[r.provenance?.status ?? 'none'] ?? 0) + 1;
    const cov = (f) => releases.filter(f).length;
    return {
      updated: data.updated ?? null,
      schema_version: data.schema_version ?? null,
      licence: 'CC BY 4.0 — attribution required, see LICENSE-DATA',
      releases: n,
      labs: new Set(releases.map((r) => r.company)).size,
      families: new Set(releases.map((r) => r.family).filter(Boolean)).size,
      provenance: status,
      field_coverage: {
        context_window: cov((r) => contextWindow(r) != null),
        parameter_count: cov((r) => parameterCount(r) != null),
        capabilities: cov((r) => r.capabilities?.length),
        modalities: cov((r) => r.modalities),
        pricing: cov((r) => r.pricing),
        benchmarks: cov((r) => r.benchmarks?.length),
      },
      caveat:
        'Coverage is not uniform. Benchmarks and pricing are sparse, so this dataset '
        + 'cannot rank models by performance or cost across the whole set. It can say '
        + 'what a lab stated and where — treat a missing field as unresearched, never '
        + 'as zero or absent.',
    };
  }

  return { error: `unknown tool "${name}"` };
}

/* ------------------------------------------------------------ JSON-RPC */

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  // A notification has no id and takes no reply — answering one is a protocol
  // error, not a harmless extra.
  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'llm-world', version: String(data.schema_version ?? '1.6') },
      });
    }
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    // In the spec, and clients use it as a health check. Answering -32601 makes
    // a live server look dead to anything that probes before calling.
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/call') {
      const out = callTool(params?.name, params?.arguments ?? {});
      // isError, or a client renders a failure as a successful answer and the
      // model reads "no model with id" as though it were a finding.
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        ...(out && out.error ? { isError: true } : {}),
      });
    }
    if (id === undefined) return; // notification
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
