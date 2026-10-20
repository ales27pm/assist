#!/usr/bin/env bash
# Validates the narrow Swift-to-Objective-C++ boundary for the device tools.
#
# This is real iPhoneOS SDK Swift 6 object compilation and header emission,
# but not an archive, a full app build, or an iPhone runtime test. The app target
# emits internal @objc declarations in its generated Swift header. The
# command-line compiler needs an @main source in the same temporary app module
# to reproduce that header-emission mode; the capability implementation itself
# is always the checked-in source below.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "check-device-bridge-header.sh requires Xcode's iPhoneOS SDK on macOS." >&2
  exit 69
fi

SOURCE="mobile/ios/Assist/AssistDeviceCapabilities.swift"
BRIDGE="mobile/ios/Assist/RCTNativeAssist.mm"
for required in \
  '@objc(AssistDeviceCapabilities)' \
  'CLLocationManagerDelegate' \
  'UIImagePickerControllerDelegate' \
  'UINavigationControllerDelegate' \
  'PHPickerViewControllerDelegate'; do
  if ! grep -Fq "$required" "$SOURCE"; then
    echo "Missing expected device-capability declaration: $required" >&2
    exit 1
  fi
done

core_location_line="$(grep -nF '#import <CoreLocation/CoreLocation.h>' "$BRIDGE" | head -n 1 | cut -d: -f1 || true)"
swift_header_line="$(grep -nF '#import "Assist-Swift.h"' "$BRIDGE" | head -n 1 | cut -d: -f1 || true)"
if [[ -z "$core_location_line" || -z "$swift_header_line" || "$core_location_line" -ge "$swift_header_line" ]]; then
  echo "RCTNativeAssist.mm must import CoreLocation before Assist-Swift.h." >&2
  exit 1
fi

CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-device-bridge-header.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
SDK_PATH="$(xcrun --sdk iphoneos --show-sdk-path)"

# This minimal app entry point is deliberately temporary. It puts the compiler
# in app-target header mode; it is not a stand-in for AssistDeviceCapabilities.
printf '%s\n' \
  'import UIKit' \
  '@main final class AssistHeaderCheckAppDelegate: UIResponder, UIApplicationDelegate {}' \
  > "$CHECK_DIR/AssistHeaderCheckApp.swift"

xcrun --sdk iphoneos swiftc \
  -module-name Assist \
  -parse-as-library \
  -O \
  -whole-module-optimization \
  -emit-object \
  -o "$CHECK_DIR/Assist.o" \
  -emit-module \
  -emit-module-path "$CHECK_DIR/Assist.swiftmodule" \
  -emit-objc-header \
  -emit-objc-header-path "$CHECK_DIR/Assist-Swift.h" \
  -swift-version 6 \
  -strict-concurrency=complete \
  -warnings-as-errors \
  -target arm64-apple-ios26.0 \
  -sdk "$SDK_PATH" \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistAgentRun.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  "$SOURCE" "$CHECK_DIR/AssistHeaderCheckApp.swift"

expected_header='@interface AssistDeviceCapabilities : NSObject <CLLocationManagerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate>'
if ! grep -Fq "$expected_header" "$CHECK_DIR/Assist-Swift.h"; then
  echo "Generated Swift header did not expose the expected device delegate protocols." >&2
  exit 1
fi

# This conformance is not emitted in the generated Objective-C header. If that
# changes, fail explicitly so the bridge can add the matching PhotosUI
# preimport rather than guessing today.
if grep -Fq 'PHPickerViewControllerDelegate' "$CHECK_DIR/Assist-Swift.h"; then
  echo "Generated Swift header now exposes PHPickerViewControllerDelegate; add and verify PhotosUI before Assist-Swift.h." >&2
  exit 1
fi

printf '%s\n' \
  '#import <Foundation/Foundation.h>' \
  '#import <AVFoundation/AVFoundation.h>' \
  '#import <UIKit/UIKit.h>' \
  '#import "Assist-Swift.h"' \
  'int assist_device_bridge_header_check(void) { return 0; }' \
  > "$CHECK_DIR/without-CoreLocation.mm"

printf '%s\n' \
  '#import <Foundation/Foundation.h>' \
  '#import <AVFoundation/AVFoundation.h>' \
  '#import <UIKit/UIKit.h>' \
  '#import <CoreLocation/CoreLocation.h>' \
  '#import "Assist-Swift.h"' \
  'int assist_device_bridge_header_check(void) { return 0; }' \
  > "$CHECK_DIR/with-CoreLocation.mm"

clang_args=(
  -x objective-c++
  -fobjc-arc
  -fmodules
  -target arm64-apple-ios26.0
  -isysroot "$SDK_PATH"
)

if xcrun --sdk iphoneos clang++ "${clang_args[@]}" \
  -c "$CHECK_DIR/without-CoreLocation.mm" \
  -o "$CHECK_DIR/without-CoreLocation.o" \
  > "$CHECK_DIR/without-CoreLocation.log" 2>&1; then
  echo "Expected generated-header consumer without CoreLocation to fail." >&2
  exit 1
fi
if ! grep -Fq "no type or protocol named 'CLLocationManagerDelegate'" "$CHECK_DIR/without-CoreLocation.log"; then
  echo "Negative compile failed for an unexpected reason:" >&2
  sed -n '1,80p' "$CHECK_DIR/without-CoreLocation.log" >&2
  exit 1
fi

xcrun --sdk iphoneos clang++ "${clang_args[@]}" \
  -c "$CHECK_DIR/with-CoreLocation.mm" \
  -o "$CHECK_DIR/with-CoreLocation.o"

echo "PASS: generated Assist-Swift.h requires CoreLocation and compiles with the production preimport."
