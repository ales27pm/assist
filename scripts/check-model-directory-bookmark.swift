import Foundation

/// Foundation coordinator checks with real private UserDefaults storage and fake
/// URL bookmark/security-scope boundaries. No Apple picker, weights or device.
@main
struct ModelDirectoryBookmarkChecks {
    typealias Bookmark = AssistModelDirectoryBookmark

    @MainActor
    final class Fixture {
        let defaults: UserDefaults
        let suite: String
        var scopes = 0
        var allowAccess = true
        var failWrite = false
        var stale = false
        var created = 0
        var resolveCalls = 0
        var trustedRoot: URL?

        init() {
            suite = "Assist.Bookmark.Checks.\(UUID().uuidString)"
            defaults = UserDefaults(suiteName: suite)!
        }

        func cleanup() { defaults.removePersistentDomain(forName: suite) }

        func make(validate: @escaping @Sendable (URL) async throws -> Void = { _ in }) -> Bookmark {
            Bookmark(dependencies: .init(
                read: { try Bookmark.read(from: self.defaults) },
                write: { data in
                    if self.failWrite, data != nil { throw Self.failure() }
                    try Bookmark.write(data, to: self.defaults)
                },
                resolve: { data in
                    self.resolveCalls += 1
                    guard let path = String(data: data, encoding: .utf8), path.hasPrefix("/") else {
                        throw Self.failure()
                    }
                    return .init(url: URL(fileURLWithPath: path), isStale: self.stale)
                },
                create: { url in self.created += 1; return Data(url.path.utf8) },
                startAccess: { _ in
                    guard self.allowAccess else { return false }
                    self.scopes += 1
                    return true
                },
                stopAccess: { _ in
                    self.scopes -= 1
                    precondition(self.scopes >= 0, "Security scope over-released.")
                },
                validate: validate,
                allowsUnscopedAccess: { url in
                    guard let root = self.trustedRoot else { return false }
                    return Bookmark.isTrustedDirectory(url, roots: [root]) { candidate in
                        let attributes = try? FileManager.default.attributesOfItem(atPath: candidate.path)
                        return attributes?[.type] as? FileAttributeType == .typeDirectory
                    }
                }
            ))
        }

        nonisolated static func failure() -> NSError {
            NSError(domain: "Test", code: 1, userInfo: [NSLocalizedDescriptionKey: "/private/secret/model"])
        }
    }

    actor Gate {
        var skips: Int
        var continuation: CheckedContinuation<Void, Never>?
        var entered = false
        var observers: [CheckedContinuation<Void, Never>] = []
        init(skips: Int = 0) { self.skips = skips }
        func pause() async {
            if skips > 0 { skips -= 1; return }
            entered = true
            observers.forEach { $0.resume() }
            observers.removeAll()
            await withCheckedContinuation { continuation = $0 }
        }
        func waitUntilEntered() async {
            if entered { return }
            await withCheckedContinuation { observers.append($0) }
        }
        func resume() { continuation?.resume(); continuation = nil }
    }

    @MainActor
    static func check(_ value: Bool, _ message: String) { precondition(value, message) }

    @MainActor
    static func choose(_ bookmark: Bookmark, _ path: String) async throws {
        let token = bookmark.beginSelection()
        defer { bookmark.endSelection(token: token) }
        try await bookmark.select(URL(fileURLWithPath: path), token: token)
    }

    @MainActor
    static func main() async throws {
        let fixture = Fixture()
        defer { fixture.cleanup() }
        let first = fixture.make()
        await first.restoreIfNeeded()
        check(first.selectedURL == nil && first.restorationError == nil, "Fresh install must stay unselected.")
        check(first.publicStatus["selectedModelName"] is NSNull, "Missing selection must encode null.")
        try await choose(first, "/private/models/Gemma")
        check(fixture.scopes == 0, "Selecting must balance temporary security scope.")
        check(first.publicStatus["selectedModelName"] as? String == "Gemma", "Only basename may be public.")
        let saved = fixture.defaults.data(forKey: Bookmark.storageKey)
        first.invalidate()
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == saved, "Invalidation must retain persistence.")

