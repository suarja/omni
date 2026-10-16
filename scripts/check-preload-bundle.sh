#!/usr/bin/env bash
set -euo pipefail

bundle_path="out/preload/index.js"
if [[ ! -f "$bundle_path" ]]; then
  printf 'FAIL: missing sandbox-compatible preload bundle at %s\n' "$bundle_path" >&2
  exit 1
fi

if rg -n '^(import|export) ' "$bundle_path"; then
  printf 'FAIL: sandboxed preload bundle contains ESM statements\n' >&2
  exit 1
fi

if ! rg -q 'require\("electron"\)' "$bundle_path"; then
  printf 'FAIL: preload bundle does not contain the expected CommonJS Electron import\n' >&2
  exit 1
fi

if rg -n 'require\("node:crypto"\)' "$bundle_path"; then
  printf 'FAIL: sandboxed preload bundle imports unavailable node:crypto\n' >&2
  exit 1
fi

printf 'PASS: preload bundle is CommonJS-compatible with sandboxed Electron.\n'
