# Skill Discovery (factory discover)

## Trigger
`factory discover <feature-id>` — run before the implement phase of a feature
whose spec doesn't pin its skills. Called automatically by the conductor when
entering the plan phase and by the human on demand.

## 1. Detect context
- If graft is configured for the repo: `graft find_all "<keywords>"` where
  keywords come from the feature spec title/description (stopwords removed).
- Else: inspect `package.json` / `go.mod` / import lines (top 200 lines) for
  language/ecosystem terms (e.g. react, nextjs, typescript, go, python).

## 2. Find candidates
Primary: `DISABLE_TELEMETRY=1 npx skills find <keyword...>` (skills.sh CLI,
never the OIDC-gated API). Fallback order if CLI is unavailable or empty:
1. web search `skills.sh <keyword>` (this is permission-gated by the user per
   spec §5.4 — ask "may I research this?" before any web call)
2. find-skills skill (`~/.agents/skills/find-skills` if present)
3. the local `skills/catalog.yaml` topic map.

## 3. Rank
1. Best keyword fit for the ACTUAL feature work (read candidate SKILL.md
   descriptions; pick the one that matches the verbs in the feature).
2. Official/verified origin (vercel-labs, anthropics, microsoft, obra).
3. Most-used (skills.sh install counts / leaderboard position).

## 4. Dedupe & lock
- Skip any candidate already installed to `~/.agents/skills/` (global) or
  `.agents/skills/` (project).
- Project-install chosen skills so they're COMMITTED and travel with the repo:
  `DISABLE_TELEMETRY=1 npx skills add <source> --skill <name> -a opencode --copy -y`
  (project scope → `.agents/skills/<name>/`).
- Record every install in `.agents/skills/skills.lock.json` — dedupe authority
  and deterministic-reinstall source:
```json
{ "installed": [ { "name": "<name>", "version": "<version>", "source": "<owner/repo>", "sha256": "<hash of SKILL.md>", "why": "<feature-id: reason>" } ] }
```
- Audit: `bd update <feature-id> --note "skills: <name>@<version> <source>"`.

## 5. Only much-needed skills
If no candidate is a clear fit, install nothing and note "no project skill
needed" in the issue. The mandatory superpowers set is already enforced by the
conductor — discovery only adds optional skill coverage (use only when needed).
