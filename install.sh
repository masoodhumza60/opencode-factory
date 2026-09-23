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

command -v node >/dev/null 2>&1 || { echo "install: node >= 20 is required" >&2; exit 1; }

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
    for d in "$oc_config/plugins" "$oc_config/commands/beads" "$oc_config/agents" \
        "$agents_skills/factory" "$project_skills"; do
        if [ "$DRY_RUN" = 1 ]; then dry "mkdir -p $d"; else mkdir -p "$d"; fi
    done
}

# --- graft package-dir resolution -------------------------------------------
# Mirrors scripts/graft-patch-store.ps1: `pnpm root -g` first, else the same
# 3-level store scan (which ends at node_modules dirs). Prints the package dir
# or returns 1 when graft is absent.
find_graft_dir() {
    local root=""
    if command -v pnpm >/dev/null 2>&1; then
        root="$(pnpm root -g 2>/dev/null || true)"
    fi
    if [ -n "$root" ] && [ -d "$root/@nanonets/graft/dist" ]; then
        printf '%s\n' "$root/@nanonets/graft"
        return 0
    fi
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
    local found=""
    found="$(find_graft_dir || true)"
    if [ "$DRY_RUN" = 1 ]; then
        if [ -n "$found" ]; then
            dry "graft already installed locally; skipping \`pnpm add -g @nanonets/graft@0.18.0\`"
        else
            dry "pnpm add -g @nanonets/graft@0.18.0 (then re-resolve the package dir)"
        fi
        local patch_dir="${found:-<resolved-graft-dir>}"
        dry "node \"$bundle/scripts/graft-patch-extract.mjs\" --dir \"$patch_dir\""
        if command -v powershell >/dev/null 2>&1; then
            dry "powershell -NoProfile -ExecutionPolicy Bypass -File \"$bundle/scripts/graft-patch-store.ps1\""
        else
            dry "skip graft-patch-store.ps1 (Windows-only win32-x64 prebuild rename; no PowerShell here)"
        fi
        dry "verify: graft --version"
        graft_pkg="$found"
        return
    fi
    if [ -z "$found" ]; then
        command -v pnpm >/dev/null 2>&1 || { echo "install: pnpm is required for graft" >&2; exit 1; }
        pnpm add -g @nanonets/graft@0.18.0
        found="$(find_graft_dir)" || { echo "install: graft not found after pnpm add -g" >&2; exit 1; }
    fi
    graft_pkg="$found"
    node "$bundle/scripts/graft-patch-extract.mjs" --dir "$graft_pkg"
    if command -v powershell >/dev/null 2>&1; then
        powershell -NoProfile -ExecutionPolicy Bypass -File "$bundle/scripts/graft-patch-store.ps1"
    else
        say "note: graft-patch-store.ps1 skipped (Windows-only win32-x64 prebuild rename)."
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
        if [ -f "$user_cfg" ]; then dry "user config: $user_cfg (read-only, preserved except drop/own rules)"
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
    if [ "$DRY_RUN" = 1 ]; then
        dry "cp \"$src_sk\" \"$agents_skills/factory/\""
        return
    fi
    if [ -f "$src_sk" ]; then
        cp "$src_sk" "$agents_skills/factory/"
        say "factory skill installed -> $agents_skills/factory/SKILL.md"
    else
        say "warning: $src_sk not in bundle yet (conductor skill lands with the docs/discovery task); skip - re-run install once it is present."
    fi
    # NOTE: .agents/skills/skills.lock.json is created by `factory discover`, not by install.
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
run_selfcheck
if [ "$DRY_RUN" = 1 ]; then
    say "[dry-run] done (dry run - nothing was changed)."
else
    say "done. See docs/HOW-INSTALL.md for manual steps and troubleshooting."
fi