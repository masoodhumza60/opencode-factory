#!/usr/bin/env bash
# opencode-factory machine install (Unix/macOS). Faithful semantic mirror of
# install.ps1: same order, same flags, same artifacts, same merge semantics.
# Usage: ./install.sh [-SkipBd] [-SkipGraft] [-DryRun]
# -SkipBd   : do not install/verify the beads CLI
# -SkipGraft: do not install/patch the graft CLI (plugins+config may still be merged)
# -DryRun   : print every step without changing anything (exits 0)
set -euo pipefail

SKIP_BD=0
SKIP_GRAFT=0
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        -SkipBd|--skip-bd)          SKIP_BD=1 ;;
        -SkipGraft|--skip-graft)    SKIP_GRAFT=1 ;;
        -DryRun|--dry-run|-n)       DRY_RUN=1 ;;
        *) echo "install: unknown option: $arg" >&2; exit 2 ;;
    esac
done

if ! command -v node >/dev/null 2>&1; then
    echo "install: node >= 20 is required (install from https://nodejs.org)" >&2
    exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]*1 >= 20' 2>/dev/null)" != "true" ]; then
    echo "install: node >= 20 is required (found $(node --version 2>/dev/null || echo unknown); install from https://nodejs.org)" >&2
    exit 1
fi

say() { printf '%s\n' "$*"; }
dry() { say "[dry-run] $*"; }

bundle="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
oc_config="${HOME}/.config/opencode"
agents_skills="${HOME}/.agents/skills"
project_skills="${bundle}/.agents/skills"
node_path="$(node --print process.execPath)"
graft_pkg=""

# --- dirs --------------------------------------------------------------------
ensure_dirs() {
    for d in "$oc_config/plugins" "$oc_config/commands/beads" "$oc_config/commands/factory" "$oc_config/agents" \
        "$agents_skills/factory" "$project_skills"; do
        if [ "$DRY_RUN" = 1 ]; then dry "mkdir -p $d"; else mkdir -p "$d"; fi
    done
}

# --- graft package-dir resolution -------------------------------------------
# Manager global-root probe order pnpm -> bun -> npm; first root that contains a
# live graft package wins. Falls back to the pnpm store scan (virtual stores /
# junctions keep the real pkg deeper). Prints the package dir or exits 1.
find_graft_dir() {
    local m="" probe=""
    for m in pnpm bun npm; do
        command -v "$m" >/dev/null 2>&1 || continue
        case "$m" in
            pnpm) probe="$(pnpm root -g 2>/dev/null || true)" ;;
            bun)  probe="$(bun pm root -g 2>/dev/null || true)" ;;
            npm)  probe="$(npm root -g 2>/dev/null || true)" ;;
        esac
        if [ -n "$probe" ] && [ -d "$probe/@nanonets/graft/dist" ]; then
            printf '%s\n' "$probe/@nanonets/graft"
            return 0
        fi
    done
    for base in "${PNPM_HOME:-$HOME/.local/share/pnpm}/global" "$HOME/.local/share/pnpm"; do
        [ -d "$base" ] || continue
        local found=""
        found="$(find "$base" -maxdepth 3 -type d -name node_modules 2>/dev/null | while read -r d; do
            if [ -d "$d/@nanonets/graft/dist" ]; then printf '%s\n' "$d"; break; fi
        done | head -n 1)" || true
        if [ -n "$found" ]; then printf '%s\n' "$found/@nanonets/graft"; return 0; fi
    done
    return 1
}

# Fresh-install manager order: pnpm -> bun -> npm (npm ships with node >= 20).
first_manager() {
    for m in pnpm bun npm; do
        if command -v "$m" >/dev/null 2>&1; then printf '%s\n' "$m"; return 0; fi
    done
    return 1
}

# --- bd -----------------------------------------------------------------------
install_bd() {
    if [ "$DRY_RUN" = 1 ]; then
        dry "$bundle/executables/install-bd.sh --dry-run"
        dry "verify: bd version"
        return
    fi
    "$bundle/executables/install-bd.sh"
    bd version >/dev/null 2>&1 || { echo "install: bd version check failed after install" >&2; exit 1; }
    say "bd ready."
}

