#!/usr/bin/env bash
# Source/SDK type checks only: no signing, archive, account access or device run.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcrun >/dev/null || { echo 'ERROR: an Apple SDK host is required.' >&2; exit 69; }
ASSIST_WORKSPACE_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-workspace-sdk.XXXXXX")"
trap 'rm -rf "$ASSIST_WORKSPACE_CHECK_DIR"' EXIT
ASSIST_WORKSPACE_SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
# This is a source-subset check using the available simulator SDK, not a
# substitute for the app's declared deployment/qualification SDK gate.
ASSIST_WORKSPACE_SDK_VERSION="$(xcrun --sdk iphonesimulator --show-sdk-version)"
ASSIST_WORKSPACE_TARGET="$(uname -m)-apple-ios${ASSIST_WORKSPACE_SDK_VERSION}-simulator"
ASSIST_WORKSPACE_FLAGS=(-swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library
  -sdk "$ASSIST_WORKSPACE_SDK" -target "$ASSIST_WORKSPACE_TARGET"
  -module-cache-path "$ASSIST_WORKSPACE_CHECK_DIR/cache")
xcrun swiftc "${ASSIST_WORKSPACE_FLAGS[@]}" -emit-object -whole-module-optimization -O \
  mobile/ios/Assist/Inference/InferencePolicy.swift \
  mobile/ios/Assist/Inference/AssistAgentCalendar.swift \
  mobile/ios/Assist/Inference/AssistGemmaToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistAgentRun.swift \
  mobile/ios/Assist/Inference/AssistToolContracts.swift \
  mobile/ios/Assist/Inference/AssistExtendedTools.swift \
  mobile/ios/Assist/Services/AssistPrivateServicePolicy.swift \
  mobile/ios/Assist/Inference/AssistResearchAdapter.swift \
  mobile/ios/Assist/Inference/AssistResearchRun.swift \
  mobile/ios/Assist/Services/AssistApplePlacesPolicy.swift \
  mobile/ios/Assist/Services/AssistApplePlaces.swift \
  mobile/ios/Assist/Services/AssistWeatherAttributionPolicy.swift \
  mobile/ios/Assist/Services/AssistWeatherAttribution.swift \
  mobile/ios/Assist/Services/AssistPrivateService.swift \
  mobile/ios/Assist/Services/AssistTaskCheckpoint.swift \
  mobile/ios/Assist/Shared/AssistSharedInbox.swift \
  mobile/ios/Assist/AssistDocuments.swift \
  mobile/ios/Assist/Inference/AssistToolHost.swift \
  mobile/ios/Assist/Inference/AssistDeviceToolAdapter.swift \
  mobile/ios/Assist/Inference/AssistDeviceToolRun.swift \
  mobile/ios/Assist/Inference/AssistToolTransactions.swift \
  mobile/ios/Assist/AssistDeviceCapabilities.swift \
  mobile/ios/Assist/Shared/AssistAlarmAttributes.swift \
  mobile/ios/Assist/Services/AssistAlarmPolicy.swift \
  mobile/ios/Assist/Services/AssistAlarms.swift \
  mobile/ios/Assist/Services/AssistTranslationPolicy.swift \
  mobile/ios/Assist/Services/AssistTranslation.swift \
  mobile/ios/Assist/Services/AssistDocumentActionsPolicy.swift \
  mobile/ios/Assist/Services/AssistDocumentActions.swift \
  mobile/ios/Assist/Services/AssistDocumentSpotlight.swift \
  mobile/ios/Assist/Services/AssistCapabilityActions.swift \
  mobile/ios/Assist/Services/AssistIntentInbox.swift \
  mobile/ios/Assist/Services/AssistAppIntents.swift \
  mobile/ios/Assist/Services/AssistNativeServices.swift -o "$ASSIST_WORKSPACE_CHECK_DIR/AssistWorkspace.o"
xcrun swiftc "${ASSIST_WORKSPACE_FLAGS[@]}" -application-extension -emit-object -whole-module-optimization -O \
  mobile/ios/Assist/Shared/AssistSharedInbox.swift mobile/ios/AssistShare/ShareViewController.swift -o "$ASSIST_WORKSPACE_CHECK_DIR/AssistShare.o"
xcrun swiftc "${ASSIST_WORKSPACE_FLAGS[@]}" -application-extension -emit-object -whole-module-optimization -O \
  mobile/ios/Assist/Shared/AssistSharedInbox.swift mobile/ios/Assist/Shared/AssistAlarmAttributes.swift mobile/ios/AssistWidget/AssistAlarmLiveActivity.swift mobile/ios/AssistWidget/AssistWidget.swift -o "$ASSIST_WORKSPACE_CHECK_DIR/AssistWidget.o"
echo 'PASS: workspace and both extension sources compile to simulator objects against the iOS simulator SDK; not an archive or device proof.'
