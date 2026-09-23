---
title: A Hugging Face repository date is not a release date
question: When was an open-weights AI model actually released?
date: 2026-09-23
---

When an open-weights model has no obvious announcement, the easiest date to
reach for is the one on its Hugging Face repository. Hugging Face's API reports
when every repository was created, precisely, for every model, and it looks
authoritative.

It is not a release date, and it is not even a reliable bound on one. The
repository can appear weeks before a model is released, or weeks after.

## Nine models, both directions

These are models added to this dataset in August and September 2026, where the
lab's own release date and the repository's creation date were both checked.

| Model | Repository created | Lab's release date | Repository was |
| --- | --- | --- | --- |
| [AuK](../../models/auk/) | [2026-08-18](https://huggingface.co/tencent/AuK) | [2026-09-09](https://github.com/Tencent-Hunyuan/AuK) | 22 days early |
| [Hy-MT2](../../models/hy-mt2-1-8b/) | [2026-05-11](https://huggingface.co/tencent/Hy-MT2-1.8B) | [2026-05-21](https://github.com/Tencent-Hunyuan/Hy-MT2) | 10 days early |
| [Qwen-Image-2.1](../../models/qwen-image-2-1/) | [2026-09-14](https://huggingface.co/Qwen/Qwen-Image-2.1) | [2026-09-20](https://qwen.ai/blog?id=qwen-image-2.1) | 6 days early |
| [Hy3](../../models/hy3/) | [2026-07-02](https://huggingface.co/tencent/Hy3) | [2026-07-06](https://www.tencent.com/en-us/articles/2202386.html) | 4 days early |
| [Hy4 preview](../../models/hy4-preview/) | [2026-08-27](https://huggingface.co/tencent/Hy4-preview) | [2026-08-28](https://www.tencent.com/tencent-releases-and-open-sources-tencent-hy4-preview/) | 1 day early |
| [MiMo-V2.6-Pro](../../models/mimo-v2-6-pro/) | [2026-09-21](https://huggingface.co/XiaomiMiMo/MiMo-V2.6-Pro-RL) | [2026-09-22](https://mimo.mi.com/docs/en-US/updates/model) | 1 day early |
| [DeepSeek-V4.1-Flash](../../models/deepseek-v4-1-flash/) | [2026-09-10](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) | [2026-09-10](https://api-docs.deepseek.com/updates) | the same day |
| [DeepSeek-V4-Flash-Vision-Exp](../../models/deepseek-v4-flash-vision-exp/) | [2026-08-31](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp) | [2026-08-21](https://api-docs.deepseek.com/updates) | 10 days late |
| [Qwen3.8-Flash-Next](../../models/qwen-3-8-flash-next/) | [2026-08-24](https://huggingface.co/Qwen/Qwen3.8-Flash-Next) | [2026-08-03](https://qwen.ai/blog?id=qwen3.8-flash-next) | 21 days late |

Each release date is the one the lab states on the linked page. Each repository
date is the creation date Hugging Face's API reports for that repository, as
read in September 2026.

## Why it runs both ways

**Early**, most likely because labs stage. A repository can be created
privately while weights are uploaded and a model card is written, then made
public on launch day, and Hugging Face records when it was created, not when it
became visible. That explanation is an inference, not something the repositories
record — but it fits, and it means a model can look three weeks old before
anyone could download it.

**Late**, because the weights are not always the release. DeepSeek launched
DeepSeek-V4-Flash-Vision-Exp on its API; the repository followed ten days later.
Qwen announced Qwen3.8-Flash-Next on its blog on August 3, and the weights
repository appeared three weeks after that. A reader dating either model by its
repository would place the release after it had already happened.

So the repository date is neither the release date nor a safe lower or upper
bound for it. It is the date a repository was created, which is a fact about
the repository.

## This project fell for it too

The site's own discovery pipeline drafts records for open-weights models from
their Hugging Face cards, and the first drafts took the repository date as the
release date. Two of them were wrong in exactly the ways above: the draft for
Qwen's Flash model was three weeks late, and the draft for DeepSeek's vision
model was ten days late, and unaware that DeepSeek had already retired it. Both
were caught in review, and every draft now opens with the instruction to
replace the date with the lab's own.

## What this does not claim

- **Not that Hugging Face is wrong.** The creation date is exactly what it says
  it is. The mistake is reading it as something else.
- **Not a random sample.** These are the records added over two months where
  both dates were checked. They show that the gap exists and runs both ways;
  they do not measure how often.
- **Not that a same-day match proves anything.** DeepSeek-V4.1-Flash's
  repository and release share a date, but that was only knowable by checking
  DeepSeek's own change log.
