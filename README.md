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

The glyphs are **simplified brand-derived marks drawn to read at ~13px, not
official brand assets.** Some are close to the real thing (Microsoft's four
squares, xAI's X, Meta's infinity, Moonshot's crescent); others are evocations
where the real logo doesn't survive at glyph scale (DeepSeek's whale) or where
the brand has no strongly iconic mark (AI21, Zhipu). Swapping in official
artwork means replacing one `<g>` in the sprite — the id (`ic-<slug>`) is
derived from the company's hue token, so nothing else changes.

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
