#!/usr/bin/env bash
set -euo pipefail

# Read-only host gate for the Gemma Core AI prototype, not a device/build test.
fail() {
  printf 'BLOCKED: %s\n' "$*" >&2
  exit 1
}

at_least_27_2() {
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)(\.[0-9]+)?$ ]] || return 1
  local major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]}))
  (( major > 27 || (major == 27 && minor >= 2) ))
}

[[ "$(uname -s)" == Darwin ]] || fail 'macOS required; Linux can run JS tests, not this iOS/Core AI build.'
[[ "$(uname -m)" == arm64 ]] || fail 'Apple Silicon required for the supported Gemma export/qualification host; do not use an Intel VM.'
command -v xcodebuild >/dev/null 2>&1 || fail 'Xcode 27.2+ required; xcodebuild is missing.'
command -v xcrun >/dev/null 2>&1 || fail 'iPhoneOS SDK 27.2+ required; xcrun is missing.'

xcode_output=$(xcodebuild -version 2>/dev/null) || fail 'Cannot query Xcode; select a complete Xcode 27.2+ installation yourself.'
xcode_version=$(printf '%s\n' "$xcode_output" | awk '$1 == "Xcode" {print $2; exit}')
at_least_27_2 "$xcode_version" || fail "Xcode 27.2+ required; selected version: ${xcode_version:-unknown}."
sdk_version=$(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null) || fail 'Cannot query iPhoneOS SDK; a complete Xcode 27.2+ installation is required.'
at_least_27_2 "$sdk_version" || fail "iPhoneOS SDK 27.2+ required; selected version: ${sdk_version:-unknown}."

printf 'Prerequisites passed: Apple Silicon, Xcode %s, iPhoneOS SDK %s.\n' "$xcode_version" "$sdk_version"
printf '%s\n' 'Not verified: dependency resolution, compilation, model export, signing, device connection, iPhone memory, 32K context or ANE execution.'
