#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# Exported Bash functions replace only the read-only platform boundaries. No
# Xcode, SDK, hardware, files, network or system configuration is changed.
uname() {
  case "$*" in
    -s) printf '%s\n' "$TEST_HOST_OS" ;;
    -m) printf '%s\n' "$TEST_HOST_ARCH" ;;
    *) return 99 ;;
  esac
}
xcodebuild() {
  [[ "$*" == '-version' ]] || return 99
  [[ "$TEST_XCODE_FAIL" == 0 ]] || return 127
  printf 'Xcode %s\nBuild version fixture\n' "$TEST_XCODE_VERSION"
}
xcrun() {
  [[ "$*" == '--sdk iphoneos --show-sdk-version' ]] || return 99
  [[ "$TEST_SDK_FAIL" == 0 ]] || return 1
  printf '%s\n' "$TEST_SDK_VERSION"
}
export -f uname xcodebuild xcrun
export TEST_HOST_OS=Darwin TEST_HOST_ARCH=arm64
export TEST_XCODE_VERSION=27.1 TEST_SDK_VERSION=27.1
export TEST_XCODE_FAIL=0 TEST_SDK_FAIL=0

cases=0
run_case() {
  local label=$1 expected_code=$2 expected_text=$3 actual_code output
  if output=$(bash "$script_dir/preflight-ios.sh" 2>&1); then
    actual_code=0
  else
    actual_code=$?
  fi
  if [[ "$actual_code" != "$expected_code" || "$output" != *"$expected_text"* ]]; then
    printf 'FAIL: %s (exit %s, expected %s)\n%s\n' "$label" "$actual_code" "$expected_code" "$output" >&2
    exit 1
  fi
  cases=$((cases + 1))
  printf 'PASS: %s\n' "$label"
}

run_case 'app compiler baseline' 0 'Build prerequisites passed'
TEST_XCODE_VERSION=27.0 run_case 'Core AI baseline is below app deployment target' 1 'Xcode 27.1+'
TEST_SDK_VERSION=27.0 run_case 'SDK must cover app deployment target' 1 'iPhoneOS SDK 27.1+'
TEST_XCODE_VERSION=27.1 TEST_SDK_VERSION=27.1 run_case 'EAS compiler candidate is admitted' 0 'Build prerequisites passed'
run_case 'host gate preserves Gemma runtime requirement' 0 'Gemma inference still requires iOS 27.2+'
TEST_HOST_OS=Linux run_case 'Linux is not an iOS build host' 1 'macOS required'
TEST_HOST_ARCH=x86_64 run_case 'Intel is not the export baseline' 1 'Apple Silicon required'
TEST_XCODE_VERSION=26.3 run_case 'old Xcode is rejected' 1 'Xcode 27.1+'
TEST_SDK_VERSION=26.3 run_case 'old selected iPhoneOS SDK is rejected' 1 'iPhoneOS SDK 27.1+'
TEST_XCODE_VERSION=invalid run_case 'unknown Xcode is rejected' 1 'Xcode 27.1+'
TEST_SDK_VERSION=invalid run_case 'unknown SDK is rejected' 1 'iPhoneOS SDK 27.1+'
TEST_XCODE_FAIL=1 run_case 'unavailable Xcode fails clearly' 1 'Cannot query Xcode'
TEST_SDK_FAIL=1 run_case 'unavailable SDK fails clearly' 1 'Cannot query iPhoneOS SDK'
TEST_XCODE_VERSION=27.2.1 TEST_SDK_VERSION=27.2.0 run_case 'patch versions are accepted' 0 'Build prerequisites passed'
TEST_XCODE_VERSION=28.0 TEST_SDK_VERSION=28.0 run_case 'new major versions are accepted' 0 'Build prerequisites passed'
printf '%s preflight tests passed. Tool fixtures do not prove an iOS build.\n' "$cases"
