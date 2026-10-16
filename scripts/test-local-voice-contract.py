#!/usr/bin/env python3
"""Static local-voice integration guards, NOT a Swift build or microphone test.

These guards catch missing registration/privacy contracts and removal of the
explicit on-device/dialect boundaries. Real permission, callback, audio and
offline behavior still requires a compiled build on an iPhone.
"""

import plistlib
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "mobile/ios/Assist"



class LocalVoiceSourceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.voice = (NATIVE / "Voice/AssistVoice.swift").read_text()
        cls.bridge = (NATIVE / "RCTNativeAssist.mm").read_text()
        cls.spec = (ROOT / "mobile/specs/NativeAssist.ts").read_text()
        cls.project = (ROOT / "mobile/ios/Assist.xcodeproj/project.pbxproj").read_text()
        cls.info = plistlib.loads((NATIVE / "Info.plist").read_bytes())

    def test_both_protected_apple_apis_have_usage_descriptions(self):
        for key in ("NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"):
            self.assertTrue(self.info.get(key, "").strip(), key)
        self.assertIs(self.info["NSAppTransportSecurity"]["NSAllowsArbitraryLoads"], False)

    def test_voice_source_is_compiled_by_the_app_target(self):
        self.assertIn("path = Assist/Voice/AssistVoice.swift;", self.project)
        source_phase = self.project.split("/* Begin PBXSourcesBuildPhase section */", 1)[1]
        source_phase = source_phase.split("/* End PBXSourcesBuildPhase section */", 1)[0]
        self.assertEqual(source_phase.count("AssistVoice.swift in Sources"), 1)

    def test_typed_voice_surface_is_implemented_by_objc_bridge(self):
        for name in ("getVoiceStatus", "startListening", "stopListening", "cancelVoice", "speak"):
            self.assertRegex(self.spec, rf"\b{name}\([^;]*\): Promise<string>;")
            self.assertRegex(self.bridge, rf"- \(void\){name}:")
        self.assertIn("readonly onVoiceEvent: CodegenTypes.EventEmitter<ProgressEvent>", self.spec)
        self.assertIn("emitOnVoiceEvent:", self.bridge)
        self.assertIn("[self->_voice invalidate]", self.bridge)

    def test_exported_voice_protocol_is_imported_before_generated_swift_header(self):
        # Regression from the real Xcode 27.1 Objective-C++ compile failure:
        # Assist-Swift.h exports NSObject <AVSpeechSynthesizerDelegate>.
        framework = self.bridge.index('#import <AVFoundation/AVFoundation.h>')
        generated = self.bridge.index('#import "Assist-Swift.h"')
        self.assertLess(framework, generated)

    def test_recognition_explicitly_requires_on_device_support(self):
        self.assertIn("supportsOnDeviceRecognition", self.voice)
        self.assertRegex(self.voice, r"\.requiresOnDeviceRecognition\s*=\s*true")
        self.assertNotRegex(self.voice, r"requiresOnDeviceRecognition\s*=\s*false")

    def test_local_provider_has_no_network_or_file_audio_entrypoint(self):
        # This intentionally guards the provider's surface only. It is not a
        # whole-binary network audit or proof of Apple's runtime behavior.
        self.assertNotRegex(self.voice, r"\b(?:URLSession|URLRequest|NWConnection|SFSpeechURLRecognitionRequest)\b")
        self.assertNotRegex(self.voice, r"https?://|\bimport\s+Network\b")

    def test_requested_dialect_has_no_default_voice_fallback(self):
        self.assertIn('Locale(identifier: "fr-CA")', self.voice)
        self.assertIn("AVSpeechSynthesisVoice.speechVoices()", self.voice)
        self.assertRegex(self.voice, r'\.language[^\n]+==\s*"fr-ca"')
        self.assertNotRegex(self.voice, r"AVSpeechSynthesisVoice\(language:")


if __name__ == "__main__":
    unittest.main()