        let restarted = fixture.make()
        await restarted.restoreIfNeeded()
        check(restarted.selectedURL?.lastPathComponent == "Gemma", "New instance must restore selection.")
        check(fixture.scopes == 0, "Restoring status must not hold a scope.")
        _ = try await restarted.withSelectedURL()
        check(fixture.scopes == 1, "Load/probe must retain one scope.")
        restarted.releaseAccess()
        check(fixture.scopes == 0 && restarted.selectedURL != nil, "Unload must release access and keep selection.")
        _ = try await restarted.withSelectedURL()
        restarted.releaseAccess()
        check(fixture.scopes == 0, "A second load must balance scopes.")

        let token = restarted.beginSelection()
        restarted.endSelection(token: token)
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == saved, "Cancelling must preserve bookmark.")
        fixture.failWrite = true
        do { try await choose(restarted, "/private/models/Replacement"); preconditionFailure("Write failure accepted.") }
        catch { }
        fixture.failWrite = false
        check(restarted.selectedURL?.lastPathComponent == "Gemma", "Write failure replaced old selection.")
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == saved, "Write failure replaced old persistence.")
        check(fixture.scopes == 0, "Write failure leaked scope.")

        let rejected = fixture.make(validate: { _ in throw Fixture.failure() })
        do { try await choose(rejected, "/private/models/Invalid"); preconditionFailure("Invalid directory accepted.") }
        catch { }
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == saved, "Invalid selection destroyed old persistence.")
        check(fixture.scopes == 0, "Invalid selection leaked scope.")

        fixture.defaults.set("wrong stored type", forKey: Bookmark.storageKey)
        let corrupt = fixture.make()
        await corrupt.restoreIfNeeded()
        check(corrupt.selectedURL == nil && fixture.defaults.object(forKey: Bookmark.storageKey) == nil,
              "Corrupt bookmark must be cleared.")
        check(corrupt.restorationError != nil && !corrupt.restorationError!.contains("/"), "Restore error exposed private path.")
        try await choose(corrupt, "/private/models/Recovered")
        check(corrupt.restorationError == nil, "Reselection must clear recovery error.")

        fixture.allowAccess = false
        let revoked = fixture.make()
        await revoked.restoreIfNeeded()
        check(revoked.selectedURL == nil && fixture.defaults.object(forKey: Bookmark.storageKey) == nil,
              "Revoked access must clear unusable persistence.")
        fixture.allowAccess = true
        try await choose(restarted, "/private/models/Gemma")
        let missing = fixture.make(validate: { _ in throw Fixture.failure() })
        await missing.restoreIfNeeded()
        check(missing.selectedURL == nil && fixture.defaults.object(forKey: Bookmark.storageKey) == nil,
              "Missing/local-policy failure must clear saved bookmark.")
        check(fixture.scopes == 0, "Failed restoration leaked scope.")

        try await choose(restarted, "/private/models/Gemma")
        fixture.stale = true
        let beforeRefresh = fixture.created
        let stale = fixture.make()
        await stale.restoreIfNeeded()
        check(stale.selectedURL != nil && fixture.created == beforeRefresh + 1, "Valid stale bookmark was not refreshed.")
        fixture.stale = false

        let sharedGate = Gate()
        let shared = fixture.make(validate: { _ in await sharedGate.pause() })
        let resolvesBefore = fixture.resolveCalls
        let statusOne = Task { @MainActor in await shared.restoreIfNeeded() }
        await sharedGate.waitUntilEntered()
        let statusTwo = Task { @MainActor in await shared.restoreIfNeeded() }
        // This main-actor turn lets the second status attach to the same work.
        await Task.yield()
        await sharedGate.resume()
        await statusOne.value
        await statusTwo.value
        check(fixture.resolveCalls == resolvesBefore + 1 && shared.selectedURL != nil,
              "Concurrent statuses must share a restoration.")

        let cancelGate = Gate()
        let cancelling = fixture.make(validate: { _ in await cancelGate.pause() })
        let cancelledToken = cancelling.beginSelection()
        let cancelledSelection = Task { @MainActor in
            do {
                try await cancelling.select(URL(fileURLWithPath: "/private/models/Cancelled"), token: cancelledToken)
                return false
            } catch { return true }
        }
        await cancelGate.waitUntilEntered()
        cancelling.endSelection(token: cancelledToken)
        await cancelGate.resume()
        check(await cancelledSelection.value, "Cancelled in-flight selection was adopted.")
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == Data("/private/models/Gemma".utf8),
              "Cancelled validation replaced saved bookmark.")
        check(fixture.scopes == 0, "Cancelled selection leaked scope.")

        let restoreGate = Gate()
        let racing = fixture.make(validate: { url in
            if url.lastPathComponent == "Gemma" { await restoreGate.pause() }
        })
        let pendingRestore = Task { @MainActor in await racing.restoreIfNeeded() }
        await restoreGate.waitUntilEntered()
        try await choose(racing, "/private/models/Newer")
        await restoreGate.resume()
        await pendingRestore.value
        check(racing.selectedURL?.lastPathComponent == "Newer", "Old restoration overwrote newer selection.")
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == Data("/private/models/Newer".utf8),
              "Old restoration overwrote persistence.")
        check(fixture.scopes == 0, "Restore/selection race leaked scope.")

        let invalidationGate = Gate()
        let invalidating = fixture.make(validate: { _ in await invalidationGate.pause() })
        let pendingInvalidation = Task { @MainActor in await invalidating.restoreIfNeeded() }
        await invalidationGate.waitUntilEntered()
        invalidating.invalidate()
        await invalidationGate.resume()
        await pendingInvalidation.value
        check(invalidating.selectedURL == nil && fixture.scopes == 0, "Invalidated restore adopted a URL or leaked scope.")
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == Data("/private/models/Newer".utf8),
              "Invalidation modified persistent selection.")

        let loadGate = Gate(skips: 1)
        let pendingLoad = fixture.make(validate: { _ in await loadGate.pause() })
        // Let restoration finish, then suspend the separate pre-load walk.
        let loading = Task { @MainActor in
            do { _ = try await pendingLoad.withSelectedURL(); return false }
            catch { return true }
        }
        await loadGate.waitUntilEntered()
        pendingLoad.cancelPendingWork()
        await loadGate.resume()
        check(await loading.value, "Adapter cancellation allowed a pending load to start.")
        check(fixture.scopes == 0, "Cancelling a pending load leaked its scope.")

        let manager = FileManager.default
        let trustedFixture = manager.temporaryDirectory.appendingPathComponent("assist-bookmark-roots-\(UUID().uuidString)")
        try manager.createDirectory(at: trustedFixture, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: trustedFixture) }
        let container = trustedFixture.resolvingSymlinksInPath()
        let documents = container.appendingPathComponent("Documents", isDirectory: true)
        let localModel = documents.appendingPathComponent("Gemma", isDirectory: true)
        let sibling = container.appendingPathComponent("DocumentsOther/Gemma", isDirectory: true)
        let outside = container.appendingPathComponent("Outside/Gemma", isDirectory: true)
        for directory in [localModel, sibling, outside] {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try manager.createSymbolicLink(at: documents.appendingPathComponent("Escape"),
                                       withDestinationURL: outside.deletingLastPathComponent())
        fixture.trustedRoot = documents
        fixture.allowAccess = false
        let local = fixture.make()
        try await choose(local, localModel.path)
        local.invalidate()
        let localRestart = fixture.make()
        await localRestart.restoreIfNeeded()
        check(localRestart.selectedURL == localModel, "App-owned folder must restore without an extra scope.")
        _ = try await localRestart.withSelectedURL()
        localRestart.releaseAccess()
        check(fixture.scopes == 0, "Unscoped app-owned folder must never call stopAccess.")
        for rejectedURL in [sibling, documents.appendingPathComponent("Escape/Gemma")] {
            do { try await choose(localRestart, rejectedURL.path); preconditionFailure("Untrusted unscoped path accepted.") }
            catch { }
        }
        check(localRestart.selectedURL == localModel, "Rejected outside/symlink selection replaced app-owned model.")
        check(fixture.defaults.data(forKey: Bookmark.storageKey) == Data(localModel.path.utf8),
              "Rejected outside/symlink selection replaced app-owned bookmark.")
        print("PASS: directory bookmark restart, recovery, scopes, persistence failure and deterministic races.")
    }
}