# --- graft --------------------------------------------------------------------
install_graft() {
    local found="" m="" cmd=""
    found="$(find_graft_dir || true)"
    if [ "$DRY_RUN" = 1 ]; then
        if [ -n "$found" ]; then
            dry "graft already installed locally; skipping install"
        else
            m="$(first_manager || echo npm)"
            if [ "$m" = npm ]; then cmd="npm install -g @nanonets/graft@0.18.0"; else cmd="$m add -g @nanonets/graft@0.18.0"; fi
            dry "$cmd  (auto-select pnpm/bun/npm; npm default)"
        fi
        local patch_dir="${found:-<resolved-graft-dir>}"
        if command -v powershell >/dev/null 2>&1; then
            dry "node \"$bundle/scripts/graft-patch-extract.mjs\" --dir \"$patch_dir\""
            dry "powershell -NoProfile -ExecutionPolicy Bypass -File \"$bundle/scripts/graft-patch-store.ps1\" -PackageDir \"$patch_dir\""
        else
            dry "skip graft patches (Windows-only kotlin-optional extract + win32-x64 prebuild rename; no PowerShell here)"
        fi
        dry "verify: graft --version"
        graft_pkg="$found"
        return
    fi
    if [ -z "$found" ]; then
        m="$(first_manager)" || {
            echo "install: no package manager found to install graft (node >= 20 ships npm)" >&2
            exit 1
        }
        if [ "$m" = npm ]; then
            npm install -g @nanonets/graft@0.18.0
        else
            "$m" add -g @nanonets/graft@0.18.0
            # Safety net: the chosen manager ran clean but the pkg dir still
            # doesn't resolve -> redo through npm (always present via node).
            if ! find_graft_dir >/dev/null 2>&1; then
                say "graft not resolvable after $m install; retrying with npm..."
                npm install -g @nanonets/graft@0.18.0
            fi
        fi
        found="$(find_graft_dir)" || { echo "install: graft not found after install" >&2; exit 1; }
    fi
    graft_pkg="$found"
    if command -v powershell >/dev/null 2>&1; then
        node "$bundle/scripts/graft-patch-extract.mjs" --dir "$graft_pkg"
        powershell -NoProfile -ExecutionPolicy Bypass -File "$bundle/scripts/graft-patch-store.ps1" -PackageDir "$graft_pkg"
    else
        say "note: graft patches skipped (Windows-only kotlin-optional extract + win32-x64 prebuild rename; no PowerShell here)."
    fi
    if graft --version >/dev/null 2>&1; then :; else echo "install: graft --version check failed" >&2; exit 1; fi
    say "graft ready ($graft_pkg/dist/cli.js)."
}

# --- plugins ------------------------------------------------------------------
install_plugins() {
    if [ "$DRY_RUN" = 1 ]; then
        dry "cp \"$bundle/plugins/opencode-beads.ts\" \"$oc_config/plugins/\""
    else
        cp "$bundle/plugins/opencode-beads.ts" "$oc_config/plugins/"
    fi
    # resolve the opencode-pty v2 index: newest match under the opencode npm cache
    local pty_index=""
    pty_index="$(ls -t "$HOME/.cache/opencode"/npm/opencode-pty@*/*/node_modules/opencode-pty/dist/src/v2/index.js 2>/dev/null | head -n 1)" || true
    if [ -z "$pty_index" ]; then
        if [ "$DRY_RUN" = 1 ]; then
            say "[dry-run] warning: opencode-pty v2 index not found in cache; render would fail here"
        else
            echo "install: opencode-pty v2 index not found. Run opencode once so it installs opencode-pty, then re-run install." >&2
            exit 1
        fi
    fi
    if [ -n "$pty_index" ]; then
        if [ "$DRY_RUN" = 1 ]; then
            dry "render \"$bundle/plugins/opencode-pty.ts.tmpl\" (substitute __OPENCODE_PTY_V2_INDEX__ = $pty_index) -> \"$oc_config/plugins/opencode-pty.ts\""
            dry "export { default } from \"file:///$pty_index\";"
        else
            # substitute the BARE absolute path (the template already carries file:///)
            sed "s|__OPENCODE_PTY_V2_INDEX__|$pty_index|" "$bundle/plugins/opencode-pty.ts.tmpl" > "$oc_config/plugins/opencode-pty.ts"
        fi
    fi
}

