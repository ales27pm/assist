#!/usr/bin/env python3
"""Local source-boundary gates; not an Objective-C++, SDK or device proof.

The Swift projection harness executes the production projections separately.
These checks cover seams that a Foundation-only executable cannot compile.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
INFERENCE = ROOT / 'mobile/ios/Assist/Inference'
CONTROLS = {
    'getDebugDiagnostics': ('', 'snapshot:'),
    'configureDebugDiagnostics': ('json: string', 'configure:json completion:'),
    'exportDebugDiagnostics': ('', 'exportBundle:'),
    'clearDebugDiagnostics': ('', 'clear:'),
}
CATEGORIES = {
    'engine', 'planning', 'context', 'tools', 'consent', 'voice', 'network', 'apple',
    'documents', 'translation', 'alarms', 'storage', 'bridge', 'lifecycle', 'performance', 'system',
}


def code_mask(source):
    """Preserve offsets/braces while hiding comments and quoted literals."""
    out = list(source)
    i = 0
    while i < len(source):
        end = None
        if source.startswith('//', i):
            end = source.find('\n', i)
            if end < 0:
                end = len(source)
        elif source.startswith('/*', i):
            depth, end = 1, i + 2
            while depth and end < len(source):
                if source.startswith('/*', end):
                    depth += 1
                    end += 2
                elif source.startswith('*/', end):
                    depth -= 1
                    end += 2
                else:
                    end += 1
            if depth:
                raise AssertionError('Unterminated block comment')
        elif source[i] == '"':
            delimiter = '"""' if source.startswith('"""', i) else '"'
            end = i + len(delimiter)
            while end < len(source):
                if source[end] == '\\':
                    end += 2
                elif source.startswith(delimiter, end):
                    end += len(delimiter)
                    break
                else:
                    end += 1
            else:
                raise AssertionError('Unterminated quoted literal')
        if end is not None:
            out[i:end] = ['\n' if c == '\n' else ' ' for c in source[i:end]]
            i = end
        else:
            i += 1
    return ''.join(out)


def declaration(source, pattern):
    """Return one balanced declaration, not a split at a nested closure's end."""
    masked = code_mask(source)
    matches = list(re.finditer(pattern, masked))
    if len(matches) != 1:
        raise AssertionError(f'Expected one declaration for {pattern!r}, found {len(matches)}')
    start = matches[0].start()
    opening = masked.find('{', matches[0].end())
    if opening < 0:
        raise AssertionError(f'Missing body for {pattern!r}')
    depth = 1
    closing = opening + 1
    while depth and closing < len(masked):
        depth += (masked[closing] == '{') - (masked[closing] == '}')
        closing += 1
    if depth:
        raise AssertionError(f'Unbalanced body for {pattern!r}')
    return source[start:closing]


def objc_method(source, name):
    return declaration(source, rf'(?m)^[-+]\s*\([^\n]+?\){re.escape(name)}\s*:')


def swift_method(source, name):
    return declaration(source, rf'\bfunc\s+{re.escape(name)}\s*\(')


def control_violations(body):
    masked = code_mask(body)
    violations = []
    invalidated = masked.find('self->_invalidated')
    bridge = masked.find('AssistDebugDiagnosticsBridge')
    install = masked.find('[AssistDebugIntegration install]')
    if not (0 <= invalidated < install < bridge):
        violations.append('missing ordered invalidation/install/direct-bridge boundary')
    if 'return;' not in masked[invalidated:install]:
        violations.append('invalidation must reject and return')
    if not re.search(r'dispatch_async\(dispatch_get_main_queue\(\)', masked):
        violations.append('main-queue ownership missing')
    if re.search(r'\bprepare\w*\s*:|\bbeginOperation\s*:|->_(?:engine|voice|deviceCapabilities)|AssistNativeServices', masked):
        violations.append('diagnostic control depends on model/device admission')
    if 'trace:' in masked or 'AssistDebugDiagnostics.observe' in masked:
        violations.append('reading the diagnostic control must not trace itself')
    return violations


class DebugDiagnosticsWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        cls.recorder = (INFERENCE / 'AssistDebugDiagnostics.swift').read_text()
        cls.integration = (INFERENCE / 'AssistDebugIntegration.swift').read_text()
        cls.monitor = declaration((INFERENCE / 'AssistRuntimeMonitor.swift').read_text(), r'\bactor AssistRuntimeMonitor\b')

    def test_three_native_files_resolve_to_app_sources_only(self):
        project = (ROOT / 'mobile/ios/Assist.xcodeproj/project.pbxproj').read_text()
        objects = dict(re.findall(r'(?m)^\s*([A-F0-9]{24})(?: /\*[^\n]*?\*/)? = (\{[^\n]*?\};|\{\n[\s\S]*?^\s*\};)', project))
        targets = {re.search(r'\bname = ([A-Za-z]+);', body).group(1): body
                   for body in objects.values() if 'isa = PBXNativeTarget;' in body}
        self.assertEqual(set(targets), {'Assist', 'AssistShare', 'AssistWidget'})
        target_sources = {}
        for target, body in targets.items():
            phases = re.search(r'buildPhases = \(([\s\S]*?)\);', body).group(1)
            source_ids = [key for key in re.findall(r'\b[A-F0-9]{24}\b', phases)
                          if 'isa = PBXSourcesBuildPhase;' in objects[key]]
            self.assertEqual(len(source_ids), 1, target)
            target_sources[target] = objects[source_ids[0]]
        for name in ['AssistDebugDiagnostics', 'AssistDebugIntegration', 'AssistSystemDiagnostics']:
            path = f'Assist/Inference/{name}.swift'
            refs = [key for key, body in objects.items() if f'path = {path};' in body]
            self.assertEqual(len(refs), 1, name)
            builds = [key for key, body in objects.items()
                      if 'isa = PBXBuildFile;' in body and f'fileRef = {refs[0]}' in body]
            self.assertEqual(len(builds), 1, name)
            self.assertEqual(target_sources['Assist'].count(builds[0]), 1, name)
            for extension in ['AssistShare', 'AssistWidget']:
                self.assertNotIn(builds[0], target_sources[extension], name)
            self.assertTrue((ROOT / 'mobile/ios' / path).is_file())

    def test_codegen_and_native_controls_are_closed_and_engine_independent(self):
        spec = (ROOT / 'mobile/specs/NativeAssist.ts').read_text()
        native_controls = set(re.findall(r'(?m)^- \(void\)(\w*DebugDiagnostics)\s*:', self.bridge))
        spec_controls = set(re.findall(r'(?m)^\s*(\w*DebugDiagnostics)\(', spec))
        self.assertEqual(native_controls, set(CONTROLS))
        self.assertEqual(spec_controls, set(CONTROLS))
        for name, (arguments, selector) in CONTROLS.items():
            with self.subTest(name=name):
                self.assertIn(f'{name}({arguments}): Promise<string>;', spec)
                body = objc_method(self.bridge, name)
                self.assertEqual(control_violations(body), [])
                self.assertIn(selector, body)
        self.assertNotRegex(spec, r'(?i)\b(?:record|emit|eval|execute|log)\w*(?:debug|diagnostic)\w*\(')

    def test_control_gate_detects_real_admission_and_invalidation_regressions(self):
        good = objc_method(self.bridge, 'getDebugDiagnostics')
        self.assertTrue(control_violations(good.replace('[AssistDebugIntegration install];', '[self prepare:reject];')))
        self.assertTrue(control_violations(good.replace('self->_invalidated', 'self->_loaded')))
        self.assertTrue(control_violations(good.replace('snapshot:AssistPromise', 'snapshot:self->_engine')))

    def test_diagnostics_are_not_exposed_as_model_tools(self):
        for path in ['mobile/src/deviceToolProtocol.ts', 'mobile/src/nativeBundleTools.ts',
                     'mobile/ios/Assist/Inference/AssistToolContracts.swift',
                     'mobile/ios/Assist/Inference/AssistToolHost.swift']:
            source = (ROOT / path).read_text()
            for forbidden in [*CONTROLS, 'AssistDebugDiagnostics', 'AssistDebugIntegration', 'AssistSystemDiagnostics']:
                self.assertNotIn(forbidden, source, f'{path}: {forbidden}')

    def test_install_is_idempotent_and_relays_only_typed_projections(self):
        integration = declaration(self.integration, r'\bfinal class AssistDebugIntegration\b')
        install = swift_method(integration, 'install')
        self.assertRegex(self.integration, r'@MainActor\s+final class AssistDebugIntegration')
        self.assertIn('guard !installed else { return }; installed = true', install)
        self.assertIn('AssistToolTransactionDiagnosticsRelay.shared.install', install)
        self.assertIn('AssistDebugProjection.transaction(tool, status: status)', install)
        self.assertIn('AssistRuntimeDiagnosticRelay.shared.install', install)
        self.assertIn('AssistDebugProjection.runtime(event)', install)
        self.assertRegex(install, r'#if canImport\(MetricKit\)[\s\S]*#available\(iOS 27\.0,[\s\S]*AssistSystemDiagnostics.start\(\)')
        projection = declaration(self.integration, r'\benum AssistDebugProjection\b')
        for forbidden in ['URLSession', 'JSONDecoder', 'JSONSerialization', 'FileManager', 'CoreAIRunner', 'AssistNativeServices', 'Task {']:
            self.assertNotIn(forbidden, code_mask(projection))

    def test_producer_raw_statuses_all_reach_projection(self):
        source = (INFERENCE / 'AssistToolTransactions.swift').read_text()
        status = declaration(source, r'\bprivate enum AssistToolTransactionStatus\b')
        raw = {value or name for name, value in re.findall(r'case (\w+)(?: = "([^"]+)")?', status)}
        self.assertEqual(raw, {'awaiting_permission', 'awaiting_confirmation', 'executing', 'success', 'failed_safe', 'outcome_unknown', 'cancelled'})
        transaction = swift_method(self.integration, 'transaction')
        projected = set(re.findall(r'case "([^"]+)"\s*:', transaction))
        self.assertEqual(projected, raw)
        self.assertEqual(source.count('AssistToolTransactionDiagnosticsRelay.shared.emit('), 1)
        self.assertIn('emit(tool: call.name, status: status.rawValue, requestId: requestId)', source)
        relay = declaration(source, r'\bfinal class AssistToolTransactionDiagnosticsRelay\b')
        emit = swift_method(relay, 'emit')
        self.assertLess(emit.index('lock.unlock()'), emit.index('callback?('))
        self.assertNotRegex(code_mask(relay), r'\b(?:await|Task|JSONEncoder|AssistDebugDiagnostics)\b')

    def test_polling_and_speech_chunks_do_not_create_diagnostic_records(self):
        methods = ['getStatus', 'getVoiceStatus', 'getSpeechVoices', 'getAdvancedVoiceState',
                   'getVoicePreferences', 'getMonitoringSnapshot', 'getPreviousMonitoringSnapshot',
                   'getDeviceCapabilityStatus', 'getBiometricStatus', 'getAgentCapabilities',
                   'getDeviceToolCapabilities', 'getToolHostCapabilities', 'getResearchCapabilities',
                   'getPrivateServiceStatus', 'getDocumentStatus', 'getApplePlacesStatus',
                   'getDocumentInbox', 'getTaskCheckpoints', 'getToolOperations', 'enqueueSpeech']
        for name in methods:
            with self.subTest(name=name):
                body = objc_method(self.bridge, name)
                self.assertNotIn('trace:', body)
                self.assertNotIn('AssistDebugDiagnostics.observe', body)
                self.assertNotRegex(body, r'category:\s*@"')
        for name in ['snapshotJSON', 'previousSnapshotJSON', 'progress']:
            body = swift_method(self.monitor, name)
            self.assertNotIn('AssistRuntimeDiagnosticRelay.shared.emit', body)
            self.assertNotIn('AssistDebugDiagnostics', body)
        core = (INFERENCE / 'AssistCoreAI.swift').read_text()
        loops = list(re.finditer(r'\bfor try await\s+\w+\s+in\s+\w+\s*\{', code_mask(core)))
        self.assertGreaterEqual(len(loops), 1)
        for match in loops:
            body = declaration(core[match.start():], r'\Afor try await\s+\w+\s+in\s+\w+')
            self.assertNotRegex(code_mask(body), r'AssistDebug(?:Diagnostics|Projection)|DiagnosticRelay')

    def test_runtime_sampling_is_foreground_throttled_and_callbacks_do_not_await_recorder(self):
        sampling = swift_method(self.monitor, 'sampleIfForeground')
        self.assertIn('guard stoppedAtMs == nil, foreground else { return false }', sampling)
        self.assertRegex(sampling, r'if now - \(lastDebugSampleMs \?\? -30_000\) >= 30_000\s*\{\s*lastDebugSampleMs = now\s*AssistRuntimeDiagnosticRelay.shared.emit\(\.sample')
        self.assertEqual(self.monitor.count('AssistRuntimeDiagnosticRelay.shared.emit(.sample('), 1)
        for name in ['recordVoiceStage', 'recordLifecycle', 'memoryPressureChanged', 'thermalChanged', 'sampleIfForeground']:
            body = swift_method(self.monitor, name)
            self.assertNotIn('AssistDebugDiagnostics', body)
            self.assertNotRegex(code_mask(body), r'\bawait\b')
        lifecycle = swift_method(self.monitor, 'recordLifecycle')
        self.assertLess(lifecycle.index('guard lastLifecycleObserved'), lifecycle.index('.emit(.lifecycle'))
        voice = swift_method(self.monitor, 'recordVoiceStage')
        self.assertLess(voice.index('guard '), voice.index('.emit(.voice'))

    def test_native_trace_categories_are_literals_from_the_closed_contract(self):
        category = declaration(self.recorder, r'\benum Category\s*:')
        declared = set()
        for line in category.splitlines():
            if re.match(r'\s*case ', line):
                declared.update(re.findall(r'\w+', line.split('case ', 1)[1]))
        self.assertEqual(declared, CATEGORIES)
        categories = re.findall(r'(?:trace|category):\s*@"([^"]+)"', self.bridge)
        self.assertTrue(categories)
        self.assertTrue(set(categories) <= CATEGORIES)
        workspace_calls = self.bridge.count('[self performWorkspace:')
        workspace_categories = re.findall(r'\}\s*category:\s*(?:@"[a-z]+"|nil)\s+resolve:', self.bridge)
        self.assertEqual(len(workspace_categories), workspace_calls)
        traces = re.findall(r'\btrace:\s*([^\s]+)', self.bridge)
        self.assertEqual(traces.count('category'), 1)  # Only the native workspace helper.
        self.assertTrue(all(value == 'category' or re.fullmatch(r'@"[a-z]+"', value) for value in traces))

    def test_native_trace_completes_once_without_serializing_result_or_error(self):
        bridge = declaration(self.recorder, r'\bfinal class AssistDebugDiagnosticsBridge\b')
        trace = swift_method(bridge, 'trace')
        self.assertIn('AssistDebugDiagnostics.Category(rawValue: category)', trace)
        self.assertIn('guard latch.claim() else { return }', trace)
        self.assertEqual(trace.count('AssistDebugDiagnostics.observe('), 2)
        self.assertIn('AssistDebugDiagnostics.classifyNativeError(error)', trace)
        self.assertIn('.outputBytes: Double(result?.utf8.count ?? 0)', trace)
        for forbidden in ['JSONDecoder', 'JSONSerialization', 'localizedDescription', 'callStack', 'String(describing:', 'print(']:
            self.assertNotIn(forbidden, trace)

    def test_apple_error_domain_and_numeric_classification_cannot_drift_from_producer(self):
        policy = (ROOT / 'mobile/ios/Assist/Services/AssistApplePlacesPolicy.swift').read_text()
        failure = declaration(policy, r'\benum Failure\s*:\s*Int\b')
        # Resolve Swift's implicit Int increments from the real producer. A
        # reordered case can silently change NSError.code without a compiler
        # error; it must not silently relabel a permission failure as network.
        values, current = {}, -1
        for group in re.findall(r'\bcase\s+([^\n}]+)', code_mask(failure)):
            for item in group.split(','):
                match = re.fullmatch(r'\s*(\w+)(?:\s*=\s*(\d+))?\s*', item)
                self.assertIsNotNone(match, f'Unsupported Failure case syntax: {item}')
                name, explicit = match.groups()
                current = int(explicit) if explicit is not None else current + 1
                values[name] = current
        identities = {'cancelled': 3, 'network': 4, 'weatherAuthorization': 5, 'attributionUnavailable': 7}
        self.assertEqual({name: values[name] for name in identities}, identities)
        factory = swift_method(policy, 'failure')
        self.assertRegex(factory, r'NSError\(domain:\s*"Assist\.ApplePlaces",\s*code:\s*failure\.rawValue')
        classify = swift_method(self.recorder, 'classifyNativeError')
        self.assertRegex(classify, r'if error\.domain == "Assist\.ApplePlaces"\s*\{\s*switch error\.code')
        numeric = declaration(classify, r'\bswitch error\.code\b')
        actual = {int(code): reason for code, reason in re.findall(r'case (\d+):\s*return \.(\w+)', numeric)}
        self.assertEqual(actual, {values['cancelled']: 'cancelRequested', values['network']: 'connectionUnavailable',
                                  values['weatherAuthorization']: 'permissionDenied', values['attributionUnavailable']: 'imageUnavailable'})
        self.assertIn('default: return .unknown', numeric)
        attribution = (ROOT / 'mobile/ios/Assist/Services/AssistWeatherAttributionPolicy.swift').read_text()
        self.assertRegex(swift_method(attribution, 'failure'), r'NSError\(domain:\s*"Assist\.WeatherAttribution",\s*code:\s*1\b')
        self.assertRegex(classify, r'if error\.domain == "Assist\.WeatherAttribution", error\.code == 1\s*\{ return \.imageUnavailable }')

    def test_native_error_classification_reads_only_closed_identity_fields(self):
        classify = swift_method(self.recorder, 'classifyNativeError')
        masked = code_mask(classify)
        self.assertEqual(set(re.findall(r'\berror\.(\w+)', masked)), {'domain', 'code', 'userInfo'})
        self.assertEqual(len(re.findall(r'\berror\.userInfo\b', masked)), 1)
        self.assertEqual(len(re.findall(r'error\.userInfo\["code"\] as\? String', classify)), 1)
        self.assertRegex(classify, r'switch error\.userInfo\["code"\] as\? String\s*\{\s*case "E_')
        for forbidden in ['localizedDescription', 'NSLocalizedDescriptionKey', 'NSUnderlyingErrorKey',
                          'underlyingError', 'userInfo.values', 'userInfo.keys', 'JSONDecoder',
                          'JSONSerialization', 'String(describing:', 'callStack', 'URL(', 'print(']:
            self.assertNotIn(forbidden, classify)
        self.assertIn('error.domain == NSURLErrorDomain', classify)
        self.assertIn('error.code == NSURLErrorCancelled ? .cancelRequested : .connectionUnavailable', classify)

    def test_balanced_extractor_ignores_literal_and_comment_braces(self):
        fixture = 'func read() { let s = "{ bad }"; /* } */ run { ok() } }\nfunc next() {}'
        extracted = swift_method(fixture, 'read')
        self.assertTrue(extracted.endswith('run { ok() } }'))
        self.assertNotIn('func next', extracted)


if __name__ == '__main__':
    unittest.main(verbosity=2)
