# TestFlight 26 — integrated native diagnostics and capabilities

Release source combines the reviewed native-phone foundation (PR #2), local voice startup progress and model-loader error handling, persistent native monitoring, and voice allocation/lifetime fixes. This document records release intent, not successful delivery or a proven fix on a physical iPhone.

- Native build: `26`; marketing version: `1.0.0`.
- EAS profile/channel: `testflight`; update runtime: `1.0.0-native26` in Expo config and both native platforms. Older runtime `1.0.0` binaries cannot receive updates targeting the new bridge.
- Existing model packs remain usable. No model, precision, context capacity or default compute placement was reduced.
- Native sampling no longer depends on JavaScript polling. A bounded private journal is checkpointed progressively and the previous session can be exported after reopening the app. A sudden termination can still lose the most recent unflushed interval; an unclean session is not itself proof of a crash.
- PocketTTS preset conditioning avoids retaining a redundant expanded KV cache. Speech cancellation releases the correct session; streamed-response work is drained without allocating one promise chain per queued phrase. These are regression-tested mechanisms, not proof that every memory failure is fixed.
- Native capabilities keep explicit iOS permissions and bounded access. The app does not gain unrestricted control of other apps or the whole phone.

## What to test / Quoi tester

Prepare the existing language model, start local voice, speak a short phrase, pause/resume and check speech output. After reopening, export the previous monitoring session from Diagnostics. Exercise native tools only when intentionally requested and confirm permission denial/cancellation is handled.

Préparer le modèle existant, démarrer le mode vocal local, dire une courte phrase, puis vérifier la réponse et la pause/reprise. Après réouverture, exporter la session précédente dans les diagnostics. Tester les outils natifs sur demande explicite, y compris le refus d’autorisation et l’annulation.

## Verification boundaries

Integrated-source preflight: 31 Jest suites / 748 tests passed, TypeScript, ESLint and iOS code generation passed, and the preview compiled. Additional checks passed: iOS launch (2), local voice (12), native device contracts (7), export contracts (18), voice-pack preparation (7), host preflight fixtures (17), and Node bundle/archive tests (75). Preview compilation emits upstream `use client` directive warnings; it still exits successfully.

VM preflight also passed on the integrated sources: `check-swift.sh` (including persistent monitoring and forced-kill/relaunch recovery), Fluid voice (14), duplex (28), and Swift 6 strict-concurrency iOS 26 ARM64 type checks for native capabilities and every app voice source, using the real compiled FluidAudio module. These checks do not compile the SDK 27 Core AI portion of the complete app.

JavaScript/contract checks and the Swift voice/monitor harnesses are preflight evidence. The available VM has Xcode 26.3 and iOS SDK 26.2, not the SDK 27 Core AI frameworks required for the complete app; full signed compilation/upload therefore uses the established EAS route. GitHub Actions is blocked by account billing, independently of local test results. Build completion, App Store Connect processing, TestFlight availability and physical-device stability must be reported separately after observation.

## First archive attempt and correction

EAS build [`f21b7188-18f4-40ef-822a-f7a285ffaf21`](https://expo.dev/accounts/ales27/projects/assist/builds/f21b7188-18f4-40ef-822a-f7a285ffaf21), source `45646b9a`, failed during Objective-C++ compilation. `Assist-Swift.h` exposes `AssistDeviceCapabilities` as a `CLLocationManagerDelegate`; its consumer `RCTNativeAssist.mm` had not imported Core Location. The minimal correction imports that SDK framework before the generated header. The new source regression fails on the submitted revision and passes on the correction (8 native-device contract checks total).

That failed archive produced no IPA and its waiting submission was canceled. The build number remains `26`, which has not been uploaded to Apple. The user explicitly authorized one further EAS build after local verification of this fix.

Proactive header audit covered all 22 app Swift files and the generated Expo provider. Foundation, UIKit, AVFoundation, CoreLocation, Expo and ExpoModulesCore cover the exposed Objective-C classes, delegates and signatures; CoreML/FluidAudio/Contacts/EventKit/LocalAuthentication/UserNotifications implementation types remain behind the Swift bridge. No other missing preimport was found. The new `bash scripts/check-device-bridge-header.sh` passed on the VM: it type-checks the actual device capability source in Swift 6 strict mode, emits its real Objective-C header in app-target mode, reproduces the failure without CoreLocation, then compiles the consumer with it. It does not archive the complete app or execute native permissions. Broader emitted-header compilation was not repeated locally because the fresh VM lacked its compiled FluidAudio module cache; complete SDK 27 compilation remains the EAS gate.

EAS rejected the initial automatic submission scheduling with `--what-to-test` because its changelog service requires Enterprise. Scheduling the same build without that option succeeded and did not create another build. TestFlight notes can instead be updated through the existing App Store Connect API authentication after a valid upload; no plan upgrade is needed for that direct Apple workflow.
