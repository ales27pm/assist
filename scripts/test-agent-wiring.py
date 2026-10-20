#!/usr/bin/env python3
"""Source integration guards only: not a Core AI compile or device test."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AgentWiring(unittest.TestCase):
    def test_dedicated_entrypoint_stays_under_existing_engine_owner(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        self.assertIn('func generateCalendarToday(', source)
        self.assertIn('AssistAgentRunController.run(', source)
        self.assertEqual(source.count('CoreAIRunner(bundle:'), 1)
        self.assertIn('operationInFlight = true', source)
        self.assertIn('_ = await task.result', source)

    def test_plan_and_observation_never_emit_public_progress(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        agent = source.split('private func runCalendarGeneration(', 1)[1].split(
            'private func runGeneration(', 1)[0]
        self.assertIn('emitPublicProgress: false', agent)
        self.assertIn('outcome.visibleText', agent)
        self.assertNotIn('SystemLanguageModel', source)

    def test_registry_has_no_mutating_executor(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistAgentRun.swift').read_text()
        for forbidden in ['createCalendarEvent(', 'createReminder(', 'scheduleLocalNotification(', 'URLSession', 'eval(']:
            self.assertNotIn(forbidden, source)
        self.assertIn('readCalendar(scope)', source)
        self.assertIn('try Task.checkCancellation()', source)

    def test_native_sources_are_in_app_target(self):
        project = (ROOT / 'mobile/ios/Assist.xcodeproj/project.pbxproj').read_text()
        phase = project.split('/* Begin PBXSourcesBuildPhase section */', 1)[1].split(
            '/* End PBXSourcesBuildPhase section */', 1)[0]
        for name in ['AssistAgentCalendar', 'AssistGemmaToolAdapter', 'AssistAgentRun',
                     'AssistToolContracts', 'AssistDeviceToolAdapter', 'AssistToolTransactions', 'AssistDeviceToolRun', 'AssistToolHost']:
            self.assertEqual(phase.count(f'{name}.swift in Sources'), 1)

    def test_admission_is_revoked_before_scheduling_cancel_and_ack_waits_for_drain(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        cancel = source.split('    @MainActor @objc(cancel:)', 1)[1].split('    @objc(reset:)', 1)[0]
        self.assertLess(cancel.index('admission?.cancel()'), cancel.index('Task { @concurrent'))
        self.assertIn('await admission?.waitForFinish()', cancel)
        entry = source.split('    @MainActor @objc(generateCalendarToday:', 1)[1].split('    @MainActor @objc(cancel:)', 1)[0]
        self.assertLess(entry.index('agentAdmission = admission'), entry.index('Task { @concurrent'))

    def test_text_generation_has_the_same_synchronous_revocable_admission(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        entry = source.split('    @MainActor @objc(generate:onProgress:completion:)', 1)[1].split(
            '    @MainActor @objc(generateCalendarToday:', 1)[0]
        self.assertLess(entry.index('agentAdmission = admission'), entry.index('Task { @concurrent'))
        self.assertIn('coordinator.generate(requestJSON, admission: admission', entry)
        self.assertEqual(entry.count('admission.finish()'), 2)
        actor = source.split('    func generate(_ json:', 1)[1].split('    func generateCalendarToday(', 1)[0]
        self.assertLess(actor.index('try admission.check()'), actor.index('AssistGenerationRequest.decodeJSON(json)'))
        self.assertIn('self.runGeneration(request, admission: admission', actor)

    def test_input_admission_and_preparation_are_used_at_every_generation_boundary(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        for method, end in [('runGeneration', '/// Apple'), ('runResearchGeneration', 'private func startDeviceToolGeneration'),
                            ('runDeviceToolGeneration', 'private static func validateDeviceToolTokenizer'),
                            ('runCalendarGeneration', 'private static func validateAgentTokenizer')]:
            body = source.split(f'private func {method}(', 1)[1].split(end, 1)[0]
            self.assertIn('AssistInferencePreparation.perform(check: { try admission.check() })', body)
        bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        for method in ['generate:', 'generateResearch:', 'generateDeviceToolRequest:', 'generateCalendarToday:']:
            entry = bridge.split(f'- (void){method}', 1)[1]
            self.assertLess(entry.index('AssistValidateGenerationJSON(requestJSON, reject)'),
                            entry.index('dispatch_async(dispatch_get_main_queue()'))

    def test_agent_template_is_hash_bound_and_ordinary_generation_keeps_its_template(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        self.assertIn('== AssistGemmaToolAdapter.canonicalTemplateSHA256', source)
        self.assertIn('chatTemplate: .literal(agentChatTemplate)', source)
        legacy = source.split('    private func runGeneration(', 1)[1].split('    /// Apple', 1)[0]
        self.assertIn('applyChatTemplate(messages: messages)', legacy)
        self.assertNotIn('closedToolSchema', legacy)

    def test_calendar_activity_is_a_dedicated_metadata_emitter_gated_on_main(self):
        spec = (ROOT / 'mobile/specs/NativeAssist.ts').read_text()
        self.assertIn('onCalendarActivity: CodegenTypes.EventEmitter<CalendarActivityEvent>', spec)
        bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        calendar = bridge.split('- (void)generateCalendarToday:', 1)[1].split(
            '- (void)cancelEngineWithCompletion:', 1)[0]
        activity = calendar.split('onCalendarActivity:^(NSString *json)', 1)[1]
        self.assertIn('dispatch_async(dispatch_get_main_queue()', activity)
        self.assertIn('[strongSelf->_operation isEqualToString:operation]', activity)
        self.assertIn('[strongSelf->_calendarAgentOperation isEqualToString:operation]', activity)
        self.assertIn('[strongSelf emitOnCalendarActivity:@{ @"json": json }]', activity)
        core = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        ordinary = core.split('    private func runGeneration(', 1)[1].split('    /// Apple', 1)[0]
        self.assertNotIn('onCalendarActivity', ordinary)

    def test_activity_boundary_is_after_call_and_observation_validation(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistAgentRun.swift').read_text()
        self.assertLess(source.index('switch try AssistGemmaToolAdapter.parse('), source.index('activity(.executing('))
        self.assertLess(source.index('activity(.executing('), source.index('let observation = try await readCalendar(scope)'))
        self.assertLess(source.index('observation.events.count <= 5'), source.index('activity(.observing('))

    def test_device_tool_api_is_separate_and_confirmation_bypasses_engine_busy_gate(self):
        spec = (ROOT / 'mobile/specs/NativeAssist.ts').read_text()
        for method in ['generateWithTools(requestJSON: string)', 'getDeviceToolCapabilities()',
                       'getToolOperations()', 'confirmToolAction(']:
            self.assertIn(method, spec)
        self.assertIn('onToolActivity: CodegenTypes.EventEmitter<ProgressEvent>', spec)
        bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        confirm = bridge.split('- (void)confirmToolAction:', 1)[1].split('- (void)getToolOperations:', 1)[0]
        self.assertNotIn('beginOperation:', confirm)
        self.assertIn('confirmationToken:confirmationToken', confirm)

    def test_device_loop_is_production_bounded_and_revoked_synchronously(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        self.assertIn('AssistDeviceToolRun.run(', source)
        cancel = source.split('    @MainActor @objc(cancel:)', 1)[1].split('    @objc(reset:)', 1)[0]
        self.assertLess(cancel.index('toolBroker?.cancelPending()'), cancel.index('Task { @concurrent'))
        self.assertIn('allowsTransientToolInactivity', source)
        loop = (ROOT / 'mobile/ios/Assist/Inference/AssistDeviceToolRun.swift').read_text()
        self.assertIn('maximumToolCalls = 4', loop)
        self.assertIn('maximumWrites = 1', loop)
        self.assertIn('try Task.checkCancellation()', loop)

    def test_tool_host_is_additive_and_uses_the_same_owner_and_broker(self):
        spec = (ROOT / 'mobile/specs/NativeAssist.ts').read_text()
        for method in ['getDeviceToolCapabilities()', 'generateWithTools(requestJSON: string)',
                       'getToolHostCapabilities()', 'generateWithToolHost(requestJSON: string)']:
            self.assertIn(method, spec)
        bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        v2 = bridge.split('- (void)generateWithToolHost:', 1)[1].split(
            '// The dedicated user-invoked', 1)[0]
        self.assertIn('hostV2:YES', v2)
        self.assertIn('[self beginOperation:reject]', v2)
        self.assertIn('[self installAgentLifecycleObservers]', v2)
        self.assertIn('[strongSelf->_operation isEqualToString:operation]', v2)
        self.assertIn('[strongSelf->_toolAgentOperation isEqualToString:operation]', v2)
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        actor = source.split('    func generateWithToolHost(', 2)[2].split(
            '    private func runDeviceToolGeneration(', 1)[0]
        self.assertLess(actor.index('AssistToolHost.selection(from: json)'), actor.index('operationInFlight = true'))
        self.assertIn('selection.request, allowedTools: selection.allowedTools', actor)
        production = source.split('    private func runDeviceToolGeneration(', 1)[1].split(
            '    private func runCalendarGeneration(', 1)[0]
        self.assertIn('closedToolSchema(allowedTools: allowedTools)', production)
        self.assertIn('request: request, deadline: deadline, allowedTools: allowedTools', production)
        self.assertLess(production.index('guard allowedTools.contains(call.name)'), production.index('broker.perform(call: call'))
        self.assertEqual(source.count('CoreAIRunner(bundle:'), 1)

    def test_tool_plans_stay_private_and_unknown_effect_never_reenters_model(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        generic = source.split('    private func runDeviceToolGeneration(', 1)[1].split(
            '    private static func validateDeviceToolTokenizer(', 1)[0]
        self.assertIn('emitPublicProgress: false', generic)
        self.assertIn('catch AssistToolTransactionError.outcomeUnknown', generic)
        self.assertIn('agentTools: true', generic)
        loop = (ROOT / 'mobile/ios/Assist/Inference/AssistDeviceToolRun.swift').read_text()
        self.assertLess(loop.index('switch try AssistDeviceToolAdapter.parse('), loop.index('try await perform(call)'))
        self.assertLess(loop.index('case "outcome_unknown":'), loop.index('continuationMessages('))
        self.assertLess(loop.index('case "permission_required":'), loop.index('continuationMessages('))
        bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        entry = bridge.split('- (void)generateWithTools:', 1)[1].split('// The dedicated user-invoked', 1)[0]
        self.assertIn('[strongSelf->_toolAgentOperation isEqualToString:operation]', entry)
        self.assertIn('[strongSelf emitOnToolActivity:@{ @"json": json }]', entry)
        self.assertIn('UIApplicationDidEnterBackgroundNotification', bridge)
        self.assertIn('allowsTransientToolInactivity', bridge)

    def test_research_uses_same_owner_but_no_device_executor_or_public_tool_stream(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        research = source.split('    private func runResearchGeneration(', 1)[1].split('    private func startDeviceToolGeneration(', 1)[0]
        for required in ['AssistResearchRun.run(', 'AssistResearchAdapter.closedToolSchema()', 'emitPublicProgress: false',
                         'service.performResearch(call, lease: ownedLease)', 'service.discardResearchSources(', 'try admission.check()']:
            self.assertIn(required, research)
        for forbidden in ['gateway:', 'broker.perform(', 'AssistDeviceToolAdapter.closedToolSchema', 'SystemLanguageModel']:
            self.assertNotIn(forbidden, research)
        terminal = research.split('await monitor.transition(phase: "ready", code: "PHASE_CHANGED")', 1)[1].split('return output', 1)[0]
        self.assertIn('try Task.checkCancellation()', terminal)
        self.assertIn('try admission.check()', terminal)
        self.assertEqual(source.count('CoreAIRunner(bundle:'), 1)
        bridge = (ROOT / 'mobile/ios/Assist/RCTNativeAssist.mm').read_text()
        entry = bridge.split('- (void)generateResearch:', 1)[1].split('// These control-plane', 1)[0]
        self.assertIn('[self beginOperation:reject]', entry)
        self.assertIn('[self installAgentLifecycleObservers]', entry)
        self.assertIn('_researchAgentOperation', entry)
        disconnect = bridge.split('- (void)disconnectPrivateService:', 1)[1].split('- (void)searchPrivateService:', 1)[0]
        self.assertIn('cancelEngineWithCompletion', disconnect)


if __name__ == '__main__':
    unittest.main()
