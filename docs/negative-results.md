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


---

## Reusing the tools we already installed, and the tools we researched

**Status: audited 2026-10-16. Two verdicts recorded, and one correction.**

### graft: a good CLI, a real defect that was ours, and one call ever

> **Corrected 2026-10-17.** This entry originally read *"the CLI works, the
> MCP is broken, and we never called it once"* and carried three claims. **Two
> of them were false and the third was misread.** The retraction is kept here
> rather than by rewriting history, because *how the false claim was produced*
> is the useful part. graft was measured and removed; the measurement was never
> in doubt. What was in doubt was the reason, and we got the reason wrong
> while believing we had found a defect in a third party.

`graft build` on this repo: **43 of 43 files parsed, 301 nodes (245 function),
798 edges, 43 cards, 5.1 seconds, no API key, $0.** It parses Node `.mjs`
correctly and writes per-file skeletons. `graft/scripts/factory-mcp.md` is
2,559 bytes of pure signatures for a 30,000+ byte source file.

Its own accounting, on our own code:

```
graft grep "disabled"                    -> 40,750 tokens saved (92%)
graft skeleton scripts/factory-mcp.mjs  -> 14,919 tokens saved (96%)
```

So the "about 10x cheaper" claim is **14x to 28x** in practice. The technology
is good.

**RETRACTED: "the MCP surface returns nothing."** It was true of our *test*,
and we reported it as a defect in graft. `graft_find_code` and `graft_file_api`
did report *"no definitions indexed"* for `scripts/factory-mcp.mjs`. But graft
**resolves its repository from the session's working directory**, so every call
we made had been issued from a directory with no graph in it. The empty result
was the correct answer to the question actually asked. The operator had already
named the cause - *"it happen when you try run examples it changes directory
and you lose graft"* - and I filed a seven-sighting guards-present-effects-absent
finding against a third-party tool on my own broken test instead of believing
the person in front of me. **A negative result that indicts the instrument is
the instrument's fault until proven otherwise.** Check whether your own probe
ran where you think it ran before it indicts anybody.

**The part that matters, and the part that was never in doubt: across four
factory runs, not one `graft_*` tool call was ever made.** Later measurement
put the number exactly: **40,467 recorded tool calls, 1 graft call, ever** - and
that one was in `etsy-shop-agent`, a project the factory never touched. Zero
graft commands in PowerShell history. 16 telemetry events, all logged the same
day by our own audit, against a `firstRunAt` 25 days earlier and nothing in
between. Its 1,437 graph cards were built and last touched two seconds apart,
then untouched for 17 days.

The bio-link run's `graft ok (handshake: 0 tools legitimate without graph)` was
**not** a failure and **not** "zero tokens saved". It was graft correctly
reporting that it had no graph for the directory it was asked about. Same root
cause as the retraction above; I read a working refusal as a broken tool.

`factory-mcp.mjs audit` listed graft as bundle-owned and enabled, which reads
like an endorsement it never earned. **That** part was right.

**The installed thing and the used thing are different things.** That is the
same shape as our own gates: documented is not enforced.

### DCP: working, and it is carrying the session

`dcp.jsonc` and the turn-nudge override are written by our own installer. It
fires on essentially every turn, and its compressions have preserved every
commit hash, measured number, verbatim user quote, and retraction correction
across dozens of compressions in one session.

**Weakness, honestly:** state has to be re-derived after compression at least
three times in a long session, and a compression makes *"I was wrong about
this"* easy to skim past. That is inherent to summarising, not a DCP fault. The
mitigation is the standing rule: re-verify anything load-bearing rather than
trusting a summary.

DCP logs nothing to `opencode.log`, so there is no usage telemetry for it at
all. The only evidence it works is that it fires and the session survives.

### Do not migrate context compression

`ranxianglei/billion-context` is a real technique: pagoda-tiered summary
blocks, incremental-only compression, server-side range folding. The evidence
is unusually honest - production logs, no window violations, 94.2% cache-read
share. Four reasons not to move to it:

1. **Our sessions are too short.** 62% of its compressed tokens come from the
   1.3% of sessions with more than 1,000 messages. Ours run to hundreds of
   turns, and there is no evidence the effect survives at our lengths.
2. **It carves out our class.** *"Verbatim-history task classes - audits,
   compliance, forensics, simultaneous multi-constraint refactors whose
   constraint union exceeds any digest - lie outside the support range."* We
   are a multi-constraint requirement-recall system. That is us, by name.
3. **Most of the gain is doctrine text.** Its own quiescent control - no
   compression at all - reproduces nearly the entire reduction from doctrine
   text alone. **Our installer already writes doctrine text.**
4. **Provenance.** The author is DCP's most vocal rejected contributor, with
   roughly 20 issues closed unread. This is a migration from one maintainer's
   successor, not a neutral tool.

### The correction: "Pi-only" is a porting cost, not a rejection

Fifteen tools were read. Thirteen were rejected, and the reason given for
several was that they target the Pi agent and have no opencode port.

