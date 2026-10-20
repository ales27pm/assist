import Foundation
import UIKit

/// User-invoked workspace controls. None is an executor in Gemma's registry;
/// imports and search hits never become consent tokens or trusted instructions.
@MainActor @objc(AssistNativeServices)
final class AssistNativeServices: NSObject {
    @objc static let shared = AssistNativeServices()
    private var backgroundObserver: NSObjectProtocol?
    private var inactiveObserver: NSObjectProtocol?

    override private init() {
        super.init()
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                AssistNativeServices.shared.cancelPending()
            }
        }
        inactiveObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated {
                // A transient inactive interval must revoke these read tickets
                // natively, even if JS observes the lifecycle change later.
                // Do not cancel document pickers, setup or broker-owned auth UI.
                AssistApplePlaces.shared.cancel()
                AssistWeatherAttribution.shared.cancelAll()
            }
        }
    }

    private func snapshot(_ completion: @escaping @Sendable (String?, NSError?) -> Void,
                          operation: () throws -> String) {
        do { completion(try operation(), nil) }
        catch { completion(nil, NSError(domain: "AssistWorkspace", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Les données de cette fonction native sont indisponibles ou incompatibles. Aucun nouvel accès automatique."])) }
    }

    private func foreground(_ completion: @escaping @Sendable (String?, NSError?) -> Void) -> Bool {
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, NSError(domain: "AssistWorkspace", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Reviens dans Assist pour lancer cette action."]))
            return false
        }
        return true
    }

    @objc func executeAlarms(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistAlarms.shared.execute(request, completion: completion)
    }
    @objc func cancelAlarms(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        AssistAlarms.shared.cancel(); completion("{\"schemaVersion\":1,\"cancelled\":true}", nil)
    }
    @objc func executeTranslation(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistTranslation.shared.execute(request, completion: completion)
    }
    @objc func cancelTranslation(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        AssistTranslation.shared.cancel(); completion("{\"schemaVersion\":1,\"cancelled\":true}", nil)
    }
    @objc func executeDocumentAction(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistDocumentActions.shared.execute(request, completion: completion)
    }
    @objc func cancelDocumentActions(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        AssistDocumentActions.shared.cancel(); completion("{\"schemaVersion\":1,\"cancelled\":true}", nil)
    }
    @objc func pendingNativeIntent(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        snapshot(completion) { try AssistIntentInbox.snapshotJSON() }
    }
    @objc func dismissNativeIntent(_ id: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        snapshot(completion) { try AssistIntentInbox.dismiss(id) }
    }
    @objc func privateServiceStatus(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        snapshot(completion) { try AssistPrivateService.shared.statusJSON() }
    }
    @objc func presentPrivateServiceSetup(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistPrivateService.shared.presentSetup(completion: completion)
    }
    @objc func disconnectPrivateService(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        AssistPrivateService.shared.disconnect(completion: completion)
    }
    @objc func searchPrivateService(_ requestJSON: String,
                                  completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistPrivateService.shared.search(requestJSON, completion: completion)
    }
    @objc func openPrivateSearchResult(_ requestId: String, resultId: String,
                                      completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistPrivateService.shared.openResult(requestId, resultId: resultId, completion: completion)
    }
    @objc func documentStatus(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        // State is read only. A caller cannot use this handshake as permission.
        snapshot(completion) { try AssistDocuments.shared.statusJSON() }
    }
    private func placesCompletion(_ completion: @escaping @Sendable (String?, NSError?) -> Void) -> AssistApplePlaces.Completion {
        { result in
            switch result {
            case .success(let json): completion(json, nil)
            case .failure(let error): completion(nil, error as NSError)
            }
        }
    }
    @objc func applePlacesStatus(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        snapshot(completion) { try AssistApplePlaces.shared.statusJSON() }
    }
    @objc func searchApplePlaces(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistApplePlaces.shared.searchPlaces(request, completion: placesCompletion(completion))
    }
    @objc func appleDirections(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistApplePlaces.shared.directions(request, completion: placesCompletion(completion))
    }
    @objc func appleForecast(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistApplePlaces.shared.forecast(request, completion: placesCompletion(completion))
    }
    @objc func openApplePlace(_ requestId: String, resultId: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistApplePlaces.shared.openPlace(requestId, resultId: resultId, completion: placesCompletion(completion))
    }
    @objc func cancelApplePlaces(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        AssistApplePlaces.shared.cancel()
        completion("{\"schemaVersion\":1,\"cancelled\":true}", nil)
    }
    @objc func renderWeatherAttribution(_ request: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistWeatherAttribution.shared.render(request, completion: completion)
    }
    @objc func cancelWeatherAttribution(_ requestId: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        AssistWeatherAttribution.shared.cancel(requestId, completion: completion)
    }
    @objc func importDocument(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistDocuments.shared.presentImport(completion: completion)
    }
    @objc func documentInbox(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        snapshot(completion) { try AssistDocuments.shared.listInboxJSON() }
    }
    @objc func readDocument(_ itemId: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistDocuments.shared.readItem(itemId, completion: completion)
    }
    @objc func removeDocument(_ itemId: String, completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistDocuments.shared.removeItem(itemId, completion: completion)
    }
    @objc func exportDocumentText(_ payloadJSON: String,
                                completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard foreground(completion) else { return }
        AssistDocuments.shared.exportText(payloadJSON, completion: completion)
    }
    @objc func taskCheckpoints(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        snapshot(completion) { try AssistTaskCheckpoint.shared.snapshotJSON() }
    }
    @objc func updateTaskCheckpoint(_ requestJSON: String,
                                  completion: @escaping @Sendable (String?, NSError?) -> Void) {
        guard UIApplication.shared.applicationState == .active else {
            completion(nil, NSError(domain: "AssistWorkspace", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Reviens dans Assist avant de reprendre une tâche."]))
            return
        }
        snapshot(completion) { try AssistTaskCheckpoint.shared.apply(requestJSON) }
    }
    @objc func cancelWorkspace(_ completion: @escaping @Sendable (String?, NSError?) -> Void) {
        cancelPending()
        completion("{\"schemaVersion\":1,\"cancelled\":true}", nil)
    }
    @objc func cancelPending() {
        AssistCapabilityActions.cancel()
        AssistWeatherAttribution.shared.cancelAll()
        AssistApplePlaces.shared.cancel()
        AssistPrivateService.shared.cancel()
        AssistDocuments.shared.cancel()
        AssistTaskCheckpoint.shared.pauseActive()
    }
}
