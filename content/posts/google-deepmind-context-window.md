---
title: Google's context window has held at ~1M since December 2024
question: How did Gemini get to a million tokens?
date: 2026-08-17
draft: true
history: Google DeepMind | context_window
unverified: allow — PaLM, Gemma, Gemma 3 and Gemini 1.5 Pro carry context windows this dataset has not yet traced to a primary source. They are marked ⚠︎ in the table and no claim above depends on them.
---

Google has the longest run of records here, and the most jumps: the context window
changed six times between 2022 and 2026. But the interesting part is not the climb.

Since Gemini 2.0 Flash in December 2024, the value has sat at 1,048,576 tokens —
2²⁰, a round number in binary rather than decimal — and has not moved since. Gemini
2.5 Pro matched it in March 2025. Everything shipped after has held the same level.
That is seventeen months of stability in the specification most often used to
advertise progress.

**What this post deliberately does not do is quote a growth multiple.** An earlier
draft opened with "512×", computed from PaLM's 2,048 tokens in 2022. That figure is
in the dataset but is not traced to any primary source, so the multiple built on it
would have been a confident number resting on an unchecked one. Four values in the
table below have the same problem and are marked ⚠︎.

The three change points this post does rest on — Gemini 1.0 Ultra, Gemini 2.0 Flash
and Gemini 2.5 Pro — each link to Google's own announcement.
