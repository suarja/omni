#!/usr/bin/env bash

set -euo pipefail

readonly preferred_limit=150
readonly hard_limit=200
readonly max_files_per_directory=5

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

warning_count=0
failure_count=0

while IFS= read -r directory; do
  case "$directory" in
    */uploads)
      continue
      ;;
  esac

  file_count="$(find "$directory" -maxdepth 1 -type f -print | wc -l | tr -d ' ')"
  if (( file_count > max_files_per_directory )); then
    printf 'FAIL: %s contains %s direct files; the limit is %s.\n' \
      "$directory" "$file_count" "$max_files_per_directory"
    failure_count=$((failure_count + 1))
  fi
done < <(find docs -type d -print)

while IFS= read -r file; do
  case "$file" in
    */archive/*)
      continue
      ;;
  esac

  line_count="$(wc -l < "$file" | tr -d ' ')"
  if (( line_count > hard_limit )); then
    printf 'FAIL: %s has %s lines; the hard documentation limit is %s.\n' \
      "$file" "$line_count" "$hard_limit"
    failure_count=$((failure_count + 1))
  elif (( line_count > preferred_limit )); then
    printf 'WARN: %s has %s lines; target is %s or fewer.\n' \
      "$file" "$line_count" "$preferred_limit"
    warning_count=$((warning_count + 1))
  fi
done < <(find docs -type f -name '*.md' -print | sort)

if (( failure_count > 0 )); then
  printf 'FAIL: documentation structure has %s failure(s).\n' "$failure_count"
  exit 1
fi

if (( warning_count > 0 )); then
  printf 'PASS with warnings: %s canonical document(s) are above the preferred target.\n' \
    "$warning_count"
else
  printf 'PASS: canonical documentation satisfies the structure and line limits.\n'
fi
