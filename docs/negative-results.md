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

## A check that reports the last failure it saw, and calls it the present

The installer ended every run with `FAIL plugins: zero load failures`. The
plugin really was broken - but install #5 shipped the fix and still reported
the failure, because the check reads the newest *completed* run and the run that
was starting while the fix landed still held the old failures:

```
last failure in that run   10:14:50.076
the fixed file written     10:14:50.095     19 ms later
```

Every failure the check saw happened before the thing that would prevent them
existed. A check with no notion of time cannot tell a fresh result from a stale
one, so it will keep reporting a fixed defect until something restarts the thing
it watches - and it will keep doing so forever, because it is reading a record
of the past and calling it the present.

**The general form: a verdict with no timestamp is a claim about the last thing
that happened, whatever you meant it to be a claim about.** The same mistake ran
in both directions in one afternoon - I once reported a failure as happening
*after* a fix when it was 7 ms *before* it. Both times a timestamp was compared
against the wrong reference, and in both cases the number was confident and
wrong.

This is the same shape as the entry above about pointers that no longer resolve.
The claim outlived the evidence, except here the evidence is *still being
written* and nobody marked the boundary.

What would have caught it, and did not: the fix was verified on disk before the
install's own verdict was read. Reading the verdict first would have reported a
working plugin as broken, on the strength of a log line that predates the file.

## A suite that passes only on the machine it was written on

Removing `graft` produced a green MCP suite - 252 passed, 0 failed - and then
the installer failed on the same file with 7 failures, all of them saying
`--allow names graft, which is not configured`.

Both results were correct. The suite resolved `--allow` against
`~/.config/opencode/opencode.json`, and that file has graft in it on the machine
where the suite was written. The installer runs with a sandboxed home where it
does not. The suite did have a temp home, but it created it **for the HTTP
cache**, partway down the file, after every config-reading test had already run.
The mechanism was right and its placement was not.

So the number I had been reporting - and the reason I said the suite was green -
was a statement about one machine, not about the code. **A suite that passes only
where it was written is not a passing suite.** I had removed the dependency from
the product, left it in the tests, and certified the result in the shell that
happened to satisfy it.

The tell was available the whole time. The fixtures wrote
`config("jsonc-global.json", ...)` into a temp directory, and no `scope` call ever
passed `--config`. That fixture was dead code that looked load-bearing: a
declaration in the shape of a setup, checked by nothing.

The fix is placement, not effort. The home redirect is now the first statement in
the file, before any fixture is built, and a `declareServer(name, server)` helper
declares into the sandbox user config where `--allow` is actually checked.
Verified by removing one declaration: the suite goes 252/0 to 251/1 on exactly the
assertion that depended on it, and the file restores byte-identical. A declaration
nobody reads would not have done that.

**What would have caught it, and did not:** running the suite where it will
actually run. A suite is a claim about an environment, and the environment is
part of the claim. "Green here" and "green there" are different claims, and only
one of them had ever been tested.

**The rule that generalises: a test which reads anything outside its own fixture
is not hermetic, even when it has a sandbox.** Point the sandbox at every input,
at the *start*, or do not claim the sandbox exists.


## An import failure wearing a shape-error costume

`915f26f` says it fixes the opencode-pty plugin. **It does not, and I have been
rewriting the export shape of a module that cannot be imported.**

The error opencode prints is a complaint about a plugin's *shape*:

    Plugin must export a default definition with an id and an effect or setup
    function.  (cause: SchemaError(Missing key at ["default"]))

Two things in that sentence matter and both had to be read before the first is
acted on. The first - "must export a default definition" - is a claim about the
form of the export. The second - `Missing key` **at** `["default"]` - is a claim
about the module *namespace*, and it says there is no `default` at all. A plugin
that exported something in the wrong shape would still have a `default` key. A
module whose import threw before it finished evaluating has none.

So the loader was reporting an import error in the vocabulary of a schema error.
Both a bare re-export and an inline `export default { … }` fail identically,
because both resolve the same module, and that module is the thing that is broken.

And it is:

    opencode-pty@0.4.0 imports bun-pty/src/index.ts

TypeScript, under `node_modules`, where neither Node nor Bun will strip types.
`await import()` of either entry point fails with *"Stripping types is currently
unsupported for files under node_modules"*. Verified against both published
entries:

    dist/src/v2/index.js   FAIL  Stripping types is currently unsupported
    dist/index.js          FAIL  Stripping types is currently unsupported
    dist/src/index.js      ABSENT

**The honest fix is not a better shim. It is to ask Node whether the module
imports at all, and if it does not, write no shim and say why.** Both installers
now do that. The check goes from "this check failed since install #2" to "here is
the exact reason, and here is what we did about it".

The second half is a check that had been wrong for a different reason. It typed
in the three plugins it expected to see loading:

    ids.includes("opencode-beads") && ids.includes("opencode-pty") && ids.includes("...dcp")

That is a property of one machine wearing the costume of a property of the
bundle, and it went red the moment the installer did the right thing - because
"correctly skipped a plugin that cannot load" must not look like "a plugin is
missing". The expectation is now **derived** from the plugins directory and the
config's own `plugins` array. The check's name is unchanged, because two documents
reference it by name and renaming it would break doc closure; the count in its
basis is now a measurement rather than a typing.

