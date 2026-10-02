#!/bin/sh
# herdr build hook (runs once on `herdr plugin install`): makes sure the
# anynotate CLI this plugin drives is installed and set up.
#
# - anynotate already installed: try `anynotate update` if it is older than
#   this plugin (a failed update only warns), then run `anynotate install`
#   (idempotent).
# - not installed: run the release installer, which downloads and verifies
#   the binary and runs `anynotate install` itself. herdr installs the whole
#   repository, so the installer is taken from this checkout
#   (../../scripts/install.sh) rather than fetched, but only when
#   ../../integrations/herdr is this very directory, i.e. the checkout is the
#   anynotate repository. Otherwise it is downloaded, to a file and never
#   piped.

set -eu

root=$(cd "$(dirname "$0")" && pwd)
installer_url="https://github.com/genexk/anynotate/releases/latest/download/install.sh"

say() {
  printf 'anynotate plugin: %s\n' "$*"
}

fail() {
  printf 'anynotate plugin build failed: %s\n' "$*" >&2
  exit 1
}

plugin_version() {
  sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$root/herdr-plugin.toml" | head -n 1
}

# version_lt A B: true when dotted version A is older than B.
version_lt() {
  a=$1
  b=$2
  for _ in 1 2 3; do
    a_part=${a%%.*}
    b_part=${b%%.*}
    a_part=$(printf '%s' "$a_part" | sed 's/[^0-9].*//')
    b_part=$(printf '%s' "$b_part" | sed 's/[^0-9].*//')
    a_part=${a_part:-0}
    b_part=${b_part:-0}
    if [ "$a_part" -lt "$b_part" ]; then return 0; fi
    if [ "$a_part" -gt "$b_part" ]; then return 1; fi
    case "$a" in *.*) a=${a#*.} ;; *) a=0 ;; esac
    case "$b" in *.*) b=${b#*.} ;; *) b=0 ;; esac
  done
  return 1
}

fetch_installer() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --proto-redir '=https' -o "$1" "$installer_url"
  elif command -v wget >/dev/null 2>&1; then
    if wget --help 2>&1 | grep -q -- '--https-only'; then
      wget -q --https-only -O "$1" "$installer_url"
    else
      wget -q -O "$1" "$installer_url"
    fi
  else
    fail "neither curl nor wget is installed; install anynotate by hand and run \`herdr plugin install\` again."
  fi
}

in_anynotate_checkout() {
  here=$(cd -P "$root" 2>/dev/null && pwd -P) || return 1
  there=$(cd -P "$root/../../integrations/herdr" 2>/dev/null && pwd -P) || return 1
  [ "$here" = "$there" ] && [ -f "$root/../../integrations/herdr/herdr-plugin.toml" ]
}

run_installer() {
  local_installer="$root/../../scripts/install.sh"
  if [ -f "$local_installer" ] && in_anynotate_checkout; then
    say "installing anynotate with $local_installer"
    sh "$local_installer" || fail "the anynotate installer failed; see the output above."
    return
  fi
  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t anynotate-plugin)
  trap 'rm -rf "$tmp_dir"' EXIT
  say "downloading the anynotate installer from $installer_url"
  fetch_installer "$tmp_dir/install.sh" || fail "could not download $installer_url"
  sh "$tmp_dir/install.sh" || fail "the anynotate installer failed; see the output above."
}

if exe=$("$root/bin/anynotate-run" --locate 2>/dev/null); then
  wanted=$(plugin_version)
  have=$("$exe" --version 2>/dev/null || true)
  say "found $exe ${have:-(unknown version)}"
  if [ -n "$wanted" ] && { [ -z "$have" ] || version_lt "$have" "$wanted"; }; then
    say "updating anynotate to at least $wanted"
    "$exe" update || fail "\`$exe update\` failed; the plugin needs anynotate $wanted or newer. Update it by hand (re-run its installer), then install the plugin again."
    have=$("$exe" --version 2>/dev/null || true)
    if [ -z "$have" ] || version_lt "$have" "$wanted"; then
      fail "anynotate is still ${have:-an unknown version} after updating; the plugin needs $wanted or newer."
    fi
  fi
  "$exe" install || fail "\`$exe install\` failed; fix the problem above and install the plugin again."
else
  run_installer
  "$root/bin/anynotate-run" --locate >/dev/null 2>&1 || fail "the installer finished but anynotate was not found in ~/.local/bin or on PATH."
fi

say "ready"
