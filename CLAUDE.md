# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run setup      # once per clone — points git at .githooks/ so pre-push runs `check`
npm run check      # validate → build → smoke. The full gate; what pre-push and CI run
npm run preview    # build, then serve on localhost:8777 (dependency-free server)

npm run validate           # dataset only: schema, dates, ids, provenance
npm run validate:links     # also HTTP-check every source URL (slow; CI runs this weekly)
npm run build              # regenerate all static pages
npm run build:export       # ...and api/*.json + llm-releases.csv
npm run smoke              # structural test of the built output (run a build first)
npm run freshness          # weekly staleness + Hugging Face candidate report
npm run feeds              # labs' own newsroom feeds — the only signal for closed labs
npm run clean              # delete all generated output
npm run mcp                # MCP server over the dataset, stdio, zero deps
```

Research and enrichment tools, none of which write without `--write`:

```bash
node scripts/pricing-history.mjs --lab=anthropic   # price history from archived captures
node scripts/weights-events.mjs                    # when open weights actually landed
node scripts/reconcile-status.mjs                  # make provenance.status match the evidence
node scripts/detect-undisclosed.mjs                # split "lab publishes nothing" from "nobody looked"
node scripts/discover-litellm.mjs                  # which gaps a lab plausibly publishes (leads only)
node scripts/repo-dates.mjs                        # corroborate dates against arXiv/GitHub
node scripts/apply-archives.mjs caps.txt           # fold in snapshots captured by hand
node scripts/archive-worklist.mjs                  # write ARCHIVE-WORKLIST.md for a person
```

There is no test framework and no bundler. `npm run smoke` is the test suite; it
takes no filter argument, so there is no "run a single test" — narrow by editing
the checks in `scripts/smoke-test.mjs`.

Node ≥ 20. No runtime or build dependencies: `package.json` has no `dependencies`
or `devDependencies` and there is no lockfile. **Keep it that way** unless there
is a strong reason — dependency-free is a deliberate property of this project.

## Architecture

### The dataset is the source of truth

`data/llm-releases.json` drives everything: the app, all ~112 generated pages,
the analytics charts, the JSON/CSV export. Adding a release is a JSON edit, never
a code change. Schema is documented in README under "Data model (schema 1.6)".

**Lineage is derived, not stored.** `lineageOf()` returns predecessor,
successor and siblings from `family` and the canonical date. Do not add a
`predecessor` field — it would be a second copy of a fact already held, and
records sharing a date are SIBLINGS, not a succession (GPT-5.6 Sol, Luna and
Terra are one launch of three sizes).

**`sourceText()` signals failure with a Symbol, which is truthy.** `if (t)` is
not a valid guard; use `typeof t === 'string'`. This has caused three separate
crashes — weights-events, detect-undisclosed, and one report that silently
scored a Symbol as page text.

**Derived facts live in `lib/record.mjs`, not in the JSON.** The canonical date
(from `events[]`), multimodality (from `modalities`), long-context (from
`context_window`) and the display tag list are all computed there, and both
`app.js` and `scripts/build.mjs` import it. If you are about to add a field to
the dataset that could be computed from another field, compute it there instead
— a fact stored twice eventually disagrees with itself.

The dataset separates **evidenced facts** (`capabilities`, `modalities`,
`access`) from **this project's judgements** (`tags`: only `flagship`,
`small-efficient`, `multimodal`). The validator rejects anything else in `tags`.

**`null` is ambiguous, so `undisclosed[]` disambiguates it.** A field listed
there is one we read the primary sources for and the lab publishes no such
figure — the record is complete. A plain `null` means nobody has looked. Use
`fieldState()` from `lib/record.mjs` rather than testing for null directly:
rendering an unresearched field as "Not disclosed" claims something about the
lab that nobody established. `node scripts/detect-undisclosed.mjs` works this
out from the sources.

### Two renderers over one dataset

1. **`index.html` + `app.js` + `styles.css`** — the interactive timeline. A single
   vanilla ES module, no framework. Fetches the JSON at runtime and renders
   client-side. All UI state lives in the URL (`?year=&company=&tag=&q=&view=#id`)
   so any view is linkable.
