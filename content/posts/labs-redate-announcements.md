---
title: An AI lab's announcement date can change after it is published
question: Can you trust the date on an AI lab's own announcement page?
date: 2026-09-23
---

The most reliable source for when a model was released is the lab's own
announcement. That is the rule this dataset is built on, and it is the right
rule. It has one weakness, and it is worth seeing concretely: the page is live,
and a live page can change.

## Grok 4.5 was announced on July 8. Its page now says July 16.

xAI's announcement for Grok 4.5 lives at
[x.ai/news/grok-4-5](https://x.ai/news/grok-4-5). Open it today and the date
above the headline reads **Jul 16, 2026**. xAI's newsroom index lists it the
same way.

The Internet Archive captured the same page at 18:08 UTC on July 8, 2026. In
[that capture](https://web.archive.org/web/20260708180848/https://x.ai/news/grok-4-5)
the date above the headline reads **Jul 8, 2026**.

A copy made on July 8 cannot show a date that had not happened yet. So the page
was public on July 8, carrying that date, and at some point afterwards xAI
changed it. This record keeps
[Grok 4.5](../../models/grok-4-5/) at July 8, and its note says why.

We do not know why the date moved. xAI announced wider availability later that
month, and a republished page often takes the date of its republication. But
that is a guess about intent, and the evidence does not need it: what matters is
which date a reader could have seen, and when.

## The failure is invisible without a snapshot

Anyone who cited the live page after the change would have written July 16 and
been right about what the page said. They would have been wrong about when Grok
4.5 was announced, and nothing on the page would have told them.

This is why sources here are archived as dated snapshots as well as linked
live, with a job that captures new ones every day. A live page proves what it says today. A snapshot proves what it said
on the day it was read. The two are different claims, and for dates the second
is the one that matters.

## Some pages carry no date at all

The opposite problem is more common. OpenAI's announcement pages for
[GPT-6 Astra](../../models/gpt-6-astra/) and for GPT-6 Sol and Luna print no
date anywhere on the page. The dates exist, but elsewhere: in OpenAI's news
index and its API changelog. The same was true of GPT-4's announcement, archived
in 2023. A reader who only opens the announcement has nothing to cite.

## A page stamp is not a release date

It cuts the other way as well. xAI's API release notes group entries by month,
and the only full date on the page is **"Last updated: September 21, 2026"**.
Grok 4.7 was released on September 21, so the stamp matched, and this dataset
briefly credited the release notes with a date they never state. The date was
right; the citation was not. xAI's newsroom states it outright, and
[Grok 4.7](../../models/grok-4-7/) now cites that instead.

## What this does not claim

- **Not that xAI did anything wrong.** Republishing a page is ordinary web
  practice. The point is that a live page is a moving target, whoever runs it.
- **Not that this happens often.** It is one case, found because a snapshot
  happened to exist from the right day. How often lab pages are re-dated is not
  something this dataset has measured, and it would take a snapshot of every
  page on its first day to find out.
- **Not that the later date is false.** July 16 is plausibly a real milestone
  for Grok 4.5. It is just not the day it was announced.
