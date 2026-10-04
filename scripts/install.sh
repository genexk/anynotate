#!/bin/sh
# Anynotate installer for macOS and Linux.
#
#   curl -fsSL https://github.com/genexk/anynotate/releases/latest/download/install.sh | sh
#
# Downloads the release binary for this machine, verifies it against the
# release's SHA256SUMS, installs it to ~/.local/bin/anynotate and runs
# `anynotate install`. Needs no root.
#
# Environment:
#   ANYNOTATE_VERSION   install this release (e.g. 0.4.0) instead of the latest
#   ANYNOTATE_BASE_URL  download from this base URL instead (file:// works)
#   ANYNOTATE_BIN_DIR   install into this directory instead of ~/.local/bin
#   ANYNOTATE_NO_MCP    set to 1 to leave Claude Desktop, Cursor, Codex and Claude Code unconfigured
#
# Everything runs from main(), called on the last line, so a truncated
# download never executes a partial script.

set -eu

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'anynotate installer: %s\n' "$*" >&2
  exit 1
}

unsupported() {
  fail "unsupported platform: $1. Supported targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64 (Windows: use install.ps1)."
}

detect_target() {
  uname_s=$(uname -s)
  uname_m=$(uname -m)
  case "$uname_s" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) unsupported "$uname_s $uname_m" ;;
  esac
  case "$uname_m" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) unsupported "$uname_s $uname_m" ;;
  esac
  # An x64 shell under Rosetta still gets the native arm64 build.
  if [ "$os" = darwin ] && [ "$arch" = x64 ]; then
    translated=$(sysctl -n sysctl.proc_translated 2>/dev/null || true)
    if [ "$translated" = 1 ]; then
      arch=arm64
    fi
  fi
  target="$os-$arch"
  asset="anynotate-$target"
}

resolve_base() {
  base=${ANYNOTATE_BASE_URL:-}
  if [ -z "$base" ]; then
    version=${ANYNOTATE_VERSION:-}
    if [ -n "$version" ]; then
      version=${version#v}
      base="https://github.com/genexk/anynotate/releases/download/v$version"
    else
      base="https://github.com/genexk/anynotate/releases/latest/download"
    fi
  fi
  base=${base%/}
  case "$base" in
    https://* | file://*) ;;
    *) fail "ANYNOTATE_BASE_URL must start with https:// (or file:// for a local release); got $base" ;;
  esac
}

resolve_bin_dir() {
  bin_dir=${ANYNOTATE_BIN_DIR:-}
  if [ -z "$bin_dir" ]; then
    [ -n "${HOME:-}" ] || fail "HOME is not set; set ANYNOTATE_BIN_DIR to choose an install directory."
    bin_dir="$HOME/.local/bin"
  fi
  case "$bin_dir" in
    /*) ;;
    *) bin_dir="$(pwd)/$bin_dir" ;;
  esac
  while [ "$bin_dir" != / ] && [ "${bin_dir%/}" != "$bin_dir" ]; do
    bin_dir=${bin_dir%/}
  done
  bin="$bin_dir/anynotate"
  if [ -d "$bin" ]; then
    fail "$bin is a directory; remove it or set ANYNOTATE_BIN_DIR elsewhere."
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,file' --proto-redir '=https' -o "$2" "$1" || fail "download failed: $1"
  elif command -v wget >/dev/null 2>&1; then
    case "$1" in
      file://*) cp "${1#file://}" "$2" || fail "copy failed: $1" ;;
      *)
        # GNU wget can refuse to follow a redirect to plain http; BusyBox wget has no such option.
        if wget --help 2>&1 | grep -q -- '--https-only'; then
          wget -q --https-only -O "$2" "$1" || fail "download failed: $1"
        else
          wget -q -O "$2" "$1" || fail "download failed: $1"
        fi
        ;;
    esac
  else
    fail "neither curl nor wget is installed."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    return 1
  fi
}

verify() {
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp_dir/SHA256SUMS" | tr 'A-F' 'a-f')
  [ -n "$expected" ] || fail "no checksum for $asset in SHA256SUMS; refusing to install."
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    fail "cannot verify the download: neither sha256sum nor shasum is installed."
  fi
  actual=$(sha256_of "$tmp_dir/$asset" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); refusing to install."
  say "Verified SHA-256 $actual"
}

cleanup() {
  if [ -n "${staged:-}" ]; then
    rm -f "$staged"
  fi
  if [ -n "${tmp_dir:-}" ]; then
    rm -rf "$tmp_dir"
  fi
}

main() {
  detect_target
  resolve_base
  resolve_bin_dir

  say "Anynotate installer"
  say "  platform:  $target"
  say "  download:  $base/$asset"
  say "  verify:    against $base/SHA256SUMS"
  say "  install:   $bin"
  say "  then run:  $bin install (sets up the bridge service, browser hosts and MCP for the apps it finds)"
  say ""

  staged=""
  tmp_dir=""
  trap cleanup EXIT
  trap 'exit 1' HUP INT TERM
  tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t anynotate)

  say "Downloading $base/$asset"
  download "$base/$asset" "$tmp_dir/$asset"
  download "$base/SHA256SUMS" "$tmp_dir/SHA256SUMS"
  verify

  mkdir -p "$bin_dir"
  staged=$(mktemp "$bin_dir/.anynotate.new.XXXXXX")
  cp "$tmp_dir/$asset" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "$bin"
  staged=""
  say "Installed $bin"

  say "Running $bin install"
  "$bin" install || fail "\`$bin install\` failed; fix the problem above and run it again."

  case ":${PATH:-}:" in
    *":$bin_dir:"* | *":$bin_dir/:"*) ;;
    *)
      say ""
      say "Add $bin_dir to your PATH, e.g. in your shell profile:"
      say "  export PATH=\"$bin_dir:\$PATH\""
      ;;
  esac
  say ""
  say "Run: anynotate doctor"
}

main "$@"
