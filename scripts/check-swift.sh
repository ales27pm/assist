#!/usr/bin/env bash
# Foundation/CryptoKit contracts only; this does not build Core AI or qualify an iPhone.
set -euo pipefail
cd "$(dirname "$0")/.."
SWIFTC="${SWIFTC:-swiftc}"
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
NATIVE=mobile/ios/Assist/Inference

"$SWIFTC" -swift-version 6 -strict-concurrency=complete -D ASSIST_POLICY_CHECKS \
  "$NATIVE/InferencePolicy.swift" "$NATIVE/InferencePolicyChecks.swift" -o "$CHECK_DIR/policy"
"$CHECK_DIR/policy"
"$SWIFTC" -swift-version 6 -strict-concurrency=complete \
  "$NATIVE/AssistRuntimeMonitor.swift" scripts/check-runtime-monitor.swift -o "$CHECK_DIR/monitor"
"$CHECK_DIR/monitor"
"$SWIFTC" -swift-version 6 -strict-concurrency=complete \
  "$NATIVE/InferencePolicy.swift" "$NATIVE/AssistModelLoadProbe.swift" \
  scripts/check-model-load-probe.swift -o "$CHECK_DIR/load-probe"
"$CHECK_DIR/load-probe"
"$SWIFTC" -swift-version 6 -strict-concurrency=complete \
  "$NATIVE/AssistSpecializationRepair.swift" scripts/check-specialization-repair.swift -o "$CHECK_DIR/repair"
"$CHECK_DIR/repair"
"$SWIFTC" -swift-version 6 -strict-concurrency=complete \
  "$NATIVE/AssistModelAssetProbe.swift" scripts/check-model-asset-probe.swift -o "$CHECK_DIR/asset-probe"
"$CHECK_DIR/asset-probe"
