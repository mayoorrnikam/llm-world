# LLM World — Taxonomy

How models are classified, and what each term means here.

Companion to [`MASTER-EVOLUTION-PLAN.md`](MASTER-EVOLUTION-PLAN.md) (what we
intend to support) and [`EXECUTION-ORDER.md`](EXECUTION-ORDER.md) (in what
order). This document fixes the vocabulary those two rely on.

Written at Stage 0. Nothing here is implemented yet — schema 1.6 (Stage 1) is
what puts it into the data.

---

## 1. Three independent axes

The single most important rule in this document:

> **Type, modality and capability are separate. None implies another.**

Collapsing them is the standard mistake in model trackers, and it becomes
unfixable once URLs and charts are built on the collapsed version.

| Axis | Question it answers | Field |
|---|---|---|
| **Type** | What kind of model is this, primarily? | `classification.primary_type` |
| **Modality** | What can go in, and what comes out? | `modalities.{input,output}` |
| **Capability** | What can it do? | `capabilities[]` |

Worked example — a language model that accepts images and speaks:

```json
"classification": { "primary_type": "language", "subtype": "llm" },
"modalities": {
  "input":  ["text", "image", "audio"],
  "output": ["text", "audio"]
},
"capabilities": ["reasoning", "vision", "tool_use", "speech_generation"]
```

It is a **language** model (type) that is **multimodal** (a property of its
modalities, not a type of its own) and can **reason** (capability). Under the
current schema all three of those facts live undifferentiated in `tags[]`,
which is why S2 exists.

Note that `multimodal` is *derived*, never stored: a model is multimodal when
`modalities.input` or `modalities.output` holds more than one value. Storing it
separately would be a second copy of a fact — see METHODOLOGY §4.

---

## 2. `classification.primary_type`

The discriminator. Every record has exactly one. It answers "what is this model
*for*", not "what can it handle".

| Value | Definition |
|---|---|
| `language` | Primary output is natural-language text. Includes models that also accept or emit other modalities. |
| `vision` | Primary purpose is understanding visual input. Output is labels, structure or text *about* an image, not a generated image. |
| `image_generation` | Primary output is a raster image. |
| `video_generation` | Primary output is video. |
| `audio` | Primary output or input is speech, music or general audio. See subtypes. |
| `3d` | Primary output is a 3D asset, scene or representation. |
| `world_model` | See §6 — the strictest category, with its own inclusion test. |
| `unknown` | Evidence is genuinely unclear. Legitimate and preferred over a guess. |

`unknown` is not a failure state. A record classified `unknown` with a good
source is more trustworthy than one confidently mis-typed.

### Language subtypes

`classification.subtype`, only meaningful when `primary_type` is `language`:

| Value | Definition |
|---|---|
| `llm` | General-purpose large language model. The default. |
| `slm` | Small language model — deliberately parameter-efficient, positioned by the lab for on-device or low-cost deployment. Lab positioning decides this, not a parameter threshold. |
| `reasoning` | Trained or configured to spend inference-time compute on explicit reasoning before answering, and presented as such by the lab. |
| `embedding` | Output is a vector representation, not text. |
| `reranker` | Output is a relevance ordering over candidates. |

`reasoning` is deliberately both a subtype and a capability. The subtype means
"this is what the model *is*" (o-series); the capability means "this is
something it *does*" (a flagship model with a reasoning mode). A model can carry
the capability without the subtype. It should not carry the subtype without the
capability — the validator enforces that direction.

**Discriminators, settled 2026-08-10 against 16 records.** Three signals decide
it, all from the lab's own words:

| Signal | Reading |
|---|---|
| The lab classes the *line* as thinking models | subtype — "Gemini 2.5 models **are** thinking models" |
| The lab says the model **is** a reasoning model | subtype — "Muse Spark **is** a natively multimodal reasoning model" |
| Reasoning is a **mode or effort setting** | capability — Qwen3's `enable_thinking` switch; `reasoning.effort` supporting `none (default)` on GPT-5.1 |
| The lab ships reasoning as a **separately named model** | capability on the base — Grok 3 is the flagship; "Grok 3 (Think)" is the reasoning model |
| "**Hybrid** reasoning model" | capability. A toggle is precisely "a flagship model with a reasoning mode" |

Anthropic stated the distinction outright for Claude 3.7 Sonnet: *"we believe
reasoning should be an integrated capability of frontier models rather than a
separate model entirely."* That is this table's fourth row in the lab's own
voice, and it is why 12 records keep the capability without the subtype.

Two records could not be decided — `gpt-5-6` and `qwen-3-8-max` have no archived
primary source, so they stay `llm` until one exists.

Other types get subtypes when they get records. Do not invent them now.

---

## 3. Modality vocabulary

`text` · `image` · `audio` · `video` · `3d` · `sensor` · `environment`

`input` and `output` are recorded separately and are frequently asymmetric.

`sensor` and `environment` exist for world models and are not to be used for
anything else until §6's test has been met by a real record. Charter §9 is right
that this vocabulary should not be over-designed before there is data to
constrain it.

Record what the model *accepts and produces*, per the lab's own documentation —
not what a surrounding product does. A text-only model inside a product that
transcribes audio first is `input: ["text"]`.

---

## 4. Capability vocabulary

Recorded only with evidence. An unlisted capability means "not evidenced", never
"absent" — the UI must not render absence as a negative claim.

