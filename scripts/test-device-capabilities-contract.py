#!/usr/bin/env python3
"""Source integration regressions, not iOS permission/picker execution tests.

ASSIST_DEVICE_TEST_REVISION=<commit> checks committed sources without
changing the worktree. These structural checks scope statements to their
enclosing Swift functions and ignore comments; they are not static reachability
proofs. Native type-checking and device tests remain separate.
"""

import os
import re
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


def strip_swift_comments(text):
    """Removes Swift comments while preserving strings and line structure."""
    result = []
    index = 0
    state = "code"
    block_depth = 0
    string_delimiter = ""
    raw_hashes = 0

    while index < len(text):
        if state == "line_comment":
            if text[index] == "\n":
                result.append("\n")
                state = "code"
            else:
                result.append(" ")
            index += 1
            continue

        if state == "block_comment":
            if text.startswith("/*", index):
                block_depth += 1
                result.extend((" ", " "))
                index += 2
            elif text.startswith("*/", index):
                block_depth -= 1
                result.extend((" ", " "))
                index += 2
                if block_depth == 0:
                    state = "code"
            else:
                result.append("\n" if text[index] == "\n" else " ")
                index += 1
            continue

        if state == "string":
            if text.startswith(string_delimiter, index) and text.startswith(
                "#" * raw_hashes, index + len(string_delimiter)
            ) and (
                raw_hashes > 0
                or string_delimiter == '"""'
                or not _is_escaped(text, index)
            ):
                closing_length = len(string_delimiter) + raw_hashes
                result.append(text[index:index + closing_length])
                index += closing_length
                state = "code"
            else:
                result.append(text[index])
                index += 1
            continue

        if text.startswith("//", index):
            result.extend((" ", " "))
            index += 2
            state = "line_comment"
            continue
        if text.startswith("/*", index):
            result.extend((" ", " "))
            index += 2
            state = "block_comment"
            block_depth = 1
            continue

        raw_start = index
        while raw_start < len(text) and text[raw_start] == "#":
            raw_start += 1
        if raw_start < len(text) and text[raw_start] == '"':
            raw_hashes = raw_start - index
            string_delimiter = '"""' if text.startswith('"""', raw_start) else '"'
            opening_length = raw_hashes + len(string_delimiter)
            result.append(text[index:index + opening_length])
            index += opening_length
            state = "string"
            continue

        result.append(text[index])
        index += 1

    return "".join(result)


def _is_escaped(text, index):
    backslashes = 0
    index -= 1
    while index >= 0 and text[index] == "\\":
        backslashes += 1
        index -= 1
    return backslashes % 2 == 1


