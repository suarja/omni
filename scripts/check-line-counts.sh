#!/usr/bin/env bash

set -euo pipefail

readonly preferred_limit=500
readonly hard_limit=800

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

warning_count=0
failure_count=0

while IFS= read -r file; do
  case "$file" in
    .git/*|node_modules/*|dist/*|build/*|coverage/*|vendor/*|generated/*|*/generated/*|*/design/assets/*|*/Maquettes\ UI\ formulaire/*)
      continue
      ;;
    *.generated.*|*.gen.*|*.lock|package-lock.json|pnpm-lock.yaml|yarn.lock|bun.lockb)
      continue
      ;;
  esac

  case "$file" in
    *.cjs|*.css|*.go|*.html|*.java|*.js|*.jsx|*.kts|*.kt|*.mjs|*.php|*.py|*.rb|*.rs|*.scss|*.sh|*.sql|*.swift|*.ts|*.tsx|*.vue)
      ;;
    *)
      continue
      ;;
  esac

  if [[ ! -f "$file" ]]; then
    continue
  fi

  line_count="$(wc -l < "$file" | tr -d ' ')"

  if (( line_count > hard_limit )); then
    printf 'FAIL: %s has %s physical lines; the hard limit is %s.\n' "$file" "$line_count" "$hard_limit"
    failure_count=$((failure_count + 1))
  elif (( line_count > preferred_limit )); then
    printf 'WARN: %s has %s physical lines; split it before adding unrelated responsibility.\n' "$file" "$line_count"
    warning_count=$((warning_count + 1))
  fi
done < <(git ls-files)

if (( failure_count > 0 )); then
  printf 'FAIL: %s file(s) exceed the hard line-count limit.\n' "$failure_count"
  exit 1
fi
if (( warning_count > 0 )); then
  printf 'PASS with warnings: %s file(s) are above the preferred target.\n' "$warning_count"
else
  printf 'PASS: all tracked hand-authored code files are within the preferred target.\n'
fi
