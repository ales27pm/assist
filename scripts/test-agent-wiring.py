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
                     'AssistToolContracts', 'AssistDeviceToolAdapter', 'AssistToolTransactions', 'AssistDeviceToolRun']:
            self.assertEqual(phase.count(f'{name}.swift in Sources'), 1)

    def test_admission_is_revoked_before_scheduling_cancel_and_ack_waits_for_drain(self):
        source = (ROOT / 'mobile/ios/Assist/Inference/AssistCoreAI.swift').read_text()
        cancel = source.split('    @MainActor @objc(cancel:)', 1)[1].split('    @objc(reset:)', 1)[0]
        self.assertLess(cancel.index('admission?.cancel()'), cancel.index('Task { @concurrent'))
        self.assertIn('await admission?.waitForFinish()', cancel)
        entry = source.split('    @MainActor @objc(generateCalendarToday:', 1)[1].split('    @MainActor @objc(cancel:)', 1)[0]
        self.assertLess(entry.index('agentAdmission = admission'), entry.index('Task { @concurrent'))

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


if __name__ == '__main__':
    unittest.main()