2. **`scripts/build.mjs`** — generates static, no-JS-required pages for
   `/models/<id>/`, `/companies/<slug>/`, `/timeline/<year>/`, plus the
   `/families/<slug>/`, plus the `/latest/`, `/models/`, `/families/`,
   `/companies/`, `/analytics/`, `/compare/` and `/data-quality/` indexes,
   a sitemap and robots.txt.

**"What changed" must never turn a research gap into a claim.** `diffRecords()`
in `lib/record.mjs` compares a field only when both records assert a value.
Capabilities are the trap: they are recorded on 12 records, so a plain set
difference reports "− vision" between two Claude releases and states that
Anthropic removed it. Absence of a capability means "not evidenced", never
"absent" — fields that cannot be compared are rendered as gaps, not dropped.

Both must agree, which is why the next two points exist.

### `index.html` is the single source for shared chrome and logos

`build.mjs` reads `index.html` at build time and extracts:

- **Header and footer**, verbatim, between the `<!-- shared:header-start -->` /
  `<!-- shared:footer-start -->` marker comments. It rewrites relative links for
  each page's depth and stamps `aria-current="page"` on that page's nav item.
- **Company logo `<g>` blocks** from the inline SVG sprite, inlining only the
  logos a given page uses.

**So: to change the nav, footer, or a logo, edit `index.html` only.** Never add a
second copy inside `build.mjs`. Two copies drifting apart is a bug this project
already had and deliberately designed out. If you move the marker comments, the
build throws.

Page-specific controls (year selector, search, view toggle, refresh, help) live
*outside* the shared markers — they reshape the timeline and would be inert on a
static page.

### Two data files, two kinds of thing

`data/llm-releases.json` holds **models** — sets of weights with parameters, a
context window and a licence. `data/milestones.json` holds **dated events that
mattered but were not model releases**, which is where ChatGPT and Bard live:
they are products served by a model, so as model records every specification was
null (TAXONOMY §7). There is no `kind` field any more — the file a record lives
in is the discriminator, and the validator rejects a leftover `kind`.

Milestones need a primary source exactly like model records. They render in the
timeline lanes and on year pages, deliberately shaped differently from release
cards so they can never be counted as models by eye.

### Posts are prose over generated facts, and are gated on provenance

`content/posts/*.md` are question-shaped pages built to `/posts/<slug>/`. The
prose is written by a person; every number, table and source list is generated
from the dataset at build time, so a post cannot go stale as records are added.

A frontmatter key is a **directive**, registered in `POST_DIRECTIVES` in
`build.mjs`. Each returns `{ md, claims }` — the markdown to append, and the
values the post's headline is computed from. Adding a post type is one entry.
Two exist: `history: Company | field` and `openweights: by-year`.

**`gatePostClaims()` fails the build if a post asserts a value with no primary
source.** This catches what the other gates cannot: `validate` sees sound
records and `smoke` sees sound HTML, but a post can still build a false sentence
on a true dataset. It caught a draft headlined "512×" whose denominator — PaLM's
context window — was untraced. A post may opt out only by naming a reason:

```yaml
unverified: allow — <reason a reader would accept>
```

Bare `allow` is rejected. The reason is the point: it is what a reader would
want to have been told.

**`draft: true` keeps a post off the site** — no page, no index row, no sitemap
entry — so a batch can be written and released one at a time. Drafts are still
rendered and gated, and `npm run build` prints `draft ready:` or
`draft NOT publishable:` for each, which is the live answer to "what is queued".
As of this commit, Google's context window and the open-weights post are drafts.

`draft: true` is **not** privacy. This repo is public, so a draft's prose is
readable on GitHub as soon as it is committed. It controls what the site
publishes, not what the world can see.

