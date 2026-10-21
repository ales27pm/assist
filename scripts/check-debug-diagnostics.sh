#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v swiftc >/dev/null || { echo 'ERROR: advanced diagnostics require Swift 6.' >&2; exit 69; }
ASSIST_DEBUG_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-debug-diagnostics.XXXXXX")"
trap 'rm -rf "$ASSIST_DEBUG_CHECK_DIR"' EXIT
ASSIST_DEBUG_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_DEBUG_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_DEBUG_TARGET[@]}" -module-cache-path "$ASSIST_DEBUG_CHECK_DIR/cache" \
  mobile/ios/Assist/Inference/AssistDebugDiagnostics.swift \
  scripts/check-debug-diagnostics.swift -o "$ASSIST_DEBUG_CHECK_DIR/check-debug-diagnostics"
"$ASSIST_DEBUG_CHECK_DIR/check-debug-diagnostics" "$@"

# App-mode compilation must expose the real @objc block-returning seam. Linux
# cannot validate this branch; Darwin compiles the generated header consumer.
if [[ "$(uname -s)" == "Darwin" ]]; then
  cat > "$ASSIST_DEBUG_CHECK_DIR/Main.swift" <<'SWIFT'
@main struct DebugBridgeApp { static func main() {} }
SWIFT
  swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
    "${ASSIST_DEBUG_TARGET[@]}" -module-name Assist -emit-objc-header \
    -emit-objc-header-path "$ASSIST_DEBUG_CHECK_DIR/Assist-Swift.h" \
    -module-cache-path "$ASSIST_DEBUG_CHECK_DIR/cache" \
    mobile/ios/Assist/Inference/AssistDebugDiagnostics.swift \
    "$ASSIST_DEBUG_CHECK_DIR/Main.swift" -o "$ASSIST_DEBUG_CHECK_DIR/check-debug-bridge-app"
  cat > "$ASSIST_DEBUG_CHECK_DIR/consumer.mm" <<'OBJC'
#import <Foundation/Foundation.h>
#import "Assist-Swift.h"
void checkAssistDiagnosticBridge(void) {
  void (^completion)(NSString * _Nullable, NSError * _Nullable) = ^(NSString * _Nullable value, NSError * _Nullable error) {};
  void (^traced)(NSString * _Nullable, NSError * _Nullable) = [AssistDebugDiagnosticsBridge trace:@"tools" completion:completion];
  (void)traced;
  AssistDebugDiagnosticsBridge *bridge = [AssistDebugDiagnosticsBridge new];
  [bridge snapshot:completion];
  [bridge configure:@"{\"schemaVersion\":1,\"mode\":\"off\"}" completion:completion];
  [bridge exportBundle:completion];
  [bridge clear:completion];
}
OBJC
  ASSIST_DEBUG_MACOS_SDK="$(xcrun --sdk macosx --show-sdk-path)"
  xcrun --sdk macosx clang++ -std=c++20 -fblocks -fobjc-arc -fsyntax-only \
    -isysroot "$ASSIST_DEBUG_MACOS_SDK" -I "$ASSIST_DEBUG_CHECK_DIR" "$ASSIST_DEBUG_CHECK_DIR/consumer.mm"
  echo 'PASS: real Swift app-mode Objective-C header and Objective-C++ bridge/block consumer; not executed'
fi
