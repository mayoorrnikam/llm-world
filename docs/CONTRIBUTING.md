# Contributing

This is a dataset first and a website second. A contribution is almost always an
edit to `data/llm-releases.json`, and the site rebuilds itself around it.

The rules below are not style preferences. Each one exists because breaking it
put something wrong on a public page, and most are enforced by
`scripts/validate-data.mjs` — a change that breaks one fails before it can be
pushed.

---

## The five rules

**1. Never estimate a value.** A figure nobody published is `null`, and `null`
renders as "Not researched". Most proprietary labs do not disclose parameter
counts; `null` is the correct answer there, not a gap to fill with a guess from
a news article.

**2. `null` and "undisclosed" are different claims.** A plain `null` means
nobody has looked. Listing a field in `undisclosed[]` means somebody read the
lab's own sources and the lab publishes no such figure — that is a claim about
the lab, and it needs the same evidence as any other. `node
scripts/detect-undisclosed.mjs` works it out from the sources rather than
guessing, and refuses to conclude anything while a primary source is unread.

**3. Every record needs a primary source.** An official announcement, paper,
repository, model card or documentation page. News coverage is
`partially_verified` at best — a date corroborated only by reporting is not
verified, however reputable the outlet.

**4. Cite the snapshot, not the live page.** A live URL proves what a page says
today, not what it said when it was read. `npm run enrich` asks the Wayback
Machine for a snapshot and records it alongside the original URL. A pricing or
documentation page cited without one is a citation that has already rotted.

**5. Absence is never evidence.** A capability missing from a record means "not
evidenced", never "the model cannot do this". Nothing in the UI or the analytics
may render an unresearched field as a finding — which is why every evolution
chart counts only researched records and says so.

---

## Adding a release

Write a small spec describing only what a human has to decide. Everything
derivable is left to the enrichment pass, which reads the sources and records
what they say.

```json
{
  "company": "MiniMax",
  "family": "MiniMax",
  "models": [
    {
      "id": "minimax-m3",
      "model": "MiniMax M3",
      "date": "2026-06-02",
      "note": "One sentence on what makes this release notable.",
      "sources": [
        { "url": "https://…", "type": "official_announcement" },
        { "url": "https://huggingface.co/…", "type": "official_model_card" }
      ],
      "open_weights": true,
      "license": "Apache-2.0",
      "parameter_count": 456000000000,
      "primary_type": "language",
      "capabilities": ["reasoning"]
    }
  ]
}
```

Then:

```bash
node scripts/add-model.mjs spec.json          # check the spec, change nothing
node scripts/add-model.mjs spec.json --write  # add the record
npm run enrich                                # archive, trace, read modalities
npm run check                                 # validate → build → smoke
```

`add-model.mjs` refuses four things, each of which has gone wrong here at least
once:

- a record with no primary source
- `modalities` set by hand — the detector reads them from the sources, because
  writing "text" by hand is how a multimodal model gets published as text-only
- a licence on a proprietary record, which is a category error
- one record holding a whole family. Nova, Phi-3, Gemini 1, Llama 4, GPT-OSS
  and Mistral 3 all had to be split afterwards; the shipped model is the unit.

## Correcting a record

Corrections are the point of the project, not an embarrassment. Edit the value,
run `npm run check`, and push. The change appears on
[/changes/](https://mayoorrnikam.github.io/llm-world/changes/) automatically —
that page separates research (a `null` becoming a figure) from corrections (a
figure becoming a *different* figure), and the second is published as such.

If you believe a figure is wrong but cannot source the right one, open an issue
with the source you have. A recorded disagreement is more useful than a silent
edit.

---

## What runs before anything ships

```bash
npm run setup   # once per clone: points git at .githooks/
npm run check   # validate → build → smoke, the full gate
```

`validate` checks the data, `build` regenerates every page, and `smoke` checks
the built output — inline scripts parse, internal links resolve, shared chrome
is consistent, every company has a logo, and every script that accepts
`--write` actually writes. The same three run in CI, so a bad edit fails
locally or in CI rather than going live.

Node 20 or newer. There are no dependencies and no lockfile, and that is
deliberate — please do not add one without a strong reason.

---

## Where to look next

- **Methodology** — what counts as evidence, and what each record status means
- **Taxonomy** — the definitions behind every label
- **Data quality** — what is missing right now, and from which records