`scripts/post.mjs` re-cuts the same generated facts for Hacker News, Reddit, X
and Medium. It does not post anything — those platforms penalise identical
cross-posted text — and it does not write the take.

### Generated output is never committed

Everything in `.gitignore` under "Generated by scripts/build.mjs" is built fresh
by CI on every push and deployed straight to Pages. Only ~22 files are tracked.
Do not commit build output; do not add generated paths to git.

### Three gates, in order

`validate` (is the data sound?) → `build` → `smoke` (is the output sound?).
Both `.githooks/pre-push` and `.github/workflows/deploy.yml` run this sequence
*before* anything is published, so a bad edit fails locally or in CI rather than
going live.

`scripts/smoke-test.mjs` exists because three specific bugs reached production.
It checks the built HTML for: inline `<script>` blocks that fail `node --check`,
placeholder `href="#"`, internal links that resolve to nothing, and exactly one
`main-nav` + one `aria-current` sitting inside that nav.

## Data rules

These are enforced by `scripts/validate-data.mjs` and will fail the build:

- **Never estimate a value.** Undisclosed figures are `null` and render as
  "Not disclosed". Most proprietary labs do not publish parameter counts — `null`
  is the correct answer there, not a gap to fill.
- **`provenance.status: "verified"` requires a primary source** (official
  announcement, paper, repo, model card or documentation). A date corroborated
  only by news reporting is `partially_verified`.
- Every release needs at least one entry in `sources[]`.
- `access.open_weights` must agree with the `open-weights` tag.
- Dates must be real calendar dates and not in the future unless
  `provenance.status` is `"estimated"`.

**Epoch AI is the one third-party source that is legally clean to use.** Its
notable-models database is CC BY 4.0 — the same licence as this dataset — so it
may be used and quoted with attribution. It is still SECONDARY under
METHODOLOGY §5 and can never back a value; its worth is the `Link` column,
which points at each model's own paper or announcement. Run
`node scripts/discover-epoch.mjs` to list labs and models we are missing.

Other third-party trackers (aireleasetracker.com, llm-timeline.com, llmgateway.io) are
**discovery sources only** — use them to find what is missing, then verify against
the provider's own announcement and cite that. Two of them are also legally
constrained: llmgateway's catalogue is AGPL, and aireleasetracker is an EU
database. Do not mirror either.

To merge researched values: `node scripts/apply-specs.mjs specs.json` (shape
documented in that file's header). It folds source URLs into `sources[]` and
refuses to attach a licence to a proprietary record.

## Design constraints

- **Colour is a secondary channel.** 16 companies exceed the ~8-slot categorical
  ceiling, so identity rests on the company logo (shape) and the name, which are
  always rendered alongside the hue. Logos come from lobe-icons (MIT), capability
  icons from Lucide (ISC); both are inlined, nothing is fetched at runtime.
- **Charts encode magnitude, so they take one hue**, not a categorical palette.
  The only two-class chart (open weights vs proprietary) carries a legend *and* a
  direct percentage label. The context-window chart is log-scaled and says so.
- Every colour token is declared on bare `:root`, then redefined under both
  `prefers-color-scheme: dark` and `[data-theme="dark"]`, so an explicit theme
  choice wins in both directions.

## Gotchas

- **The compare page ships its own inline `<script type="module">`** inside a
  template literal in `build.mjs`. Identifiers there can collide with page
  globals — a helper named `params` once shadowed `URLSearchParams` and killed the
  page silently. `npm run smoke` now catches this class, so run it.
- **GitHub Pages' CDN lags a minute or two after a deploy.** If something looks
  broken immediately after pushing, hard-refresh before assuming a regression.
- `ai.meta.com`, `openai.com`, `x.ai` and `ai.google.dev` block automated fetches
  (400/403, or an infinite consent redirect). A non-200 from those is not a dead
  link — verify through a real browser fetch before "fixing" a URL.
- Bulk export (`--export`) is enabled in the deploy workflow only. The dataset is
  CC BY 4.0 and the code MIT; see `NOTICE` for what each covers.
