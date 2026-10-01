---
title: Open weights ship less often, and match the frontier anyway
question: Is AI actually getting more open over time?
date: 2026-08-17
openweights: by-year
unverified: allow — two frontier values are not yet traced to a primary source, and both are marked ⚠︎ in the table. OPT-175B, 2022's open-weights frontier, carries a 2,048-token context window, in the earliest row of a comparison whose argument rests on 2024 onward. MiMo-V2.5 shares 2026's open-weights frontier at 1,048,576 tokens: Xiaomi's changelog states 1M and its published config states the exact figure, but no archived snapshot yet holds either, so the comparison for 2026 is provisional.
---

Ask how open AI is getting and you will usually be shown a count of releases. By
that measure the answer for 2026 looks grim: the first table below has open
weights at their smallest share of any year on record.

That number is real, and it is close to meaningless as a scoreboard.

Release count measures how often a lab ships, not how good the models are. The
proprietary side of 2026 is concentrated in a few labs that publish many
increments, led by Google. Meanwhile Alibaba shipped as many open
releases as proprietary ones in the same year, so even sorting *labs* into camps
does not work.

The second table is the one that changes the picture. On context window — the only
capability this dataset records on both sides of the licence line — the open side
has not been behind since 2024. In 2025 the largest open-weights context window was
Llama 4 Scout's ten million tokens, roughly ten times the largest proprietary one.
In 2026 the two sit within a rounding error of each other.

So the honest reading is not that one side is winning. It is that the two measures
disagree: open weights are a shrinking share of releases and are not a shrinking
share of the frontier.

**What would change my mind.** Context window is one axis, and a cheap one to move —
it says nothing about reasoning, coding or tool use, which is where the interesting
argument actually is. This dataset records benchmark scores on thirteen records, far
too few to say anything. Until that is fixed, treat everything above as a claim about
context and licensing, not about intelligence.
