---
title: Anthropic held the context window at 200K for 20 months
question: How has Claude's context window actually changed?
date: 2026-08-17
history: Anthropic | context_window
unverified: allow — Claude Mythos 5.1's 1M context window is stated by Anthropic's own announcement and API release notes, both cited on the record, but neither page has an archived snapshot yet, so attribute-facts cannot tie the figure to one. The daily archive run captures them; remove this line once it has.
---

Every lab talks about context windows as though they climb steadily. Anthropic's
did not. It moved three times in forty months, and between the second and third
move it sat at exactly 200,000 tokens across seven consecutive releases.

That stretch covers Claude 3 Opus through Claude Opus 4.5 — twenty months in
which the model got substantially better at almost everything else and the
context window did not move at all. Then, in February 2026, it went to a million
in one step.

The table below is generated from the dataset, so it stays correct as records are
added. Every value links to the Anthropic announcement or model card it came from.
