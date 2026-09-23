---
title: Why AI model release trackers disagree with each other
question: Why do AI release trackers give different dates for the same model?
date: 2026-09-23
---

Look up when a model was released and you will often get two or three answers.
Much of the disagreement is not carelessness. It comes from a handful of
mechanisms, and each of them showed up in this dataset over one month of
keeping it current, September 2026.

## The same name, a different model

In late September, a web search for OpenAI's new GPT-6 Sol returned summaries
describing Sol, Luna and Terra launching in July. Those were
[GPT-5.6 Sol](../../models/gpt-5-6-sol/), Luna and Terra. OpenAI released
[GPT-6 Sol](../../models/gpt-6-sol/) and GPT-6 Luna on September 22, and its API
changelog lists them as new models, but the tier names carried over from one
generation to the next, and the two launches blurred together.

A tier name is not a model. Neither is a family name. The only safe identifier
is the full name as the lab writes it, next to the date the lab gives it.

## "Released" means five different things

A model is announced, becomes available through an API, gets its weights
published, reaches a consumer app, and gets refreshed builds. Each of those is
a date, and a tracker that records "the release date" has to pick one, often
whichever it noticed first.

One tracker listed ByteDance's Seed 2.1 Turbo as released on August 10.
ByteDance's own page announcing Seed 2.1, which says it offers two models,
**Pro and Turbo**, was captured by the Internet Archive on
[June 23](https://web.archive.org/web/20260623045712/https://seed.bytedance.com/en/seed2_1).
August 10 matches a refreshed build reported that day: a real event, but not the
release.

Another tracker dated Qwen's new Flash model to August 26. Qwen's blog
announces [Qwen3.8-Flash-Next](../../models/qwen-3-8-flash-next/) on August 3,
and its weights repository appeared on August 24. August 26 matches neither.

This dataset keeps these apart on purpose. A record holds a list of dated
events — announcement, API availability, weights, updates, retirement — each
with the source that states it. A model sits on the timeline at its
announcement, and the other dates are kept beside it rather than competing
for the same slot.

## Repository dates and re-dated pages

Two more mechanisms are big enough to have their own write-ups. A Hugging Face
repository's creation date [is not a release date](../repo-dates-are-not-release-dates/)
and can miss it by three weeks in either direction. And a lab's own
announcement [can change its date](../labs-redate-announcements/) after it is
published: xAI's Grok 4.5 page read July 8 when it was archived on July 8, and
reads July 16 today.

## Things that exist only on trackers

A tracker listed a GLM-5.2 Turbo from Z.ai on August 17. It does not appear in
Z.ai's own release notes, which list the models Z.ai ships with their dates, so
it is not recorded here. It may exist. But a model this dataset cannot find on
the lab's own pages is a model it cannot date, and a record with an undatable
release is worse than no record.

## Small errors travel

When TypeSafe AI launched [Jev](../../models/jev/), several write-ups named its
founder Diego Almeida. The byline on TypeSafe's own announcement reads
**Diogo**. Nothing about the model depends on it, but it shows how the chain
works: one source slips, and the ones that copy it inherit the slip.

## And this project got one wrong

A tracker dated a new OpenAI model, GPT Image 2.5 Flare, to September 8. This
dataset checked OpenAI's news index, found no such entry, and declined to
record it. That was wrong. The index loads its entries a page at a time, only
the first few were on screen, and absence from those proved nothing. OpenAI's
[announcement](https://openai.com/index/introducing-chatgpt-images-2-5/) that
day introduced [ChatGPT Images 2.5](../../models/chatgpt-images-2-5/) and two
API models, [GPT-Image-2.5 Flare](../../models/gpt-image-2-5-flare/) and
GPT-Image-2.5 Sunburst. The tracker was right.

"We could not find it" is a statement about the search, not about the world.
It took a direct link to the announcement to settle it, and all three models
were recorded once it had.

## What this does not claim

- **Not that trackers are unreliable.** They are fast, and they surface
  releases this project would otherwise miss — several of this month's records
  started as a tracker's listing. In the one case here where a model was missed
  outright, the one that missed it was this project.
- **Not a ranking.** The trackers are not named because the point is the
  mechanism, and each of these errors is one any tracker, this one included,
  can make.
- **Not that the lab is always right.** The lab's own page is the best source,
  and the Grok 4.5 case shows it can still move. That is why sources here are
  archived as snapshots as well as linked live, and why the archiving runs every
  day rather than once.