**What this cost:** `915f26f`, and about a day of rewriting the same line. The
tell was in the message the whole time - the error said *shape*, and the cause
said *namespace*, and I believed the summary over the cause for far too long.

**The rule: a loader's headline names the layer it blames. Read the cause.**
"Malformed input", "invalid schema", "unexpected token" - each of those is a
statement about what the loader saw, not about where the fault started. The
*cause* is the only part that ran earlier in the process, and it is therefore the
only part that can tell you what actually went wrong.

**And the one that kept producing false confidence:** `915f26f` is committed with
a message claiming a fix that its own commit does not contain. A test suite
asserted the shape I had written and passed, so the check that was supposed to
catch this only ever measured whether my idea of the problem was spelled
correctly. When a check and the thing it checks were both written in the same
minute by the same person, the check is not evidence. It is a witness.

## The installer certifying an installation it did not perform

Every one of this bundle's 487 tests runs a script in the repo against a
fixture. None runs the installer. None executes the *installed* copy of
anything. So the boundary where the repo becomes an installation was simply
never crossed by a test - and defects that live only on that boundary were
invisible to all of them, including to me.

The first test to cross it found two defects on its first run.

**One, now fixed.** `test-selfcheck.mjs` asserts that a commit hash cited in
the docs still resolves from HEAD. That needs a git checkout. Installed from a
bundle directory that is not a clone, the installer died at `run_tests` with a
non-zero exit **even though every single file installed perfectly** - a check
about this repository's own doc hygiene was sitting inside the install gate.
It now reports `inconclusive` when there is no HEAD: not a pass, because a pass
would be decoration, and not a failure either, because refusing to verify
something is not the same as finding it broken. A check that cannot be evaluated
says which it is.

**Two, still open, and it is worse.** `install.sh` writes to `$HOME` - bash
resolves that from the environment. Its own selfcheck runs under node, and
node's `os.homedir()` on Windows reads `USERPROFILE`. Those are different
variables. Point the installer at a different home and it installs there and
then *verifies somewhere else entirely*:

    installer wrote   <temp>/.agents/skills/factory/scripts/...      correct
    selfcheck read    C:/Users/<you>/.agents/skills/factory/scripts/...   wrong

The selfcheck reported PASS on paths it had never touched. It is not that the
value is hard-coded - `homedir()` returned the correct home, the operator's own.
The defect is two dynamic values that can disagree, and the fix is not "make it
dynamic" because it already is. The fix is to resolve the home **once**, let it
be overridden explicitly, and thread that one value through every site - so
there is nothing left to disagree. Today the selfcheck calls `homedir()` at six
separate sites with no override and no `--home` flag, so this is not fixable
from outside at all.

The general form, which is the part worth keeping: **an installer that writes
somewhere and checks somewhere else will, one day, certify an installation it
did not perform - and it will report success while doing it.** A selfcheck
that cannot be pointed at a specific installation is not verifying the install.
That is the whole reason this test exists, and it took two runs of a 35-minute
boundary test to find, which is the honest cost of not having had one.

### Not adopted

No SHIP GATE, no meter token, no receipt log. The second opinion was explicit
that these are guards-on-guards, and that a token whose only proof is that the
suite went red proves the fixture is wired rather than the product. The
adoption oracle already measured the existing tools at one use in 40,467 calls;
a new one would meet the same fate. This test needed no budget and no ceremony,
because it turned out to be forty lines and an hour.

## Fixing it: two homes, made into one

The fix is one line in each installer, and one constant in this file.

`install.sh` resolves every destination from bash `$HOME`. Its own selfcheck
runs under node, where `os.homedir()` reads `USERPROFILE` on Windows and
`$HOME` everywhere else. Pin them equal and the split cannot open:

```bash
# One home, not two.
[ -n "${USERPROFILE:-}" ] && export USERPROFILE="$HOME"
```

`install.ps1` gets the mirror (`$env:USERPROFILE = $HOME`), which is a no-op in
the normal case because it already derived everything from `USERPROFILE` - but
the two installers should agree about what "the home directory" means, and
right now only one of them has to say so.

Then `factory-selfcheck.mjs` resolves its home **once**:

```js
const HOME = (() => {
  const i = process.argv.indexOf("--home");
  return (i !== -1 && process.argv[i + 1]) || homedir();
})();
```

and every check reads `HOME`. Five call sites that each asked the operating
system independently now ask one value. `--home` exists so a caller can name the
installation it means rather than leaving it to whichever variable won.

**The ordering constraint is the part that is easy to get wrong**, and I got it
wrong the first time: I put the `USERPROFILE` assignment *after* the lines that
derive paths from it, which would have re-created the exact split being fixed -
paths derived from the old value, node reporting the new one. **When making two
values equal, assign before deriving anything from either.** No test caught it;
reading the diff did.

### What this does and does not buy

It removes the split. It does not make the selfcheck able to verify an arbitrary
installation on purpose - that is what `--home` is for, and it is deliberately a
separate concern from the equality fix. One line that makes two things agree is
a different kind of change from six call sites threaded through a new parameter,
and keeping them separate means either can be reasoned about on its own.
