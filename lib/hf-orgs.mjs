/**
 * Hugging Face organisations that are a lab's own account.
 *
 * Shared because two scripts need it for opposite reasons: check-freshness
 * asks whether these orgs have shipped something we lack, and hf-new-orgs asks
 * which orgs are NOT here — a lab nobody has listed cannot be found by reading
 * a list of labs, so the list is what that scan subtracts.
 *
 * Derived, not hand-written. Epoch AI's notable-models database (CC BY 4.0)
 * names the labs shipping language models; every slug was then checked against
 * huggingface.co/api/models, so none is a guess.
 *
 * Re-derive with: node scripts/discover-epoch.mjs --labs
 */
export const ORGS = [
  // Already tracked in the dataset.
  'meta-llama', 'mistralai', 'deepseek-ai', 'Qwen', 'google', 'microsoft',
  'nvidia', 'CohereLabs', 'zai-org', 'moonshotai', 'ai21labs', 'openai',
  'xai-org', 'allenai',

  // Labs Epoch lists that this dataset does not cover at all.
  'ByteDance-Seed', 'tencent', 'apple', 'XiaomiMiMo', 'baidu', 'stepfun-ai',
  'MiniMaxAI', 'inclusionAI', 'internlm', 'OpenGVLab', 'Skywork', 'Tele-AI',
  'LGAI-EXAONE', 'upstage', 'skt', 'naver-hyperclovax', 'Motif-Technologies',
  'tiiuae', 'ibm-granite', 'arcee-ai', 'sarvamai', 'utter-project', 'PleIAs',
];

/** Lowercased, for membership tests that should not care about case. */
export const ORG_SET = new Set(ORGS.map((o) => o.toLowerCase()));
