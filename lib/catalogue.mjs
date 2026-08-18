/**
 * One public model catalogue, read once, shared by everything that needs it.
 *
 * OpenRouter publishes what ~60 vendors are currently serving, without an API
 * key: id, context length, pricing, modalities, a created timestamp, and for
 * open-weights models the Hugging Face repo behind it. check-providers.mjs uses
 * it to notice what we lack; hf-bridge.mjs uses it to draft what it can.
 *
 * Both need the same two things — the fetch and the variant filter — and a
 * filter maintained in two places eventually disagrees, which here would mean
 * one script reporting a model the other silently skipped.
 *
 * A CATALOGUE IS A DISCOVERY SOURCE (METHODOLOGY §5). It says what is being
 * served, which is not the same as what a lab published, and it can never back
 * a value in the dataset.
 */

const CATALOGUE = 'https://openrouter.ai/api/v1/models';

/**
 * Serving variants are not models.
 *
 * A catalogue lists what you can BUY, so one model appears several times: a
 * `:free` tier, a `:batch` tier, a `:nitro` route. Counting those as releases
 * is the inflation that turns a competing directory's 10,679 entries into 5,722
 * actual ids, and it buries the handful of real findings in a report nobody
 * then reads. `openrouter/*` are the router's own meta-models, not models at
 * all, and a leading `~` marks a moving alias rather than a release.
 */
const VARIANT = /:(free|beta|extended|thinking|batch|nitro|floor|online|exacto|preview)$/;

export const isServingVariant = (id) =>
  VARIANT.test(id) || id.startsWith('openrouter/') || id.startsWith('~');

/**
 * Identifiers compared with punctuation and vendor prefix removed.
 *
 * Matching must UNDER-match. A missed match costs one line in a report a person
 * reads; a false match publishes "Anthropic changed Claude's context window"
 * about two different models. So no fuzzy distance, no prefix matching, and
 * variants keep their suffix — `claude-opus-5-fast` is a different product from
 * `claude-opus-5` and must never collapse into it.
 */
export const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
export const bare = (id) => key(String(id).split('/').pop());

/** @returns {Promise<object[]>} served models, serving variants removed. */
export async function fetchCatalogue() {
  const res = await fetch(CATALOGUE, { headers: { 'user-agent': 'llm-world/1.0 (+discovery)' } });
  if (!res.ok) {
    // A catalogue that will not answer is not evidence that nothing shipped.
    throw new Error(`${CATALOGUE} answered ${res.status}. No conclusions drawn.`);
  }
  return ((await res.json()).data ?? []).filter((m) => !isServingVariant(m.id));
}

/** Every id already tracked, by normalised id and by model name. */
export function trackedIndex(releases) {
  const map = new Map();
  for (const r of releases) {
    map.set(bare(r.id), r);
    map.set(key(r.model), r);
  }
  return map;
}
