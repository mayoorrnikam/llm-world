---
title: The tools arrived about two years before the words did
question: When did "harness engineering" begin?
date: 2026-08-19
draft: true
milestones: agent,harness
unverified: allow — Manus and Grok Build are dated from reporting rather than the lab's own page, and both are marked partially_verified in the table. Neither carries the argument: the claim here is about tools that shipped through 2024 and 2025, and those two records are from March 2025 and May 2026.
---

There is a story the industry tells about itself, in five rungs: prompt
engineering, then context engineering, then harness engineering, then loop
engineering, then graph engineering. Each arrives, each supersedes the last,
and the ladder is usually drawn with years attached.

It is a good story. The dates do not survive contact with the sources.

## Nobody can say who coined any of them

Start with the strongest case, because it is the one with serious writing
behind it. Birgitta Böckeler's article on harness engineering, published on
martinfowler.com on 2 April 2026, says the term "has emerged" and names no
originator. Her own earlier memo, from 17 February 2026, describes her first
thoughts on the term *as it appeared* — already in circulation, from nowhere
in particular. The first academic treatment, Galster et al.'s study of harness
configuration across five tools (arXiv 2602.14690, submitted 16 February
2026), puts the phrase in its title and attributes it to no one.

Three careful sources, no coiner. Search the same term outside that layer and
you are told, confidently, that it was coined by Viv Trivedy; that it is
"commonly attributed to" Mitchell Hashimoto; and that it was formalised in an
OpenAI publication. Those three answers appear in a single page of results.

The pattern repeats. Simon Willison wrote up context engineering on 27 June
2025, while it was happening, linked the two posts everyone cites, and
identified no originator — he treats both men as popularisers, which is what
they were. Gergely Orosz, writing about loop engineering on 14 July 2026, says
plainly that the term was already trending before the prominent people used it.
And prompt engineering, the oldest rung, is attributed to Gwern Branwen in 2020
by sources that all hedge with "likely"; the practice it names was already a
folk craft after the GPT-3 API opened in June 2020.

## The one coinage everyone can point to is a joke

Graph engineering has a specific origin, and it is the exception that finishes
the argument. Peter Steinberger posted, on 17 July 2026 at 5:34pm Pacific:

> Are we still talking loops or did we shift to graphs yet?

That is the whole post. It is a question, and reading the replies — *im tired
boss*, *bro stop I'm on vacation* — it is plainly a joke about how fast this
vocabulary turns over. Within two days it had three competing definitions
written under it and a body of explanatory literature on top.

The industry took a complaint about naming things too quickly and named
something with it.

## Even the timestamps do not agree

The two dates most often cited as coinages cannot be stated without a timezone,
and nobody states one.

Tobi Lütke's post reads **8:01pm on 18 June 2025** on its own page in a browser
set to Pacific — which is **01:01 UTC on 19 June**. Quoted inside Karpathy's
reply, the same platform renders the same post as 19 June. Steinberger's reads
**5:34pm on 17 July 2026** Pacific, and **00:34 UTC on 18 July** — which is why
every write-up dates it 18 July.

Both land within ninety minutes of midnight UTC. Karpathy's own post, at
8:54am Pacific, does not cross midnight in either direction, and it is the one
date in this story nobody disputes.

This is not pedantry about hours. It is the reason none of these can be
recorded here as milestones: this project requires a source that *states* a
date, and a rendered timestamp is not a stated date. It is a fact about the
reader's clock.

## What the record actually shows

Here is every agent and coding-harness milestone in the dataset, each date
checked against a source that states it. Read it against "harness engineering,
early 2026":

<!-- the table is generated from data/milestones.json -->

Qwen-Agent tagged its first release in April 2024. Trae shipped in January
2025, Claude Code in February 2025, Gemini CLI in June 2025. By the time the
label arrived in early 2026, people had been doing the thing for the better
part of two years, using tools they could download.

The agent thread is longer still — it runs from LangChain in October 2022 to
the present without a gap, straight through every rung of the ladder. It does
not stop when context engineering starts. Nothing stops when anything starts.

## What this does not claim

- **Not that the words are useless.** A name lets people find each other, and
  this project uses one of them: milestones here are typed `harness`, adopted
  from exactly the vocabulary this post says arrived late. The word is good.
  Its date is fiction.
- **Not that the labels are inventions with nothing behind them.** Anthropic
  published a definition of context engineering on 29 September 2025 and
  Böckeler built a working taxonomy of harness components. Both are real work.
  Both came *after* the term, not before it.
- **Not that this table is the whole history.** 28 of the 51 milestones
  recorded here are agents or harnesses, which says as much about what has been
  researched as about what happened. The pre-2023 record is thinner than the
  last two years, and a fuller one would likely push these dates earlier still,
  not later.
- **Not that anyone lied.** No one in this post claimed to coin anything. The
  false precision was added downstream, by writers who needed a date and found
  a plausible one.

The general lesson is smaller than the ladder and more useful. A practice
becomes visible when it gets a name, and being visible feels like beginning.
The record of what shipped is the correction, and it is only available to
someone who kept the dates and the documents behind them.
