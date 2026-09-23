#!/usr/bin/env bash
# opencode-factory: install the beads CLI (bd) on Unix/macOS.
# Fast path: if `bd version` works, skip. Preconditions: git, node >= 20.
# Install: curl -fsSL https://beads.dev/install.sh | bash
#   (installer tracks the latest stable; the 1.3.0 known-good pin is documented
#    in docs/HOW-INSTALL.md; verify with `bd version` after install.)
# Usage: ./install-bd.sh [--dry-run]
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run|-DryRun|-n) DRY_RUN=1 ;;
    esac
done

say() { printf '%s\n' "$*"; }
dry() { say "[dry-run] $*"; }

# --- fast path: bd already installed and working ------------------------------
if command -v bd >/dev/null 2>&1; then
    if [ "$DRY_RUN" = 1 ]; then
        dry "bd version"
        dry "bd already installed - skip install"
    elif bd version >/dev/null 2>&1; then
        say "bd already installed ($(bd version | head -n 1))"
        exit 0
    else
        say "bd on PATH but broken - reinstalling."
    fi
fi

# --- preconditions -------------------------------------------------------------
command -v git >/dev/null 2>&1 || { echo "install-bd: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "install-bd: node >= 20 is required" >&2; exit 1; }
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$node_major" -ge 20 ] || { echo "install-bd: node >= 20 is required (found $(node --version))" >&2; exit 1; }

# --- install ----------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
    dry "curl -fsSL https://beads.dev/install.sh | bash"
else
    curl -fsSL https://beads.dev/install.sh | bash
fi

# --- verify -----------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
    dry "bd version"
    dry "bd install complete (dry run)."
else
    bd version || { echo "install-bd: bd version check failed after install" >&2; exit 1; }
    say "bd ready."
fi