# --- commands + agent ----------------------------------------------------------
install_commands() {
    for f in "$bundle"/commands/beads/*.md; do
        if [ "$DRY_RUN" = 1 ]; then dry "cp \"$f\" \"$oc_config/commands/beads/\""; else cp "$f" "$oc_config/commands/beads/"; fi
    done
    for f in "$bundle"/commands/factory/*.md; do
        if [ "$DRY_RUN" = 1 ]; then dry "cp \"$f\" \"$oc_config/commands/factory/\""; else cp "$f" "$oc_config/commands/factory/"; fi
    done
    if [ "$DRY_RUN" = 1 ]; then
        dry "cp \"$bundle/agents/beads-task-agent.md\" \"$oc_config/agents/\""
    else
        cp "$bundle/agents/beads-task-agent.md" "$oc_config/agents/"
    fi
}

# --- config merge ---------------------------------------------------------------
merge_config() {
    local user_cfg="$oc_config/opencode.json"
    local pin=""
    pin="$(head -n 1 "$bundle/plugins/dcp.pin" || true)"
    local graft_cli_js=""
    if [ -n "$graft_pkg" ]; then graft_cli_js="$graft_pkg/dist/cli.js"; fi

    if [ "$DRY_RUN" = 1 ]; then
        dry "node --print process.execPath => $node_path"
        dry "write temp snippet: bundle snippet + mcp.servers.graft = {type:local, command:[$node_path, ${graft_cli_js:-<resolved-graft-cli.js>}, mcp], disabled:false} + plugins += [$pin]"
        if [ -f "$user_cfg" ]; then dry "user config: $user_cfg (read-only; purely additive merge)"
        else dry "echo '{}' > \"$user_cfg\"   (no existing config)"; fi
        dry "node \"$bundle/scripts/merge-config.mjs\" --snippet <resolved-snippet> --user \"$user_cfg\" --out \"$user_cfg\""
        return
    fi
    if [ ! -f "$user_cfg" ]; then echo '{}' > "$user_cfg"; fi
    if [ -z "$graft_cli_js" ]; then
        # -SkipGraft path: graft wasn't installed here, resolve the cli.js for the config anyway
        graft_pkg="$(find_graft_dir)" || { echo "install: graft not found; required for mcp.servers.graft config" >&2; exit 1; }
        graft_cli_js="$graft_pkg/dist/cli.js"
    fi
    local snippet_resolved=""
    snippet_resolved="$(mktemp)"
    trap 'rm -f "$snippet_resolved"' EXIT
    node - "$bundle" "$snippet_resolved" "$node_path" "$graft_cli_js" "$pin" <<'EOF'
const fs = require("fs");
const [bundle, out, nodePath, graftCliJs, pin] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(bundle + "/config/opencode.snippet.json", "utf8"));
base.plugins = [pin];
base.mcp = base.mcp || {};
base.mcp.servers = base.mcp.servers || {};
base.mcp.servers.graft = { type: "local", command: [nodePath, graftCliJs, "mcp"], disabled: false };
fs.writeFileSync(out, JSON.stringify(base, null, 2) + "\n");
EOF
    node "$bundle/scripts/merge-config.mjs" --snippet "$snippet_resolved" --user "$user_cfg" --out "$user_cfg"
    say "merged config -> $user_cfg"
}

# --- skills ---------------------------------------------------------------------
install_skills() {
    local src_sk="$bundle/skills/factory/SKILL.md"
    local docs=(conductor.md how-factory-works.md plan-format.md discovery.md mcp-judging.md)
    if [ "$DRY_RUN" = 1 ]; then
        dry "cp \"$src_sk\" \"$agents_skills/factory/\""
        dry "cp \"$bundle/skills/verify-app/SKILL.md\" \"$agents_skills/verify-app/\""
        dry "cp \"$bundle/docs/conductor.md\" \"$bundle/docs/how-factory-works.md\" \"$bundle/docs/plan-format.md\" \"$bundle/docs/discovery.md\" \"$bundle/docs/mcp-judging.md\" \"$agents_skills/factory/docs/\""
        return
    fi
    if [ -f "$src_sk" ]; then
        if [ -f "$bundle/skills/verify-app/SKILL.md" ]; then
            mkdir -p "$agents_skills/verify-app"
            cp "$bundle/skills/verify-app/SKILL.md" "$agents_skills/verify-app/"
            say "verify-app skill installed -> $agents_skills/verify-app/SKILL.md (generates the project's own verification skill)"
        fi
        cp "$src_sk" "$agents_skills/factory/"
        mkdir -p "$agents_skills/factory/docs"
        for d in "${docs[@]}"; do cp "$bundle/docs/$d" "$agents_skills/factory/docs/"; done
        say "factory skill installed -> $agents_skills/factory/SKILL.md (self-contained: docs/ ships conductor + how-factory-works)"
    else
        say "warning: $src_sk not in bundle yet (conductor skill lands with the docs/discovery task); skip - re-run install once it is present."
    fi
    # NOTE: .agents/skills/skills.lock.json is created by `factory discover`, not by install.
}

# --- mandatory third-party skills ----------------------------------------------------
# The catalog is data; factory-skills.mjs is the only thing that acts on it. This
# runs BEFORE the selfcheck on purpose - the selfcheck FAILs when a mandatory skill
# is missing, so installing afterwards would guarantee a red install on a fresh
# machine. A network failure is not hidden: the script prints the fix line and this
# exits, the same way a missing graft does, because a machine that reaches phase 7
# with no commit-work to run has already failed quietly at install time.
install_mandatory_skills() {
    local skill_script="$bundle/scripts/factory-skills.mjs"
    if [ "$DRY_RUN" = 1 ]; then
        dry "node \"$skill_script\" install --dry-run"
        return
    fi
    if [ -f "$skill_script" ]; then
        node "$skill_script" install || { echo "install: factory-skills.mjs install failed - fix the line it printed, then re-run install." >&2; exit 1; }
    else
        say "warning: $skill_script not in bundle yet; mandatory skills not installed."
    fi
}

# --- dcp turn-nudge -----------------------------------------------------------------
# Runs before the selfcheck on purpose: the selfcheck reports on this override,
# so writing it first keeps a fresh install green instead of failing on a file
# the installer has not created yet.
install_dcp_prompts() {
    local script="$bundle/scripts/dcp-prompts.mjs"
    if [ "$DRY_RUN" = 1 ]; then
        dry "node \"$script\""
        return
    fi
    if [ -f "$script" ]; then
        node "$script" || { echo "install: dcp-prompts.mjs failed" >&2; exit 1; }
    else
        say "warning: $script not in bundle yet; skipping the DCP turn-nudge override."
    fi
}

# --- selfcheck tests ----------------------------------------------------------------
# A check that cannot fail is decoration, and the bundle has shipped one. These
# tests are what turn "can this check fail?" into a property the installer
# enforces rather than something a human remembers to poke at.
run_tests() {
    if [ "$DRY_RUN" = 1 ]; then
        dry "node \"$bundle/scripts/test-selfcheck.mjs\""
        dry "node \"$bundle/scripts/test-install-idempotency.mjs\""
        dry "node \"$bundle/scripts/test-factory-phase.mjs\""
        dry "node \"$bundle/scripts/test-factory-plan.mjs\""
        dry "node \"$bundle/scripts/test-factory-skills.mjs\""
        dry "node \"$bundle/scripts/test-factory-mcp.mjs\""
        return
    fi
    for t in test-selfcheck.mjs test-install-idempotency.mjs test-factory-phase.mjs test-factory-plan.mjs test-factory-skills.mjs test-factory-mcp.mjs; do
        local path="$bundle/scripts/$t"
        if [ ! -f "$path" ]; then
            say "warning: $path not in bundle yet; skipping."
            continue
        fi
        # Capture rather than discard: a suite that fails without showing why is
        # almost as useless as one that cannot fail at all.
        if ! out=$(node "$path" 2>&1); then
            printf '%s\n' "$out"
            echo "install: $t failed - the selfcheck cannot be trusted. Fix it before installing." >&2
            exit 1
        fi
    done
    say "selfcheck tests: OK (every check proven able to fail)"
}

# --- selfcheck ---------------------------------------------------------------------
run_selfcheck() {
    local selfcheck="$bundle/scripts/factory-selfcheck.mjs"
    if [ "$DRY_RUN" = 1 ]; then
        dry "node \"$selfcheck\""
        return
    fi
    if [ -f "$selfcheck" ]; then
        node "$selfcheck"
        say "selfcheck: OK"
    else
        say "warning: $selfcheck not in bundle yet (selfcheck task not landed); skip for now."
    fi
}

# --- main ---------------------------------------------------------------------------
say "opencode-factory install (bundle: $bundle)"
ensure_dirs
if [ "$SKIP_BD" = 0 ]; then install_bd; fi
if [ "$SKIP_GRAFT" = 0 ]; then install_graft; fi
install_plugins
install_commands
merge_config
install_skills
install_mandatory_skills
install_dcp_prompts
run_tests
run_selfcheck
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] done (dry run - nothing was changed)."
else
    say "done. See docs/HOW-INSTALL.md for manual steps and troubleshooting."
fi
