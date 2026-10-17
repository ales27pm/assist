#!/usr/bin/env bash
# Runs the actual voice callback adapter. No privacy prompt or audio hardware.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: native voice callback checks require macOS and the Apple AVFoundation/Speech SDKs." >&2
  exit 69
fi
if ! command -v xcrun >/dev/null 2>&1; then
  echo "ERROR: xcrun/Xcode is missing; native voice callback checks cannot run." >&2
  exit 69
fi
if ! VOICE_CHECK_SDK="$(xcrun --sdk macosx --show-sdk-path)"; then
  echo "ERROR: the macOS SDK is unavailable; select an installed Xcode before running this check." >&2
  exit 69
fi

VOICE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-voice-callbacks.XXXXXX")"
trap 'rm -rf "$VOICE_CHECK_DIR"' EXIT
# The negative control is an expected actor-isolation crash. Never create cores.
ulimit -c 0

xcrun --sdk macosx swiftc \
  -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -enable-actor-data-race-checks -parse-as-library -sdk "$VOICE_CHECK_SDK" \
  -target "$(uname -m)-apple-macosx15.0" \
  mobile/ios/Assist/Voice/AssistVoiceCallbacks.swift \
  scripts/check-voice-callbacks.swift \
  -framework AVFoundation -framework Speech \
  -o "$VOICE_CHECK_DIR/check-voice-callbacks"

# The standalone swiftc harness needs this debug entitlement for Swift's macOS
# backtracer to inspect an expected-crash child. Sign only the temporary test
# executable; the app and its distribution entitlements are never touched.
cat >"$VOICE_CHECK_DIR/debug-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.get-task-allow</key>
  <true/>
</dict>
</plist>
PLIST
/usr/bin/codesign --force --sign - \
  --entitlements "$VOICE_CHECK_DIR/debug-entitlements.plist" \
  "$VOICE_CHECK_DIR/check-voice-callbacks"

"$VOICE_CHECK_DIR/check-voice-callbacks"

for VOICE_CHECK_NEGATIVE in authorization audio-tap; do
  VOICE_CHECK_NEGATIVE_LOG="$VOICE_CHECK_DIR/negative-$VOICE_CHECK_NEGATIVE.log"
  if SWIFT_BACKTRACE='enable=yes,interactive=no,color=no,output-to=stderr' \
      "$VOICE_CHECK_DIR/check-voice-callbacks" "--negative-$VOICE_CHECK_NEGATIVE" \
      >"$VOICE_CHECK_NEGATIVE_LOG" 2>&1; then
    echo "ERROR: the legacy $VOICE_CHECK_NEGATIVE negative control did not trap." >&2
    cat "$VOICE_CHECK_NEGATIVE_LOG" >&2
    exit 1
  else
    VOICE_CHECK_NEGATIVE_STATUS=$?
  fi
  if [[ "$VOICE_CHECK_NEGATIVE_STATUS" -lt 128 ]] || \
     ! grep -Eq 'dispatch_assert_queue|Incorrect actor executor assumption|swift_task_checkIsolated|_checkExpectedExecutor' \
       "$VOICE_CHECK_NEGATIVE_LOG"; then
    echo "ERROR: $VOICE_CHECK_NEGATIVE negative control failed unexpectedly (exit $VOICE_CHECK_NEGATIVE_STATUS)." >&2
    cat "$VOICE_CHECK_NEGATIVE_LOG" >&2
    exit 1
  fi
  echo "PASS: legacy $VOICE_CHECK_NEGATIVE trapped on actor isolation (exit $VOICE_CHECK_NEGATIVE_STATUS)."
done