**That reason is wrong.** A packaging detail is not a verdict. The correct
question is whether the *mechanism* is worth rebuilding here. Ranked by what
would actually help this factory:

| mechanism | from | worth porting because |
|---|---|---|
| Evidence required before a completion claim | pi-advisor | attacks guards-present-effects-absent, our top defect |
| Recall what did not work, and why | pi-hermes-memory | `negative-results.md` has 2 entries and 0 recall paths |
| Corrections saved immediately | pi-hermes-memory | our objections arrive in a channel nothing binds |
| Proceed / revise / blocked on repeated calls | pi-advisor | loop detection that can actually stop something |
| Only stdout enters context | context-mode | its own numbers: 98% with hooks, 60% without |
| Session state in FTS5, not scrollback | context-mode / engram | BM25 retrieval beats re-deriving |
| Fail closed; unknown suppression is a violation | agent-simple-english | a guard that can fail, by construction |
| Unknown rule id is itself a hard error | agent-simple-english | you cannot silence a rule that does not exist |
| Do not silently substitute the model | pi-web-search | refusing to guess, twice |
| Check the page after the click | pi-agent-browser-native | "command success alone does not prove the app changed" |
| Proof screenshots | BetterWright | evidence a human can see |
| External side effects must be idempotent | kxm | we have never thought about phase-machine idempotency |

### The one finding that survived all fifteen

**Every tool sent landed on something we have, could do, or already do by
hand.** The wins were in discipline and enforcement, not in swapping tools.

The most useful number found in the entire survey is context-mode's: **about
98% context saved with hooks, against about 60% without.** Hooks intercept a
tool call and can refuse it. Instruction files can only ask. That is our own
defect class, measured by someone else - `conductor.md` says the gates are
hard stops, and they are not, because prose cannot refuse anything.

---

## A claim with no pointer to its evidence

**Status: banked 2026-10-17. The tool is rejected; the mechanism is adopted.**

### Where it came from

OpenWiki, rejected earlier in the survey above, and rejected for a sound
reason: it documents *what the code is*, and our worst failure was never that
the code was undescribed. It was that the code was the **wrong** thing. It also
writes `AGENTS.md`, which bio-link already uses for load-bearing beads
instructions. **None of that is an argument against its one good idea.**

That idea, verbatim: *"each Claim points to versioned source evidence... when
that evidence changes or disappears, OpenWiki identifies which facts need to be
confirmed, rewritten, or retired."*

### Why it matters to us specifically

**Every serious defect in this factory's history is a claim that outlived its
evidence.** Three instances, all ours, all in one afternoon:

1. The commit now at `9462f67` carried a message saying an empty requirement
   list no longer disables servers. It did. I wrote the comment and the
   `say()` line and never changed `const want = allow.has(name)`. **The claim
   was written; the effect was not.** The evidence - the code - never supported
   it, and only a test that asserted correct behaviour caught it. Amending the
   commit rather than following it up moved its hash from `2c55650` to
   `9462f67`, and this pointer had to move with it - a dangling hash is the
   same defect one level down: a pointer that no longer resolves.
2. `conductor.md` called the MCP gate "enforced" for months of prose. Nothing
   enforced it. Prose cannot refuse anything (`5da020f` withdrew the word).
3. The entry above: "the MCP is broken", held for a week, pointing at our own
   broken test as if it were a third party's defect.

**In all three the artifact asserting the claim was the only thing wrong.** So
the discipline is not "be careful", which we had. It is: **no claim ships
without naming the thing that would falsify it.**

### What is adopted, concretely

- **A doc claim that asserts behaviour points at the file and line that
  implements it.** Where it does not, either add the pointer or delete the
  claim. Unpointable claims are the ones that rot.
- **A doc claim backed by a measurement carries the number and the method**, so
  a reader can tell whether it still holds. The graft measurement is written
  that way, which is why it survived my own bad reading of a different part of
  the same story.
- **`negative-results.md` needs recall paths, and this file's own survey row
  already says so** - *"`negative-results.md` has 2 entries and 0 recall
  paths"*. Measured now, at the time of writing: **3 recall paths** -
  `conductor.md`, `HOW-INSTALL.md` and `discovery.md` all name the file. But all
  three named it *generically*, as a place a measurement lives. **None of them
  pointed at the retraction above**, so a reader arriving via any of them would
  have read "the MCP is broken" as current fact. A pointer to a document is not
  a pointer to the part that would change your mind.
  **That is the fixable part of OpenWiki's idea, and it is the part we were
  already failing at without a tool to blame.** The fix is now made from this
  side: `conductor.md` names the correction itself, not just the file.

### Not adopted

No versioned-evidence store, no claim graph, no `AGENTS.md` writes. The
mechanism is a *discipline above a pointer*, not a system to install. If the
pointers rot once more, that is the moment to build the store - and it will be
a decision made from a measured failure, which is the only way this factory has
ever adopted anything.
