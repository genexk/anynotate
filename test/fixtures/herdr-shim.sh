#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${HERDR_SHIM_LOG:?}"
if [[ "${1:-} ${2:-}" == "agent list" ]]; then
  cat "${HERDR_SHIM_LIST:?}"
fi
if [[ "${1:-} ${2:-}" == "agent prompt" && -n "${HERDR_SHIM_ON_PROMPT:-}" ]]; then
  printf '[%s]\n' "$(bash -c "$HERDR_SHIM_ON_PROMPT")" >> "${HERDR_SHIM_ON_PROMPT_OUT:?}"
fi
exit "${HERDR_SHIM_EXIT:-0}"
