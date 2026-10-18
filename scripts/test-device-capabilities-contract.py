#!/usr/bin/env python3
"""Source integration regressions, not iOS permission/picker execution tests.

ASSIST_DEVICE_TEST_REVISION=<commit> checks committed sources without
changing the worktree. Native type-checking and device tests remain separate.
"""

import os
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(path):
    revision = os.environ.get("ASSIST_DEVICE_TEST_REVISION")
    if revision:
        return subprocess.check_output(
            ["git", "show", f"{revision}:{path}"], cwd=ROOT, text=True
        )
    return (ROOT / path).read_text()


class DeviceCapabilitySourceContracts(unittest.TestCase):
    def contains(self, text, container):
        self.assertTrue(text in container, f"Missing source contract: {text}")

    def excludes(self, text, container):
        self.assertFalse(text in container, f"Unexpected source contract: {text}")

    @classmethod
    def setUpClass(cls):
        cls.swift = source("mobile/ios/Assist/AssistDeviceCapabilities.swift")
        cls.typescript = source("mobile/src/deviceCapabilities.ts")

    def test_photo_picker_does_not_request_full_library_access(self):
        self.contains("PHPickerViewController(configuration: configuration)", self.swift)
        self.contains("configuration.selectionLimit = 1", self.swift)
        self.excludes("PHPhotoLibrary.requestAuthorization", self.swift)
        self.excludes('case .photoLibrary:', self.swift)

    def test_pending_camera_capture_is_retired_before_a_late_grant(self):
        capture = self.swift.split("func capturePhoto(", 1)[1].split("func picker(", 1)[0]
        self.contains("pendingCameraCaptureCompletion = completion", capture)
        self.assertLess(
            capture.index("pendingCameraCaptureCompletion = completion"),
            capture.index("AVCaptureDevice.requestAccess"),
        )
        self.contains("guard !self.invalidated", capture)
        invalidation = self.swift.split("@objc func invalidate()", 1)[1].split("// MARK:", 1)[0]
        self.contains("pendingCameraCaptureCompletion = nil", invalidation)
        self.contains('Self.error("E_CANCELLED"', invalidation)
        presentation = self.swift.split("private func presentCamera(", 1)[1]
        self.contains("guard !invalidated", presentation)
        self.assertLess(presentation.index("guard !invalidated"), presentation.index("presenter.present("))

    def test_contacts_and_events_stop_during_enumeration(self):
        self.contains("contacts.enumerateContacts(with: request)", self.swift)
        self.contains("events.enumerateEvents(matching: predicate)", self.swift)
        self.assertEqual(self.swift.count("if rows.count >= limit { stop.pointee = true }"), 2)
        self.excludes("contacts.unifiedContacts(", self.swift)
        self.excludes("events.events(matching:", self.swift)

    def test_reminders_require_a_time_bounded_query_for_both_states(self):
        self.excludes("predicateForReminders(in: nil)", self.swift)
        self.contains("end.timeIntervalSince(start) <= 31 * 24 * 60 * 60", self.swift)
        self.contains("withDueDateStarting: interval.start, ending: interval.end", self.swift)
        self.contains("withCompletionDateStarting: interval.start, ending: interval.end", self.swift)
        self.contains("guard includeCompleted, incompleteRows.count < limit", self.swift)
        self.contains("startISO: string;", self.typescript)
        self.contains("endISO: string;", self.typescript)

    def test_invalidation_removes_only_generated_attachment_files(self):
        self.contains("generatedAttachmentURLs.insert(url)", self.swift)
        invalidation = self.swift.split("@objc func invalidate()", 1)[1].split("// MARK:", 1)[0]
        self.contains("for url in generatedAttachmentURLs", invalidation)
        self.contains("FileManager.default.removeItem(at: url)", invalidation)
        self.contains("generatedAttachmentURLs.removeAll()", invalidation)

    def test_pixel_limit_and_location_prompt_are_explicit(self):
        self.contains("format.scale = 1", self.swift)
        self.contains("UIGraphicsImageRenderer(size: target, format: format)", self.swift)
        self.contains("pointSize.width * imageScale", self.swift)
        self.contains("call can show iOS's when-in-use permission prompt", self.typescript)


if __name__ == "__main__":
    unittest.main()
