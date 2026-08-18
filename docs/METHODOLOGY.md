# LLM World — Methodology

How facts get into this dataset, what makes one trustworthy, and what happens
when we get one wrong.

Companion to [`TAXONOMY.md`](TAXONOMY.md) (what things are called),
[`MASTER-EVOLUTION-PLAN.md`](MASTER-EVOLUTION-PLAN.md) (what we intend to
support) and [`EXECUTION-ORDER.md`](EXECUTION-ORDER.md) (in what order).

Written at Stage 0. The rules here are enforced by `scripts/validate-data.mjs`
from Stage 1 onward; where a rule is not yet enforced it says so.

The governing principle:

> This project will never be the fastest to publish. It should be the easiest to
> check.

---

## 1. Never estimate

An undisclosed value is `null` and renders as "Not disclosed". It is never
inferred, interpolated, or carried across from a similar model.

Most proprietary labs do not publish parameter counts. `null` is the correct and
complete answer there — not a gap to be filled. A dataset that guesses once
cannot be trusted anywhere.

The single exception is `provenance.status: "estimated"`, which exists for dates
that are known to be approximate and are *labelled* as such in the UI. It is not
a licence to estimate specifications.

*Enforced today.*

---

## 2. What counts as one record

**One record per separately named, separately shipped model.**

- A new distinct name from the lab → a new record.
- A change to a model that keeps its name → an **event** on the existing record.
- A product, not a set of weights → a milestone, not a model record
  (see TAXONOMY §7).

This matches the existing convention: `Claude 3 Opus`, `Claude 3.5 Sonnet` and
`Claude Sonnet 4.5` are three records sharing the `Claude` family, because the
lab named and shipped them separately.

### Worked example — the Grok-1 duplicate

The dataset currently holds two records, `Grok-1` and `Grok-1 (open weights)`.
Same model, same name; the second exists to mark the later weights release.

Under this rule that is **one record with two events**:

```json
"events": [
  { "type": "announcement",          "date": "2023-11-04", "sources": ["src-…"] },
  { "type": "weights_availability",  "date": "2024-03-17", "sources": ["src-…"] }
]
```

Two records for one model overstate the model count, split its sources, and make
the same lab look twice as productive as it was. Merging them is part of the
Stage 1 migration.

The two records also disagree on `access.open_weights` — `false` on the first,
`true` on the second — which exposes a rule the schema needs:

> **`access` describes current state. `events[]` records when it changed.**

The merged record is `open_weights: true`, and the `weights_availability` event
is what dates that change. The same applies to any access fact that can flip:
a model that later gains an API, or has its weights withdrawn.

A consequence worth stating: "was this model open at the time?" is a question
about events, not about `access`. Analytics that plot open-weight share over
time must read the event, not the current flag, or they will retroactively
report Grok-1 as open in November 2023.

### Event types

`announcement` · `paper` · `public_availability` · `api_availability` ·
`weights_availability` · `major_update` · `retirement`

Each event carries its own `sources[]`. An event without a source is not
recorded.

---

## 3. The canonical date

A model has many dates. The timeline needs one.

**Canonical date = the `announcement` event.** Where no announcement is
evidenced, fall back to the earliest evidenced event of any type.

Rationale: announcement is the date almost universally reported, and it is what
every existing record already encodes — PaLM sits at 2022-04-04, its research
blog post. Choosing availability instead would silently re-order the entire
timeline against every existing source, which is a change no reader could see or
verify.

Where announcement and availability differ materially, the model page shows both.
The timeline position is the canonical date and says which one it is.

Derived at build time from `events[]`. Never stored separately — see §4.

---

## 4. A fact is stored once

Every fact has exactly one home in the schema. Anything else is derived at build
time.

This is not tidiness; it is a trust rule. Two copies of a fact will eventually
disagree, and a dataset that contradicts itself cannot be checked by a reader.

Current examples being resolved in Stage 1:

| Fact | Stored twice as | Resolution |
|---|---|---|
| Open weights | `access.open_weights` **and** the `open-weights` tag | Keep `access`; drop the tag |
| Multimodality | the `multimodal` tag **and** `modalities` | Derive from `modalities` |
| Long context | — | Derive from `context_window` |

