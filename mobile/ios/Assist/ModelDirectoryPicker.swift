import Foundation
import UIKit
import UniformTypeIdentifiers

/// Keeps access to the user-selected directory local to the native module.
/// No multi-gigabyte copy, persistent bookmark, or path is returned to JS.
@MainActor
@objc(AssistModelDirectoryPicker)
final class ModelDirectoryPicker: NSObject, UIDocumentPickerDelegate {
  private var selectedURL: URL?
  private var hasSecurityScope = false
  private var selectionCompletion: ((String?, NSError?) -> Void)?
  private weak var documentPicker: UIDocumentPickerViewController?

  @objc var modelName: String? { selectedURL?.lastPathComponent }

  @objc(selectWithCompletion:)
  func select(completion: @escaping (String?, NSError?) -> Void) {
    guard selectionCompletion == nil else {
      completion(nil, Self.error("E_BUSY", "Un sélecteur est déjà ouvert."))
      return
    }
    guard let presenter = Self.presenter(), presenter.presentedViewController == nil else {
      completion(nil, Self.error("E_PRESENTATION", "Impossible d’ouvrir le sélecteur actuellement."))
      return
    }
    selectionCompletion = completion
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    picker.allowsMultipleSelection = false
    picker.delegate = self
    documentPicker = picker
    presenter.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard selectionCompletion != nil else { return }
    guard let candidate = urls.first, candidate.isFileURL else {
      finish(nil, Self.error("E_MODEL_DIRECTORY", "Sélectionne un dossier local de modèle."))
      return
    }
    let acquired = candidate.startAccessingSecurityScopedResource()
    do {
      try Self.validateDirectory(candidate)
      releaseAccess()
      selectedURL = candidate
      hasSecurityScope = acquired
      finish(candidate.lastPathComponent, nil)
    } catch {
      if acquired { candidate.stopAccessingSecurityScopedResource() }
      finish(nil, error as NSError)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(nil, Self.error("E_CANCELLED", "Sélection du modèle annulée."))
  }

  /// Reacquires access after unload; a selection exists only for this process.
  @objc(withSelectedPath:)
  func withSelectedPath(_ completion: (String?, NSError?) -> Void) {
    guard let selectedURL else {
      completion(nil, Self.error("E_NO_MODEL", "Sélectionne d’abord un dossier de modèle."))
      return
    }
    if !hasSecurityScope {
      hasSecurityScope = selectedURL.startAccessingSecurityScopedResource()
    }
    do {
      try Self.validateDirectory(selectedURL)
      completion(selectedURL.path, nil)
    } catch {
      releaseAccess()
      completion(nil, error as NSError)
    }
  }

  @objc func releaseAccess() {
    if hasSecurityScope {
      selectedURL?.stopAccessingSecurityScopedResource()
      hasSecurityScope = false
    }
  }

  @objc func invalidate() {
    cancelSelection()
    releaseAccess()
    selectedURL = nil
  }

  @objc func cancelSelection() {
    documentPicker?.dismiss(animated: false)
    finish(nil, Self.error("E_CANCELLED", "Le module a été fermé."))
  }

  private func finish(_ name: String?, _ error: NSError?) {
    let completion = selectionCompletion
    selectionCompletion = nil
    documentPicker = nil
    completion?(name, error)
  }

  private static func validateDirectory(_ url: URL) throws {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true,
          FileManager.default.isReadableFile(atPath: url.path) else {
      throw error("E_MODEL_DIRECTORY", "Le dossier doit être local, lisible et ne pas être un lien symbolique.")
    }
  }

  private static func error(_ code: String, _ message: String) -> NSError {
    NSError(domain: "Assist.ModelDirectoryPicker", code: 1,
            userInfo: [NSLocalizedDescriptionKey: message, "code": code])
  }

  private static func presenter() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
    guard var presenter = scene?.windows.first(where: \.isKeyWindow)?.rootViewController else {
      return nil
    }
    while let presented = presenter.presentedViewController {
      presenter = presented
    }
    if let navigation = presenter as? UINavigationController {
      return navigation.visibleViewController ?? navigation
    }
    if let tabs = presenter as? UITabBarController {
      return tabs.selectedViewController ?? tabs
    }
    return presenter
  }
}
