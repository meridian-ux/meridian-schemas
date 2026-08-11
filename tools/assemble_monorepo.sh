#!/usr/bin/env bash
# Assemble meridian-ux/meridian — the public monorepo — from the ten repos that
# make it up, PRESERVING every commit.
#
# This has been run end to end and the result inspected; what it cannot do from a
# Claude Code session is push, because the GitHub App has no repo-creation
# permission on the org (403 on POST /orgs/meridian-ux/repos). So this is the
# merge as a reviewable, re-runnable script rather than as a one-off somebody
# did in a scratch directory — which is the better artifact anyway: the ordering
# and the path mapping are decisions, and they should be reviewed before they are
# baked into 279 commits of history.
#
# WHY THIS MERGE EXISTS. @savvifi/meridian-proto-ts currently resolves to FIVE
# versions across these repos — the ranges are, verbatim, ^0.23.0 (web-react),
# ^0.24.0 (mui-kit), 0.21.0 (chat), ^0.13.0 (launchpad) and ^0.19.0 (web).
# protobuf-es emits NOMINAL types, so two copies of PanelDescriptor are mutually
# unassignable and a consumer cannot fix it from its own package.json. Caret on
# 0.x is minor-locked (^0.23.0 means >=0.23.0 <0.24.0), so those ranges are
# pairwise DISJOINT: installing web-react and mui-kit together does not risk two
# copies, it guarantees them. One pnpm workspace with workspace:* makes that
# unrepresentable. That is the whole point; the version number is not.
#
# Usage:
#   tools/assemble_monorepo.sh public|internal <dest-dir> [checkout-root]
#
# checkout-root defaults to the parent of this repo and must contain a checkout
# of each source repo (only their git dirs are read; working trees are untouched
# and local refs are left alone apart from fast-forwarding `main`).

set -euo pipefail

SET="${1:?usage: assemble_monorepo.sh public|internal <dest-dir> [checkout-root]}"
DEST="${2:?usage: assemble_monorepo.sh public|internal <dest-dir> [checkout-root]}"
ROOT="${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v git-filter-repo >/dev/null || python3 -c 'import git_filter_repo' 2>/dev/null || {
  echo "git-filter-repo not found. It is a single Python file: pip install git-filter-repo" >&2
  exit 1
}

# ── The mapping, and the ordering, which are the two real decisions here ──────
#
# ORDER IS THE DEPENDENCY ORDER, so every step lands on a graph that already
# resolves rather than one that is half-rewritten:
#   1. schemas       — the root of the entire graph. Every published package
#                      transitively depends on @savvifi/meridian-proto-ts, and
#                      three Bazel modules depend on meridian_schemas.
#   2. the leaves that only depend on schemas  — core, web-react
#   3. their dependents                        — mui-kit, launchpad, chat, web, tui
#   4. the non-code corners                    — brand, site
#
# PATHS put each repo where it belongs in the target layout, so `git log <path>`
# and `git blame` work afterwards with NO --follow: --to-subdirectory-filter
# rewrites each history BEFORE the merge, so pre-merge commits already carry
# their post-merge paths. (git subtree needs no tooling but leaves pre-merge
# commits at their original root paths, which is why it is not used here.)
#
# NOT IN THIS LIST, deliberately:
#   meridian-proto, meridian-mcp   -> meridian-internal. They stay private, and
#     that is not only a visibility call: they are the SOLE holders of
#     .bazelversion 8.4.0, of `register_toolchains(@rules_rust_prost//:default_
#     prost_toolchain)`, of thiserror 1.0 and of rust-version 1.95.0. Keeping
#     them out dissolves the toolchain-registration hazard entirely — the
#     tonic-free //rust:prost_toolchain that core and tui register (and that
#     core's MODULE.bazel explains: the default "drags tonic/tokio/mio into every
#     rust_prost_library and breaks the wasm32 transition") no longer has to win
#     a first-registered-wins race against the default in a shared root.
#   meridian-k8s, meridian-chat-host, meridian-playground -> meridian-internal.
#   meridian-aion-web, meridian-aion-projection -> stay standalone. They are the
#     only two coupled to the GitLab @aion registry and the only two with no
#     Bazel, so leaving them out means this merge touches nothing needing GitLab.
PUBLIC=(
  "meridian-schemas:schemas"
  "meridian-uiview-core:crates/core"
  "meridian-web-react:packages/web-react"
  "meridian-mui-kit:packages/mui-kit"
  "meridian-launchpad:packages/launchpad"
  "meridian-chat:packages/chat"
  "meridian-web:packages/web"
  "meridian-tui:crates/tui"
  "brand:brand"
  "meridian-ux.github.io:site"
)

# meridian-ux/meridian-internal. Four Rust services plus the playground app.
# Paths mirror the source repos rather than inventing a taxonomy — these are
# services, and the only grouping that earns its keep is crates/ vs apps/.
#
# The dependency order matters less here (nothing in this set is the root of the
# others' graph the way schemas is), so it runs heaviest-first, which just means
# the biggest rewrite happens while the tree is smallest.
INTERNAL=(
  "meridian-proto:crates/projector"
  "meridian-mcp:crates/mcp"
  "meridian-k8s:crates/k8s"
  "meridian-chat-host:crates/chat-host"
  "meridian-playground:apps/playground"
)