The `open_weights` duplication is currently guarded by a hand-written
cross-check in `validate-data.mjs`. Removing the duplicate removes the need for
the guard.

Charter §18 proposes a `dates` object alongside `events[]`. **Rejected under this
rule** — `events[]` is strictly more expressive, and `dates` is derivable.

---

## 5. Sources and authority

Every record cites at least one source. Every source is an object with a stable
id so that individual facts can reference it (Stage 5).

```json
{
  "id": "src-001",
  "url": "https://www.anthropic.com/news/…",
  "archived_url": "https://web.archive.org/web/20260809…/https://…",
  "retrieved": "2026-08-09",
  "publisher": "Anthropic",
  "type": "official_announcement",
  "authority": "primary"
}
```

### Authority

| Authority | Meaning |
|---|---|
| `primary` | Published by the organisation that made the model |
| `secondary` | Independent reporting, analysis or third-party benchmarking |
| `discovery` | Used only to find that something exists. **Never cited as evidence for a value.** |

### Type → authority

| `type` | Default authority |
|---|---|
| `official_announcement` | primary |
| `official_documentation` | primary |
| `official_model_card` | primary |
| `official_repository` | primary |
| `technical_paper` | primary **when authored by the releasing lab**, otherwise secondary |
| `independent_benchmark`, `independent_analysis` | secondary |
| `news` | secondary |

A paper about a model, written by people who did not make it, is secondary. The
mapping is a default, not an override: authority is stated per source.

### Discovery sources

Third-party trackers (aireleasetracker.com, llm-timeline.com, llmgateway.io) and
Hugging Face org listings are `discovery` only. Use them to learn that something
exists, then verify against the lab's own announcement and cite that.

Two are additionally constrained legally: llmgateway's catalogue is AGPL and
aireleasetracker is an EU database. Neither is mirrored.

---

## 6. Mutable sources require an archived citation

A page that shows *current* state does not prove a *past* fact. Citing
`openai.com/pricing` for a 2023 price is a citation that has already rotted — the
page no longer contains the claim.

**Any fact taken from a mutable page must carry `archived_url` and `retrieved`.**
A dated snapshot is permanently checkable; a live URL is not.

Required for:

- every `pricing[]` entry
- every source typed `official_documentation`
- any source where the cited value could change without the URL changing

Recommended everywhere else — announcements are edited more often than people
expect.

Where no snapshot exists, create one before citing. Where one cannot be created,
the fact is not recorded.

*Enforced for pricing since Stage 7: a `pricing[]` entry whose source has no
`archived_url` fails the build. Since the price-history work it must also cite a
source whose authority is `primary` — §5 has always said a secondary source
cannot back a value, but nothing checked it, and four prices reached production
citing Wikipedia articles that state no figure at all.*

### One URL, many snapshots, is not a duplicate citation

Two source ids for one URL normally read as two independent corroborations when
they are one, and the validator rejects that. A price history is the exception:
Cohere's pricing page captured in April 2024 says $0.50 per million and the same
page in September says $0.15. Those are different documents that happen to share
a URL, and each observation must cite the snapshot that states it.

So the test is the snapshot, not the URL. Two sources for one page with no
`archived_url`, or with the same one, remain an error.

### A snapshot dates itself, not the fact

Pricing entries carry **`observed_on`**, never `effective_from`. A capture proves
what a page said on the day it was captured. It does not say when that price
started, and assuming otherwise invents a fact.

The first version of the pricing extractor got this wrong. It labelled every
price with the model's announcement date, so a February 2026 capture of OpenAI's
documentation showed GPT-4o at $2.5/$10 "from May 13, 2024" — a launch price
that was never charged, since GPT-4o launched at $5/$15 and was cut later. Seven
of sixteen records had the snapshot more than sixty days after the date being
claimed; one was 1,076 days.

The same caution applies to any field read from a page that changes. Ask what
date the evidence actually carries, and publish that one.

---

## 7. Record the claim, not the number

Benchmark scores are **dated assertions by named parties**, not properties of a
model.

```json
{
  "name": "GPQA Diamond",
  "score": 88.7,
  "evaluation_type": "vendor_reported",
  "reported_on": "2026-08-01",
  "sources": ["src-004"]
}
```

Consequences of this framing:

- A later revision by the vendor does not invalidate the row. It **adds** one.
  The disagreement between them is itself data.
