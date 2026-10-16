# Negative results

Things that were tried, did not work, and should not be tried again without
something specific having changed. Written so the next run does not spend the
same time.

A negative result here is not a failure. It is a place where the answer is
already known.

---

## Measuring how original a page is, by scoring it against competitors

**Status: shelved 2026-10-17. The instrument does not work.**

### What was built

`scripts/factory-divergence.mjs` (uncommitted, unwired). Crawls an app,
captures a reference corpus of competitor pages, and reports mean similarity.
Zero dependencies. Modes: `capture`, `check`, `selftest`.

The idea came from real evidence. LLM output homogenization is a documented
effect, and it is localized: shared AI tools homogenize **how** work is
expressed, not the approach behind it (arXiv 2607.13077). Homogenization is
also task-dependent — it is undesirable for some outputs and required for
others (arXiv 2509.21267). So a checkable gate was thought to exist: *is this
closer to the category median than chance?*

That remains a good idea. **This implementation of it does not work.**

### The control, and why it failed

An instrument that can detect sameness must score a *known-similar* pair highly.
So: two different link-in-bio sites, same category, scored against each other.

```
check --app https://link.me --reference <corpus containing linktr.ee>

app pages   : 12
threshold    : 0.62 mean similarity

 0.157 mean   max 0.157   /
 0.119 mean   max 0.119   /pricing
 0.115 mean   max 0.115   /faq
 ...
overall mean similarity to reference: 0.070

NOT indistinguishable from the reference set.
```

**Two genuine competitors in the same category scored 0.070 against a 0.62
threshold.** The control that had to score high scored 9x below the trip point.

The consequence is the whole problem: **a real clone would also score ~0.07 and
pass.** The check cannot see the thing it exists to see.

### Why

1. **TF-IDF measures shared vocabulary, not shared form.** TF-IDF amplifies the
   rarest terms, and between two different brands the rarest terms are exactly
   the brand names — "linktr.ee" vs "link.me" vs "Post to All" vs
   "Automations". Shared vocabulary between two same-category sites is small, so
   cosine collapses toward zero *even when the pages look nearly identical*. But
   "looks like everyone else" is about structure, layout and idiom, not about
   naming yourself after your own brand. **The text view measures the wrong
   thing.**

2. **Crawled sub-pages dilute the mean.** `link.me` returned 12 pages including
   `/fifaworldcup`, `/retirementhouse` and `/bdcrictime` — real user-generated
   content that is legitimately unlike a marketing landing page. Those drag the
   mean down and are not where the category identity lives.

A structure/landmark-sequence view existed alongside the text view, but its
contribution was not separable in the combined output, so it was never proven to
discriminate either way.

### The part that generalizes

**`selftest` reported 11 passed, 0 failed the entire time.** It was green while
the instrument was broken.

The selftest only ever used synthetic fixtures. It proved the math ran. It could
not prove the math measured the right thing, because "measures the right thing"
is a claim about the world, not about the code.

This is the same shape as every other guards-present-effects-absent defect the
factory has hit. **A suite that cannot fail is not evidence.** Any new
measurement instrument needs a control drawn from the real domain — a case where
the answer is already known — before its green result is allowed to mean
anything.

### Do not wire this up

`scripts/factory-divergence.mjs` is deliberately **not** referenced by
`conductor.md`, not installed, and **not committed**. It stays untracked on
disk. It is proven not to work, and committing broken code into the repo is how
it gets wired into the pipeline by someone who never reads this file.

If it is ever revived, the first thing required is a **passing control**: two
same-category, different-brand pages scoring above the trip threshold. Until
that number is observed, every result it produces is noise.

Two changes are worth trying, in this order:

1. **Lead on structure, not vocabulary.** Landmark-sequence and layout shape,
   compared on the landing page only. "Looks the same" is a claim about form.
2. **Do not average across a crawl.** Score the page a visitor lands on. Deep
   user-generated sub-pages are not the category's face.

Note also that homogenization is learned in pretraining, so this can buy
distance from the median but never independence from the pull (arXiv
2608.11426). Worth remembering before investing heavily.

---

## Adding a file-format or framework skill without being asked

**Status: not tried, recorded because it looked tempting.**

The factory agent spent 13 minutes unprompted hunting for framework skills
(`npx skills find/add/use`) during the bio-link run, but never once considered
that *design taste* is also a fetchable tool — it took two explicit human
instructions before the design skills were installed.

If role-scoped skills are ever added, this is evidence that **the agent will not
look for them on its own.** The gap is not capability; it is not knowing a tool
exists.
