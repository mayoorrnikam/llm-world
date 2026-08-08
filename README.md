# LLM World

An interactive swim-lane timeline of large language model releases, month by month.
Zero dependencies, no build step — three static files and a JSON dataset.

```
index.html    markup & dialogs
styles.css    dual-theme design system
app.js        ES module: state, rendering, URL sync
data/llm-releases.json
```

## Running it

`fetch()` is blocked on `file://`, so serve the directory over HTTP:

```bash
python3 -m http.server 8777
# → http://localhost:8777
```

Opened directly from disk the page still renders, falling back to a small
inline sample and saying so in the footer.

## Data model (schema 1.5)

Each release carries, beyond the timeline basics:

```jsonc
{
  "family": "Claude",            // the model line (§11) — Claude, GPT, Llama…
  "kind": "model",               // "model" | "product" — ChatGPT is a product, GPT-4 is a model (§25)
  "access":    { "open_weights": true, "license": null },
  "technical": { "context_window": null, "parameter_count": null },  // null until researched, never guessed
  "sources":   [{ "url": "…", "type": "official_announcement" }],
  "provenance": { "status": "verified", "confidence": 90 }
}
```

`status` is one of `verified` · `partially_verified` · `unverified` · `conflicting`
· `estimated`, shown as a badge in each dialog. **`verified` requires a primary
source** — an official announcement, paper, repo, model card or documentation.
A date corroborated only by news reporting is `partially_verified`, not verified.

Undisclosed numbers stay `null` and render as "Not disclosed". They are never
estimated or inferred (§7).

## Generated pages

The single-page app can't provide indexable URLs, so `scripts/build.mjs`
generates static, no-JavaScript-required pages from the same dataset:

```
/models/<id>/        70 pages — facts table, sources, family lineage, cadence
/companies/<slug>/   16 pages — every release by that lab, median release gap
/timeline/<year>/     5 pages — that year's releases by month
/sitemap.xml         92 URLs
```

Each model page carries `schema.org/SoftwareApplication` JSON-LD and links
back into the interactive timeline. Output is **committed** so GitHub Pages
serves it with no build step in the deploy path; CI rebuilds into a temp
directory and diffs, so the pages can't drift from `data/llm-releases.json`.

```bash
node scripts/build.mjs            # pages + sitemap
node scripts/build.mjs --check    # build to .build-check/ and diff (CI)
```

### Bulk export is off

`--export` writes `api/models.json`, `api/companies.json` and a CSV. It is
**not enabled**, and nothing machine-readable beyond the site's own
`data/llm-releases.json` is published. Turning it on is a deliberate call,
not a build side effect.

## Validation

```bash
node scripts/validate-data.mjs           # schema, dates, ids, provenance
node scripts/validate-data.mjs --links   # also check every source URL resolves
```

This runs in CI on every push to `data/` or `scripts/`, and weekly on a schedule
to catch link rot. It enforces: unique ids, real calendar dates, no future dates
unless marked estimated, at least one source per release, `verified` implies a
primary source, numeric fields numeric-or-null, and agreement between
`access.open_weights` and the open-weights tag.

It earns its place — its first run caught six releases marked `verified` that
were backed only by secondary reporting.

## Provenance

Every release carries a `source` URL, surfaced as a link in its dialog. All 70
were machine-checked for reachability; the handful that 404'd were replaced,
and `openai.com`, `x.ai` and `ai.meta.com` block automated fetches, so those
were corroborated against search listings instead.

The 2026 entries were checked against contemporaneous reporting, which turned
up four date errors now fixed:

| Release | Was | Corrected to |
|---|---|---|
| GLM-5.2 | 8 Jul 2026 | **13 Jun 2026** |
| GLM-4.5 | 8 Jul 2025 | **28 Jul 2025** |
| Claude Opus 4 (was "Claude 4 Opus") | 21 May 2025 | **22 May 2025** |
| Mistral 3 | 3 Dec 2025 | **2 Dec 2025** |

The March 2024 Grok entry is now "Grok-1 (open weights)" to distinguish it from
the November 2023 announcement of the same model.

**Known limits.** Two 2022 dates — OPT-175B (5 May) and GLM-130B (1 Aug) — are
approximate; the paper, announcement and repo dates differ by a few days and no
single one is clearly canonical. Dates for well-documented 2022–2025 releases
were not each individually re-verified, though every one carries an official
announcement link you can check.

## Keeping the data current

Updates are **manual by design** — there is no reliable public API for "notable
LLM releases" (Hugging Face indexes repos, not releases, and the largest labs
don't publish weights there at all), so a curated JSON beats a noisy feed.

To add a release: append an object to `data/llm-releases.json`, bump `updated`
to today, then click **Refresh** in the header (or press <kbd>R</kbd>). The page
re-fetches and rebuilds in place — no reload — and reports what changed:

```
70 releases · updated yesterday          →  71 releases · updated today · 1 new
```

The site nudges you when it drifts. Past 10 days the footer turns amber and
adds `source may be stale`, and a tab left open re-checks quietly when it
regains focus (throttled to once every 6 hours).

If you later want this automated, the two viable routes are a scheduled agent
that researches releases and opens a PR, or a GitHub Action polling Hugging
Face for a whitelist of official orgs — the latter is free but structurally
blind to OpenAI, Anthropic and xAI.

## Deploying

The repo is a plain static site, so GitHub Pages serves it from the root with
no build step. In **Settings → Pages**, set source to `main` / `/ (root)`.
`.nojekyll` is present so Pages skips Jekyll processing entirely.