| Capability | Recorded when |
|---|---|
| `reasoning` | Lab documents explicit inference-time reasoning |
| `coding` | Lab positions code as a primary use, or ships a code-specific variant |
| `vision` | Accepts image input and reasons over it |
| `audio` | Accepts or produces audio |
| `video` | Accepts or produces video |
| `tool_use` | Can invoke external tools |
| `function_calling` | Structured function-call interface |
| `structured_output` | Guaranteed schema-conforming output (JSON mode or equivalent) |
| `agentic` | Lab documents multi-step autonomous operation |
| `long_context` | Context window ≥ 200K tokens. Derived, not hand-set |
| `multilingual` | Lab documents non-English capability as a feature |
| `image_generation`, `video_generation`, `speech_generation` | Produces that modality |
| `world_prediction`, `planning` | Reserved for §6 |

`long_context` is derived from `specifications.language.context_window` at build
time, so it cannot disagree with the number it summarises.

---

## 5. What remains in `tags[]`

After S2, `tags[]` holds **editorial judgements only** — claims made by this
project rather than facts taken from a source:

| Tag | Meaning |
|---|---|
| `flagship` | This project's judgement that the model was the lab's leading release at the time |
| `small-efficient` | Positioned for efficiency; overlaps `subtype: slm` but is a presentation choice |

Everything else currently in `tags[]` moves:

| Today | Becomes |
|---|---|
| `multimodal` | derived from `modalities` |
| `reasoning`, `agentic` | `capabilities[]` |
| `open-weights` | `access.open_weights` (already stored there — the duplicate goes) |

This split matters for trust: it makes the boundary between *what a source says*
and *what we think* visible in the schema rather than blurred inside one array.
`flagship` is entirely our opinion; it should be labelled as such in the UI.

---

## 6. World models — inclusion test

The strictest category, because the term is used loosely in marketing. Charter
§47 is right to demand criteria before any record exists.

A model is classified `world_model` **only if the lab's own documentation
evidences all three**:

1. It represents the **state of an environment** — physical or simulated — as
   something other than text.
2. It **predicts future states** of that environment, conditioned on time,
   actions, or both.
3. That prediction is the model's **purpose**, not a by-product.

Explicitly insufficient, alone or combined:

- Marketing that uses the phrase "world model"
- Generating video that looks physically plausible
- Predicting the next token over text describing a world
- Being embodied, or shipping on a robot

A video generator is `video_generation` until criterion 2 is evidenced. When a
record is genuinely borderline, it is `unknown` with the ambiguity stated in the
record's note — not promoted on the strength of a press release.

**No record currently qualifies, and none should be added until a real candidate
is tested against this list in public.**

---

## 7. Models, products and milestones

The dataset currently holds two records that are not models: `chatgpt` and
`bard`, both carrying `kind: "product"`, both filed inside model families (`GPT`
and `Gemini`).

This is a real classification error worth fixing rather than preserving:

- **A model** is a set of weights the lab names and ships. It has parameters, a
  context window, a licence.
- **A product** is an interface over one or more models. ChatGPT is not a model;
  it is a product that was originally served by GPT-3.5.
- **A milestone** is a dated event that mattered, whether or not it was a model
  release.

**Decision:** the dataset holds models. ChatGPT's launch is one of the most
significant dated events in this history, so it belongs in the dataset — as a
**milestone**, per charter §40, not as a model record with null specifications.
Same for Bard.

This removes `kind` from model records entirely; the file a record lives in
becomes the discriminator. Timelines may merge models and milestones for
display, clearly distinguished.

Until milestones ship (Stage 8), these two records stay as they are. They are
not to be used as a precedent for adding more products.

---

## 8. Families and lineage

A **family** is a lineage the lab itself presents as continuous — `Claude`,
`Llama`, `Qwen`. Filled on every record.

Rules:

- **Never infer lineage from names alone** (charter §23). `GPT-OSS` is not the
  `GPT` family merely by sharing a prefix; it is separate here, correctly.
- A family is not a release cadence. `Claude 3 Opus` and `Claude 3.5 Sonnet` are
  one family, several generations.
- Ordering within a family is derived from dates, not from version-number
  parsing. Version numbers are not reliably ordered across labs.
- Explicit parent pointers are NOT stored. `lineageOf()` in `lib/record.mjs`
  derives predecessor, successor and siblings from `family` and the canonical
  date, both of which are filled on every record. A stored pointer would be a
  second copy of a fact the dataset already holds, and would go wrong the first
  time a date was corrected (§4).
- **Same-day releases are siblings, not a succession.** Ordering a family purely
  by date turns GPT-5.6 Sol, Luna and Terra into a three-step chain; they are one
  launch of three sizes. `lineageOf()` returns anything sharing a date as a
  sibling and never as a predecessor.

Where a lab forks a line — a family that splits into open and closed branches —
record both under the same family and let the branch show in lineage when it
exists. Do not create a second family to express a fork.

---

## 9. Open questions

Deliberately unresolved; revisit when data forces the issue.

1. **Distilled and quantised variants.** Currently absent. Likely events or
   variants on a parent record rather than families of their own.
2. ~~**`multimodal` as a `primary_type`.**~~ **Resolved 2026-08-10: removed.**
   It had no valid members. All 24 records that derive as multimodal are
   `language` — text-first models that also accept images. Even GPT-4o, which
   emits text, image and audio, is a language model that does more rather than a
   different kind of thing. Multimodality is a property of `modalities`; a type
   for it would say the same thing twice. Re-add only if a model appears that no
   other type fits.
3. **Where fine-tunes by third parties belong.** Out of scope for now; the
   dataset tracks lab releases.
