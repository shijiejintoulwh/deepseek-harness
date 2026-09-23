#!/usr/bin/env bash
set -euo pipefail

upstream_sha=${1:?expected upstream commit}

if ! git merge --no-commit --no-ff "$upstream_sha"; then
  if [ ! -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then exit 1; fi
  mapfile -d '' -t conflicts < <(git diff --name-only --diff-filter=U -z)
  source_conflicts=false
  for path in "${conflicts[@]}"; do
    case "$path" in
      .github/workflows/*|scripts/ci-workflow.spec.ts) ;;
      *) printf '::error file=%s::Upstream runtime merge requires manual resolution\n' "$path"; source_conflicts=true ;;
    esac
  done
  if [ "$source_conflicts" = true ]; then exit 1; fi
fi

# Keep fork-owned CI files identical to the first parent so the contents-only
# GITHUB_TOKEN can push the merge. Runtime source conflicts require review.
git rm -r -f -q -- .github/workflows
git rm -f -q -- scripts/ci-workflow.spec.ts
git restore --source=HEAD --staged --worktree -- .github/workflows scripts/ci-workflow.spec.ts
if [ -n "$(git ls-files -u)" ]; then
  echo '::error::Unresolved upstream merge paths remain'
  exit 1
fi
git commit --no-edit