All asset paths are relative, so the site works unchanged whether it's served
from a domain root or a project subpath (`<user>.github.io/llm-world/`).

## Data contract

```jsonc
{
  "updated": "2026-08-07",
  "releases": [
    {
      "id": "gpt-4",              // stable slug — used for deep links
      "model": "GPT-4",
      "company": "OpenAI",
      "year": 2023, "month": 3, "day": 14,   // day optional
      "tags": ["flagship", "multimodal"],
      "note": "…"
    }
  ]
}
```

Rows missing a `model`, or with a `year`/`month` that isn't a real date, are
dropped at load rather than rendered broken. Adding a release is a JSON edit —
no code change. A company with no assigned hue falls back to a neutral swatch.

## Features

**The cadence ribbon**
- The page opens on the whole dataset: one column per month since 2022, one
  tile per release. It's a unit chart, so a tile is always exactly one model —
  the shape you see is the field accelerating, not a rescaled axis
- Each year is captioned with what that year actually was (reasoning models,
  agentic systems), so the structure carries content rather than decorating it
- Click any month to jump to that year. Keyboard users get the same navigation
  from the year tabs, and every release from the cards below

**Navigation**
- Year tabs, plus an **All** view that stacks every year and skips empty months
- Each tab shows how many results it holds *under the current filters*, and dims
  when it holds none — so you can see where the matches are before clicking
- Lanes view (month swim lanes) and Grid view (flat, date-sorted)

**Filtering**
- Full-text search across model, company, tags and notes, with match highlighting
- Multi-select company chips and capability chips (tags AND together)
- Empty state that explains *why* nothing matched and offers a reset

**Detail dialog**
- Native `<dialog>` — focus trap, `Esc`, and focus restoration come from the platform
- `←`/`→` step through the current filtered result set
- Copy link — every dialog is addressable

**Everything is in the URL**

```
?year=2025&company=OpenAI,Anthropic&tag=reasoning&q=gpt&view=grid#gpt-5
```

Reload, bookmark, or share and you land on the same view.

**Keyboard**

| Key | Action |
|---|---|
| `/` | Focus search |
| `←` `→` | Previous / next year (or prev/next release inside a dialog) |
| `V` | Toggle lanes / grid |
| `T` | Cycle theme: system → light → dark |
| `A` | All years |
| `Esc` | Close dialog, or clear search |
| `?` | Shortcuts |

**Theme** — system / light / dark, persisted in `localStorage`. Every colour token
is declared on bare `:root`, then redefined under both `prefers-color-scheme: dark`
and `[data-theme="dark"]`, so an explicit choice wins in both directions.

## Design notes

**Companies are encoded by shape × hue, not hue alone.** The dataset has 16
companies. The categorical ceiling for colour-as-identity is about 8 — past that,
no palette can keep every pair distinguishable, especially under colour-vision
deficiency. Rather than pretend otherwise, each company carries a **glyph** (an
inline SVG in the sprite at the top of `index.html`) alongside its hue.

That composite encoding is what makes 16 series legitimate: shape is a fully
independent channel, so companies stay distinguishable when colour fails —
CVD, `forced-colors` mode, and greyscale print. The company name is also
always rendered next to the mark, so identity never rests on either channel
alone. Glyphs are `aria-hidden`, being decorative.

The marks are the labs' real logos, from
[lobe-icons](https://github.com/lobehub/lobe-icons) (MIT) — an icon set built
specifically for AI/LLM brands. They're monochrome and painted with
`currentColor`, so each one picks up its company's hue and the two channels stay
independent. Trademarks remain their owners'; using them to identify the
companies whose releases are listed is nominative use.

15 of our 16 labs are covered. BigScience has no mark in the set, so a neutral
bloom stands in for BLOOM. (Simple Icons was the other candidate but is missing
OpenAI, Microsoft and Amazon — brands that have asked to be removed from icon
sets.)

The palette itself was also measurably broken, and that was worth fixing
independently:

| | worst normal-vision pair | worst CVD pair |
|---|---|---|
| Before | **ΔE 1.1** (Zhipu ↔ Google) | **ΔE 0.3** (Alibaba ↔ Mistral) |
| After | ΔE ~5 | ΔE ~1 |

Five companies previously shared near-identical blues and four shared near-identical
oranges — effectively four distinct hues across sixteen brands. The current palette
re-spaces them around the hue wheel while keeping each brand recognisable
(OpenAI teal, Google blue, NVIDIA lime, Anthropic clay). All 16 clear 3:1 contrast
against both surfaces. Residual sub-floor pairs are the unavoidable cost of 16
brand-anchored series — the glyph and the name label are what carry those pairs.

**The sparkline is single-series** (releases per month), so it takes one hue on a
sequential ramp rather than a categorical palette — magnitude over time is not an
identity problem.

## Accessibility

- Skip link, landmarks, and a live region announcing result counts
- Year tabs are a real `tablist` with roving tabindex and arrow-key navigation
- Search matches are wrapped in `<mark>` via DOM nodes — no `innerHTML` anywhere,
  so dataset text cannot inject markup
- Company identity survives colour loss: glyph shape carries it under CVD, in
  `forced-colors` (where hue is deliberately dropped for `CanvasText`), and in print
- `prefers-reduced-motion` disables animations, hover lift, and view transitions

## Browser support

Modern evergreen browsers. Progressive enhancements degrade cleanly:
View Transitions and `:has()` are feature-detected or purely cosmetic, and the
page is fully usable without them.
