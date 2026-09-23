---
title: Jev is the first model this dataset had no category for
question: What is TypeSafe AI's Jev, and is it a large language model?
date: 2026-09-23
---

Every model in this dataset is filed by what it produces. A language model
produces text; an image model, an image; a speech model, audio. When TypeSafe
AI released [Jev](../../models/jev/) on September 15, 2026, none of those fit,
because Jev does not produce any of them. It produces decisions.

## What Jev does

You give Jev a *state* — a description of the situation at hand — and a set of
*typed questions* about it, such as a yes-or-no question. It answers every
question at once, each with a probability. TypeSafe's
[announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
puts the difference from a language model plainly: Jev

> outputs all probabilities in parallel instead of autoregressively generating by token.

A language model asked the same questions writes its answers out one token at a
time, and a program then has to parse the text back into values. Jev skips both
steps: the answers arrive as values, with a confidence attached to each.
TypeSafe calls this a **System One** model — borrowing psychology's name for
fast, intuitive thinking, popularised by Daniel Kahneman — and its documentation is built around the small
judgements software makes all day: routing, scoring, classifying, rather than
conversation.

It is served through TypeSafe's API, as `jev-1.13`.

## What it gives up, in its own documentation

TypeSafe publishes a page on where `jev-1.13` goes wrong. It says the model
[struggles with tasks that require numeric precision](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
can be quite literal in its understanding, and has trouble with extra levels of
indirection. Its advice includes keeping arithmetic in code and spelling out
each condition exactly.

That is what the trade looks like. A model that answers in one parallel pass
has no room to write out intermediate steps, so it suits single judgements and
struggles with anything that needs a chain of them.

## Why it is not filed as a language model

This dataset's model types answer one question: what does the model produce?
Filing Jev as a language model would count a model that emits no text among the
LLMs, in every chart that splits the dataset by type. So it has a type of its
own, `decision`, added eight days after it launched.

A new type is only worth adding if it stays narrow, so it has an inclusion test
with four parts, all of which must be evidenced by the lab's own documentation
([TAXONOMY §6a](../../taxonomy/)):

1. The model's primary output is an answer of a declared type — a choice, a
   boolean, a number, a label — not free text.
2. Each answer comes with a probability, as part of the output.
3. The answer is not produced by generating text token by token.
4. The questions and their answer types are supplied at request time.

Each part exists to keep something out. A language model with a JSON mode
already returns structured answers, but generates them as tokens — that fails
the third. A reranker already scores without generating text, but only answers
one fixed question, relevance — that fails the fourth, and so does any
classifier trained for a single task.

## An imitation within a week

Two days after the launch, an independent developer published
[Kev](https://github.com/jaredpalmer/kev): in its own description, a tiny
Jev-like family of decision models built on top of Qwen 3.5, which you can
train and run yourself.
It is not recorded here: it is one person's fine-tune of another lab's model,
and a release in this dataset needs a lab behind it. But it shows how quickly
the idea was picked up.

## What this does not claim

- **Not that Jev is better than a language model.** It does something
  different. Its own documentation sends arithmetic back to ordinary code, and a
  model that produces no text is no help where the output has to be text.
- **Not a trend.** At the time of writing, Jev is the only model in this
  dataset that passes the test. One is enough for a type when nothing else
  describes it; it is not enough to call it a direction for the field.
- **Not TypeSafe's performance figures.** Its speed and cost comparisons appear
  in coverage of the launch, but this dataset has not verified them, so they
  are not repeated here. Jev is also recorded as a
  [milestone](../../milestones/typesafe-jev/), for the event rather than the
  model.