def swift_function(text, name):
    """Returns one simple Swift function body after comments are removed."""
    match = re.search(rf"\bfunc\s+{re.escape(name)}\s*\(", text)
    if not match:
        raise AssertionError(f"Missing Swift function: {name}")
    opening_brace = text.find("{", match.end())
    if opening_brace == -1:
        raise AssertionError(f"Missing opening brace for Swift function: {name}")

    depth = 0
    for index in range(opening_brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[opening_brace + 1:index]
    raise AssertionError(f"Missing closing brace for Swift function: {name}")


class DeviceCapabilitySourceContracts(unittest.TestCase):
    def contains(self, pattern, container):
        self.assertRegex(container, pattern, f"Missing source contract: {pattern}")

    def excludes(self, pattern, container):
        self.assertNotRegex(container, pattern, f"Unexpected source contract: {pattern}")

    @classmethod
    def setUpClass(cls):
        cls.swift = source("mobile/ios/Assist/AssistDeviceCapabilities.swift")
        cls.swift_code = strip_swift_comments(cls.swift)
        cls.typescript = source("mobile/src/deviceCapabilities.ts")

    def function(self, name):
        return swift_function(self.swift_code, name)

    def test_photo_picker_does_not_request_full_library_access(self):
        select_photo = self.function("selectPhoto")
        self.contains(
            r"(?m)^\s*let\s+picker\s*=\s*PHPickerViewController\s*\(configuration:\s*configuration\)",
            select_photo,
        )
        self.contains(r"(?m)^\s*configuration\.selectionLimit\s*=\s*1\b", select_photo)
        self.excludes(r"PHPhotoLibrary\.requestAuthorization\b", self.swift_code)
        self.excludes(r"case\s+\.photoLibrary\s*:", self.swift_code)

    def test_bridge_imports_delegate_framework_before_generated_swift_header(self):
        bridge = strip_swift_comments(source("mobile/ios/Assist/RCTNativeAssist.mm"))
        generated = re.search(r'(?m)^\s*#import\s+"Assist-Swift\.h"', bridge)
        self.assertIsNotNone(generated)
        for name in ("CoreLocation", "UIKit", "AVFoundation"):
            with self.subTest(framework=name):
                framework = re.search(
                    rf'(?m)^\s*#import\s+<{name}/{name}\.h>', bridge
                )
                self.assertIsNotNone(framework)
                self.assertLess(framework.start(), generated.start())

    def test_photo_provider_transfers_data_before_main_actor_decode(self):
        picker = self.function("picker")
        self.contains(r"registeredContentTypes\s*\.first\(where:", picker)
        self.contains(r"loadDataRepresentation\(forTypeIdentifier:\s*imageType\.identifier\)", picker)
        self.contains(r"Task\s*\{\s*@MainActor", picker)
        self.contains(r"UIImage\(data:\s*data\)", picker)
        self.excludes(r"\.loadObject\s*\(", picker)
        self.excludes(r"object\s+as\?\s+UIImage", picker)

    def test_pending_camera_capture_is_retired_before_a_late_grant(self):
        capture = self.function("capturePhoto")
        assignment = r"(?m)^\s*pendingCameraCaptureCompletion\s*=\s*completion\b"
        self.contains(assignment, capture)
        self.assertLess(
            re.search(assignment, capture).start(),
            re.search(r"(?m)^\s*AVCaptureDevice\.requestAccess\b", capture).start(),
        )
        self.contains(r"(?m)^\s*guard\s+!self\.invalidated\s+else", capture)
        invalidation = self.function("invalidate")
        self.contains(r"(?m)^\s*pendingCameraCaptureCompletion\s*=\s*nil\b", invalidation)
        self.contains(r'(?m)^\s*completion\s*\(\s*nil,\s*Self\.error\s*\(\s*"E_CANCELLED"', invalidation)
        presentation = self.function("presentCamera")
        guard = re.search(r"(?m)^\s*guard\s+!invalidated\s+else", presentation)
        present = re.search(r"(?m)^\s*presenter\.present\b", presentation)
        self.assertIsNotNone(guard, "Missing invalidation guard in presentCamera")
        self.assertIsNotNone(present, "Missing camera presentation")
        self.assertLess(guard.start(), present.start())

    def test_contacts_and_events_stop_during_enumeration(self):
        contacts = self.function("searchContacts")
        calendar = self.function("listCalendarEvents")
        stop = r"(?m)^\s*if\s+rows\.count\s*>=\s*limit\s*\{\s*stop\.pointee\s*=\s*true\s*\}"
        self.contains(r"(?m)^\s*try\s+contacts\.enumerateContacts\s*\(with:\s*request\)", contacts)
        self.contains(r"(?m)^\s*events\.enumerateEvents\s*\(matching:\s*predicate\)", calendar)
        self.assertEqual(len(re.findall(stop, contacts)), 1)
        self.assertEqual(len(re.findall(stop, calendar)), 1)
        self.excludes(r"contacts\.unifiedContacts\s*\(", contacts)
        self.excludes(r"events\.events\s*\(matching:", calendar)

    def test_reminders_require_a_time_bounded_query_for_both_states(self):
        reminders = self.function("listReminders")
        interval = self.function("reminderDateInterval")
        self.excludes(r"predicateForReminders\s*\(in:\s*nil\)", self.swift_code)
        self.contains(r"(?m)^\s*end\.timeIntervalSince\(start\)\s*<=\s*31\s*\*\s*24\s*\*\s*60\s*\*\s*60", interval)
        self.contains(r"(?m)^\s*withDueDateStarting:\s*interval\.start,\s*ending:\s*interval\.end", reminders)
        self.contains(r"(?m)^\s*withCompletionDateStarting:\s*interval\.start,\s*ending:\s*interval\.end", reminders)
        self.contains(r"(?m)^\s*guard\s+includeCompleted,\s*incompleteRows\.count\s*<\s*limit\s+else", reminders)
        # This is intentionally a user-facing TypeScript documentation check.
        self.contains(r"startISO:\s*string;", self.typescript)
        self.contains(r"endISO:\s*string;", self.typescript)

    def test_invalidation_removes_only_generated_attachment_files(self):
        store_image = self.function("storeImage")
        invalidation = self.function("invalidate")
        self.contains(r"(?m)^\s*generatedAttachmentURLs\.insert\s*\(url\)", store_image)
        self.contains(r"(?m)^\s*for\s+url\s+in\s+generatedAttachmentURLs", invalidation)
        self.contains(r"(?m)^\s*try\?\s+FileManager\.default\.removeItem\s*\(at:\s*url\)", invalidation)
        self.contains(r"(?m)^\s*generatedAttachmentURLs\.removeAll\s*\(\)", invalidation)

    def test_pixel_limit_and_location_prompt_are_explicit(self):
        downscaled_image = self.function("downscaledImage")
        self.contains(r"(?m)^\s*format\.scale\s*=\s*1\b", downscaled_image)
        self.contains(
            r"(?m)^\s*let\s+renderer\s*=\s*UIGraphicsImageRenderer\s*\(size:\s*target,\s*format:\s*format\)",
            downscaled_image,
        )
        self.contains(r"(?m)^\s*let\s+pixelSize\s*=\s*CGSize\s*\(width:\s*pointSize\.width\s*\*\s*imageScale", downscaled_image)
        # This is intentionally a user-facing TypeScript documentation check.
        self.contains("call can show iOS's when-in-use permission prompt", self.typescript)

    def test_static_guards_reject_comment_only_and_other_function_decoys(self):
        decoy = strip_swift_comments(
            """
            func unrelatedHelper() {
                format.scale = 1
            }

            func downscaledImage() {
                // format.scale = 1
            }

            func capturePhoto() {
                /* pendingCameraCaptureCompletion = completion */
            }
            """
        )
        self.excludes(r"(?m)^\s*format\.scale\s*=\s*1\b", swift_function(decoy, "downscaledImage"))
        self.excludes(
            r"(?m)^\s*pendingCameraCaptureCompletion\s*=\s*completion\b",
            swift_function(decoy, "capturePhoto"),
        )
        self.contains(r"(?m)^\s*format\.scale\s*=\s*1\b", swift_function(decoy, "unrelatedHelper"))

        string_aware = strip_swift_comments(
            'func stringAware() { let url = "https://example.invalid/\\\"// still text"; '
            '// remove this comment\nformat.scale = 1 }'
        )
        string_body = swift_function(string_aware, "stringAware")
        self.contains(r"https://example\.invalid", string_body)
        self.contains(r"(?m)^\s*format\.scale\s*=\s*1\b", string_body)


if __name__ == "__main__":
    unittest.main()