case "$SET" in
  public)   MAP=("${PUBLIC[@]}") ;;
  internal) MAP=("${INTERNAL[@]}") ;;
  *) echo "first argument must be 'public' or 'internal', got '$SET'" >&2; exit 1 ;;
esac

mkdir -p "$DEST"
git -C "$DEST" rev-parse --git-dir >/dev/null 2>&1 || {
  git -C "$DEST" init -q -b main .
  git -C "$DEST" commit -q --allow-empty -m "root: the empty commit every folded history attaches to"
}

for entry in "${MAP[@]}"; do
  repo="${entry%%:*}"; dest="${entry##*:}"
  src="$ROOT/$repo"
  [ -d "$src/.git" ] || { echo "no checkout at $src" >&2; exit 1; }

  # Fold in what is on the REMOTE's main, not whatever the local checkout has
  # wandered to. A stale local `main` silently merges last month's tree.
  git -C "$src" fetch -q origin main
  git -C "$src" update-ref refs/heads/main refs/remotes/origin/main

  # filter-repo rewrites destructively, so it gets a throwaway clone.
  git clone -q --no-local --branch main "$src" "$WORK/$repo"
  ( cd "$WORK/$repo" && git filter-repo --quiet --force --to-subdirectory-filter "$dest" )

  git -C "$DEST" remote add "$repo" "$WORK/$repo"
  git -C "$DEST" fetch -q "$repo" main
  git -C "$DEST" merge -q --allow-unrelated-histories --no-edit \
    -m "merge: fold $repo into $dest, history intact" FETCH_HEAD
  git -C "$DEST" remote remove "$repo"

  printf "  folded %-24s -> %-22s (%s commits)\n" \
    "$repo" "$dest" "$(git -C "$WORK/$repo" rev-list --count HEAD)"
done

echo
echo "assembled $(git -C "$DEST" rev-list --count HEAD) commits at $DEST"
cat <<'NEXT'

The fold-in is only step one. What it deliberately does NOT do, because each is a
reviewable change rather than a mechanical rewrite:

  * ROOT CONFIGS. Ten MODULE.bazel / .bazelrc / .bazelversion, seven package.json
    and pnpm-lock.yaml, five pnpm-workspace.yaml, two Cargo workspaces. After the
    subdirectory filter these do not CONFLICT — each landed in its own subdir —
    so the merge is clean; choosing which becomes the root is the actual work.

  * THE TWO PUBLISHED PACKAGES ARE NOT WORKSPACE MEMBERS YET, and this is the
    thing to get right. @savvifi/meridian-proto-ts and @savvifi/meridian-schemas
    are published from hand-maintained manifests (proto/proto-ts.package.json,
    schemas.package.json) that are kept deliberately OUTSIDE the pnpm graph, and
    proto-ts has no source directory at all — it is Bazel codegen output plus a
    manifest, npm_link_package'd for in-Bazel consumers. So `workspace:*` has
    nothing to point AT until proto-ts exists on disk as a package.

    Verified feasible with npm tooling only: `protoc` + the already-present
    @bufbuild/protoc-gen-es 2.12.1 devDependency generates all 28 _pb.js + 28
    _pb.d.ts with no Bazel, no private registry and no credentials — the pnpm
    counterpart of the cargo codegen path in meridian-uiview-core. That is what
    lets a contributor clone and run `pnpm install && pnpm test`, which is the
    actual developer-experience goal.

  * PUBLISHING STILL NEEDS THE MANIFEST SPLIT — do not delete it. All the publish
    workflows end in `npm publish`, which does not translate the workspace:
    protocol, and the Bazel-built packages publish from a DETACHED copy
    (`cp -RL bazel-bin/pkg "$RUNNER_TEMP/pkg" && cd "$RUNNER_TEMP/pkg"`) that has
    no workspace root, no lockfile and no siblings. `workspace:*` in that
    directory cannot resolve. Extend the <name>.package.json + replace_prefixes
    pattern to every published package instead: workspace:* lives in the
    development manifests where it does its job, and the published manifests are
    generated with real versions and gated by a generalised check_versions.py —
    which already compares both manifests against MODULE.bazel's module(version).

  * ONE VERSION. Everything releases at 0.25.0 in lockstep: it is the next minor
    above the estate's current ceiling (proto-ts/schemas at 0.24.0), and nothing
    may move backwards. Note that today the three version axes already disagree
    INSIDE single repos — mui-kit publishes 0.17.0 from a Bazel module that still
    says 0.1.0; uiview-core publishes module 0.6.0 from crates pinned at 0.1.0 —
    because only meridian-schemas ever adopted the check. One module(version)
    plus one [workspace.package] version makes that unrepresentable.

  * THE MODULE MUST NOT BE NAMED `meridian`. brand/MODULE.bazel declares
    bazel_dep(name = "meridian", version = "0.2.3") — the old mattmarshall/meridian
    monolith — and brand/skins/BUILD.bazel validates the canonical skin against
    @meridian//proto:theme.proto through @brando's repo mapping, so the dep cannot
    simply be dropped without patching brando. The REPOSITORY name is unaffected;
    only module(name = ...) collides.

Verify, in this order, cheapest first:
  pnpm install && pnpm why @savvifi/meridian-proto-ts   # must return exactly ONE
  (cd crates && cargo test --workspace)                 # tui buildable for the first time
  bazel mod deps                                        # parses the merged MODULE.bazel
  bazel test //...                                      # the only step needing a real Bazel fetch
NEXT
