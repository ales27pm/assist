#!/usr/bin/env bash
# Execute the unmodified production projector and recorder with isolated type
# seams. This does not compile UIKit/MetricKit/React Native or qualify a device.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v swiftc >/dev/null || { echo 'ERROR: diagnostic projections require Swift 6.' >&2; exit 69; }
command -v python3 >/dev/null || { echo 'ERROR: diagnostic projections require Python 3 for source extraction.' >&2; exit 69; }
ASSIST_DEBUG_PROJECTIONS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/assist-debug-projections.XXXXXX")"
trap 'rm -rf "$ASSIST_DEBUG_PROJECTIONS_DIR"' EXIT
python3 -B - "$ASSIST_DEBUG_PROJECTIONS_DIR" <<'PY'
import importlib.util
from pathlib import Path
import sys

root = Path.cwd()
spec = importlib.util.spec_from_file_location('debug_wiring', root / 'scripts/test-debug-diagnostics-wiring.py')
wiring = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wiring)
inference = root / 'mobile/ios/Assist/Inference'
out = Path(sys.argv[1])
# The entire production projection body is compiled, with no edited branches.
projection = wiring.declaration((inference / 'AssistDebugIntegration.swift').read_text(), r'\benum AssistDebugProjection\b')
(out / 'Projection.swift').write_text('import Foundation\n' + projection + '\n')
contracts = (inference / 'AssistToolContracts.swift').read_text()
tool = wiring.declaration(contracts, r'\benum AssistToolName\s*:')
# Only the case declarations are required by the projection. Framework owners
# and tool execution are deliberately absent from this executable.
tool_cases = '\n'.join(line for line in tool.splitlines() if line.strip().startswith('case '))
runtime = (inference / 'AssistRuntimeMonitor.swift').read_text()
sample = wiring.declaration(runtime, r'\bstruct AssistRuntimeSample\s*:')
event = wiring.declaration(runtime, r'\benum AssistRuntimeDiagnosticEvent\s*:')
(out / 'Seams.swift').write_text('import Foundation\nenum AssistToolName: String, CaseIterable, Sendable {\n' + tool_cases + '\n}\n' + sample + '\n' + event + '\n')
print('Compiling production AssistDebugProjection + recorder; tool cases and runtime value types isolated; no SDK/device claim.', flush=True)
PY
ASSIST_DEBUG_PROJECTIONS_TARGET=()
if [[ "$(uname -s)" == "Darwin" ]]; then ASSIST_DEBUG_PROJECTIONS_TARGET=(-target "$(uname -m)-apple-macosx15.0"); fi
swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors -parse-as-library \
  "${ASSIST_DEBUG_PROJECTIONS_TARGET[@]}" -module-cache-path "$ASSIST_DEBUG_PROJECTIONS_DIR/cache" \
  mobile/ios/Assist/Inference/AssistDebugDiagnostics.swift \
  "$ASSIST_DEBUG_PROJECTIONS_DIR/Seams.swift" "$ASSIST_DEBUG_PROJECTIONS_DIR/Projection.swift" \
  scripts/check-debug-projections.swift -o "$ASSIST_DEBUG_PROJECTIONS_DIR/check-debug-projections"
"$ASSIST_DEBUG_PROJECTIONS_DIR/check-debug-projections"
