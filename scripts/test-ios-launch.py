#!/usr/bin/env python3
"""Check UIKit's scene configuration contract; this does not launch the app."""

import plistlib
import unittest
from pathlib import Path


class IOSLaunchConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "mobile/ios/Assist/Info.plist"
        cls.info = plistlib.loads(path.read_bytes())

    def test_application_scene_has_window_and_delegate(self):
        manifest = self.info.get("UIApplicationSceneManifest", {})
        configurations = manifest.get("UISceneConfigurations", {}).get(
            "UIWindowSceneSessionRoleApplication", []
        )
        self.assertTrue(configurations, "iOS 27 requires an application scene configuration")
        for configuration in configurations:
            self.assertEqual(configuration.get("UISceneClassName"), "UIWindowScene")
            self.assertTrue(configuration.get("UISceneConfigurationName"))
            self.assertTrue(configuration.get("UISceneDelegateClassName"))

    def test_single_window_matches_the_shared_inference_runtime(self):
        manifest = self.info.get("UIApplicationSceneManifest", {})
        self.assertIs(manifest.get("UIApplicationSupportsMultipleScenes"), False)


if __name__ == "__main__":
    unittest.main()