- `evaluation_type` — `vendor_reported`, `independent`, `community` — is
  required, because who ran the evaluation is more informative than the score.
- Scores are never compared across differing conditions without saying so.
- **No composite or overall intelligence score, ever** (charter §26). Any single
  number claiming to rank models hides exactly the methodology this project
  exists to expose.

The same framing applies to any vendor claim about capability.

---

## 8. Conflicting evidence is published, not resolved

Where credible sources disagree, both values are recorded with their sources, and
the record is shown as conflicting.

```json
"evidence": {
  "context_window": [
    { "value": 128000, "sources": ["src-002"] },
    { "value": 200000, "sources": ["src-007"] }
  ]
}
```

Silently picking a winner is the most damaging thing this dataset could do,
because it is invisible to the reader. Showing the disagreement is more useful
than resolving it and more honest than hiding it.

`provenance.status: "conflicting"` is already a valid status but currently has
nowhere to put the conflict. Stage 5 gives it one.

---

## 9. Provenance status and confidence

**A record is verified when every value it asserts is found in a primary
source.** A `null` asserts nothing, so an undisclosed parameter count does not
block verification — the opposite rule would mean no proprietary model could
ever be verified, which contradicts §1.

Where verification was done by checking that a value appears verbatim in an
archived snapshot, the reason says so and names the form matched
(`context window (1M)`). That is evidence, not proof: a reader can see the basis
and disagree with it. Do not write a reason that hides the method.

**Known gap:** `null` currently cannot distinguish "the lab does not publish
this" from "nobody has researched it yet". Those are very different facts and
the Data Quality page will misreport coverage until they are separable. Fixing
it needs a small additive field; it is not blocking, and it is not yet done.

| Status | Requirement |
|---|---|
| `verified` | Every asserted value traced to a `primary` source |
| `partially_verified` | Date or key facts corroborated only by secondary sources |
| `conflicting` | Credible sources disagree; both recorded per §8 |
| `estimated` | Date known to be approximate; labelled as such in the UI |
| `unverified` | Recorded from a discovery source, not yet checked. **Not publishable** — a holding state during research only |

`confidence` (0–100) is currently hand-set, which makes it the least principled
field in the schema. Under this methodology it is defined by evidence, not by
feel:

| Band | Meaning |
|---|---|
| 90–100 | Primary source for date and all recorded specifications |
| 70–89 | Primary source for the date; some specifications secondary or absent |
| 50–69 | Date corroborated only by secondary sources |
| < 50 | Not publishable |

Where the band is fully determined by the evidence, `confidence` should be
derived at build time rather than stored. Stage 5 makes that possible; until
then it is hand-set within these bands.

---

## 10. Corrections are public

Every fact in this dataset already carries a complete audit trail, because the
dataset is a JSON file in git. Almost nobody exposes this, and it is one of the
cheapest trust features available here.

Policy:

- A commit that changes a recorded value states **what changed, and which source
  changed it**. Not "update data".
- Corrections surface in the UI: a changed value shows when it changed and why.
- Corrections are never quietly rewritten. The prior value stays in history and
  stays visible.
- Being wrong in public and fixing it visibly is worth more than appearing to
  have always been right.

*Requires no schema change — it needs commit discipline now and a build-time read
of git history at Stage 3.*

---

## 11. Coverage is stated, not implied

The dataset covers 85 models from 16 labs. It is not complete and does not imply
completeness.

The Data Quality page (Stage 3) states plainly:

- the verification mix, including how many records are **not** verified
- which sources are unreachable — `npm run validate:links` already computes this
  weekly in CI; the result is currently private and should be published
- which specifications are missing, and how many are missing because they were
  never disclosed
- **which labs are not covered at all**

Naming the gaps is more credible than a number that implies there are none. A
reader who can see what is missing can calibrate everything else.

---

## 12. AI-assisted research

AI may be used to discover candidates, locate sources, and draft records.

AI may **not** be the source of a fact. Every value traces to a cited document a
reader can open. A model's recollection of a specification is not evidence, and
is exactly the kind of plausible-but-unverifiable claim this dataset exists to
displace.

Every record reaches the dataset through a human-reviewed change with sources
attached. No automated pipeline publishes directly (charter §45).
