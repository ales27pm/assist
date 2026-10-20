#!/usr/bin/env bash
# Validates the Swift-to-Objective-C++ delegate boundary for device/document tools.
#
# This is real iPhoneOS SDK Swift 6 object compilation and header emission,
# but not an archive, a full app build, or an iPhone runtime test. The app target
# emits internal @objc declarations in its generated Swift header. The
# command-line compiler needs an @main source in the same temporary app module
# to reproduce that header-emission mode; capability and document implementations
# are always the checked-in sources below. Expo/CoreAI/RCT remain outside this
# source-subset check.
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

swift_header_line="$(grep -nF '#import "Assist-Swift.h"' "$BRIDGE" | head -n 1 | cut -d: -f1 || true)"
for framework in CoreLocation MessageUI QuickLook VisionKit; do
  framework_line="$(grep -nF "#import <$framework/$framework.h>" "$BRIDGE" | head -n 1 | cut -d: -f1 || true)"
  if [[ -z "$framework_line" || -z "$swift_header_line" || "$framework_line" -ge "$swift_header_line" ]]; then
    echo "RCTNativeAssist.mm must import $framework before Assist-Swift.h." >&2
    exit 1
  fi
done

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
  mobile/ios/Assist/Shared/AssistSharedInbox.swift \
  mobile/ios/Assist/AssistDocuments.swift \
  mobile/ios/Assist/Services/AssistDocumentActionsPolicy.swift \
  mobile/ios/Assist/Services/AssistDocumentSpotlight.swift \
  mobile/ios/Assist/Services/AssistDocumentActions.swift \
  "$SOURCE" "$CHECK_DIR/AssistHeaderCheckApp.swift"

expected_header='@interface AssistDeviceCapabilities : NSObject <CLLocationManagerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate>'
if ! grep -Fq "$expected_header" "$CHECK_DIR/Assist-Swift.h"; then
  echo "Generated Swift header did not expose the expected device delegate protocols." >&2
  exit 1
fi

document_header="$(grep -F '@interface AssistDocumentActions : NSObject <' "$CHECK_DIR/Assist-Swift.h" || true)"
for document_protocol in MFMailComposeViewControllerDelegate MFMessageComposeViewControllerDelegate \
  QLPreviewControllerDataSource QLPreviewControllerDelegate VNDocumentCameraViewControllerDelegate; do
  if [[ "$document_header" != *"$document_protocol"* ]]; then
    echo "Generated Swift header did not expose the expected document protocol: $document_protocol" >&2
    exit 1
  fi
done

# This conformance is not emitted in the generated Objective-C header. If that
# changes, fail explicitly so the bridge can add the matching PhotosUI
# preimport rather than guessing today.
if grep -Fq 'PHPickerViewControllerDelegate' "$CHECK_DIR/Assist-Swift.h"; then
  echo "Generated Swift header now exposes PHPickerViewControllerDelegate; add and verify PhotosUI before Assist-Swift.h." >&2
  exit 1
fi

# Consume the production Apple preimports instead of maintaining another list
# that could pass while the real bridge forgets one. Negative consumers omit
# the old location import or the new document imports from that same prefix.
python3 - "$BRIDGE" "$CHECK_DIR" <<'PY'
from pathlib import Path
import re
import sys
prefix = Path(sys.argv[1]).read_text().split('#import "Assist-Swift.h"', 1)[0]
imports = [(match.group(1), match.group(0)) for line in prefix.splitlines()
           if (match := re.fullmatch(r'#import <(AVFoundation|UIKit|CoreLocation|MessageUI|QuickLook|VisionKit)/[^>]+>', line))]
for name, omitted in [('production', set()), ('without-CoreLocation', {'CoreLocation'}),
                      ('without-document-frameworks', {'MessageUI', 'QuickLook', 'VisionKit'})]:
    lines = ['#import <Foundation/Foundation.h>']
    lines += [line for framework, line in imports if framework not in omitted]
    lines += ['#import "Assist-Swift.h"', 'int assist_device_bridge_header_check(void) { return 0; }']
    (Path(sys.argv[2]) / (name + '.mm')).write_text('\n'.join(lines) + '\n')
PY

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

if xcrun --sdk iphoneos clang++ "${clang_args[@]}" \
  -c "$CHECK_DIR/without-document-frameworks.mm" \
  -o "$CHECK_DIR/without-document-frameworks.o" \
  > "$CHECK_DIR/without-document-frameworks.log" 2>&1; then
  echo "Expected generated-header consumer without document frameworks to fail." >&2
  exit 1
fi
for missing_type in MFMailComposeViewControllerDelegate MFMessageComposeViewControllerDelegate QLPreviewControllerDataSource; do
  if ! grep -Fq "'$missing_type'" "$CHECK_DIR/without-document-frameworks.log"; then
    echo "Negative document compile failed for an unexpected reason:" >&2
    sed -n '1,80p' "$CHECK_DIR/without-document-frameworks.log" >&2
    exit 1
  fi
done

xcrun --sdk iphoneos clang++ "${clang_args[@]}" \
  -c "$CHECK_DIR/production.mm" \
  -o "$CHECK_DIR/production.o"

echo "PASS: generated device/document Swift header rejects missing imports and compiles with the production Apple preimports."
