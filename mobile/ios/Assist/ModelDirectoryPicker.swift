import Foundation
import Darwin
import FileProvider
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
  private var selectionVersion = 0
  private var accessVersion = 0
  private var validatingSelection = false

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
    selectionVersion += 1
    selectionCompletion = completion
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    picker.allowsMultipleSelection = false
    picker.delegate = self
    documentPicker = picker
    presenter.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard controller === documentPicker, selectionCompletion != nil,
          !validatingSelection else { return }
    guard let candidate = urls.first, candidate.isFileURL else {
      finish(nil, Self.error("E_MODEL_DIRECTORY", "Sélectionne un dossier local de modèle."))
      return
    }
    let acquired = candidate.startAccessingSecurityScopedResource()
    let requestedVersion = selectionVersion
    validatingSelection = true
    Task { @MainActor [weak self] in
      let validationError = await Self.validationError(for: candidate)
      guard let self, self.selectionVersion == requestedVersion,
            self.selectionCompletion != nil else {
        if acquired { candidate.stopAccessingSecurityScopedResource() }
        return
      }
      if let validationError {
        if acquired { candidate.stopAccessingSecurityScopedResource() }
        self.finish(nil, validationError)
      } else {
        self.releaseAccess()
        self.selectedURL = candidate
        self.hasSecurityScope = acquired
        self.finish(candidate.lastPathComponent, nil)
      }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard controller === documentPicker else { return }
    finish(nil, Self.error("E_CANCELLED", "Sélection du modèle annulée."))
  }

  /// Reacquires access after unload; a selection exists only for this process.
  @objc(withSelectedPath:)
  func withSelectedPath(_ completion: @escaping (String?, NSError?) -> Void) {
    guard let selectedURL else {
      completion(nil, Self.error("E_NO_MODEL", "Sélectionne d’abord un dossier de modèle."))
      return
    }
    // Own a separate scope while walking: invalidation may release the retained
    // selection before the background walk has finished using its URLs.
    let acquired = selectedURL.startAccessingSecurityScopedResource()
    let requestedVersion = accessVersion
    Task { @MainActor [weak self] in
      let validationError = await Self.validationError(for: selectedURL)
      guard let self, self.accessVersion == requestedVersion,
            self.selectedURL == selectedURL else {
        if acquired { selectedURL.stopAccessingSecurityScopedResource() }
        completion(nil, Self.error("E_CANCELLED", "Le module a été fermé."))
        return
      }
      if let validationError {
        if acquired { selectedURL.stopAccessingSecurityScopedResource() }
        self.releaseAccess()
        completion(nil, validationError)
      } else {
        if self.hasSecurityScope {
          if acquired { selectedURL.stopAccessingSecurityScopedResource() }
        } else {
          // Transfer this walk's scope to the load/probe until releaseAccess.
          self.hasSecurityScope = acquired
        }
        completion(selectedURL.path, nil)
      }
    }
  }

  @objc func releaseAccess() {
    accessVersion += 1
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
    selectionVersion += 1
    // The adapter also calls this when invalidating before a load/probe starts.
    // Cancel pending validation without revoking a worker's scoped access.
    accessVersion += 1
    documentPicker?.dismiss(animated: false)
    finish(nil, Self.error("E_CANCELLED", "Le module a été fermé."))
  }

  private func finish(_ name: String?, _ error: NSError?) {
    let completion = selectionCompletion
    selectionCompletion = nil
    validatingSelection = false
    documentPicker = nil
    completion?(name, error)
  }

  private nonisolated static func validationError(for url: URL) async -> NSError? {
    await Task.detached(priority: .userInitiated) { () -> NSError? in
      do {
        try validateDirectory(url)
        return nil
      } catch {
        return error as NSError
      }
    }.value
  }

  private nonisolated static func validateDirectory(_ url: URL) throws {
    let manager = FileManager.default
    try AssistModelDirectoryPolicy.validate(url, entry: { candidate in
      // lstat and URL resource values inspect metadata without materializing files.
      var status = stat()
      guard candidate.withUnsafeFileSystemRepresentation({ path in
        path.map { lstat($0, &status) } ?? -1
      }) == 0 else {
        throw error("E_MODEL_DIRECTORY", "Impossible de vérifier les fichiers du modèle local.")
      }
      let values = try candidate.resourceValues(forKeys: [
        .isDirectoryKey, .isSymbolicLinkKey, .isUbiquitousItemKey,
        .ubiquitousItemDownloadingStatusKey, .ubiquitousItemIsDownloadingKey
      ])
      // SF_DATALESS also covers replicated File Provider placeholders outside iCloud.
      // Nonreplicated providers use a separate placeholder URL.
      let placeholder = NSFileProviderManager.placeholderURL(for: candidate)
      let downloadStatus = values.ubiquitousItemDownloadingStatus
      return AssistModelDirectoryPolicy.Entry(
        isDirectory: values.isDirectory == true,
        isSymbolicLink: values.isSymbolicLink != false,
        isReadable: manager.isReadableFile(atPath: candidate.path),
        isUbiquitous: values.isUbiquitousItem == true,
        isDownloaded: status.st_flags & UInt32(SF_DATALESS) == 0
          && !manager.fileExists(atPath: placeholder.path)
          && values.ubiquitousItemIsDownloading != true
          && (downloadStatus == nil || downloadStatus == .current || downloadStatus == .downloaded)
      )
    }, children: { directory in
      // Include packages and hidden entries; a placeholder may be nested anywhere.
      try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
    })
  }

  private nonisolated static func error(_ code: String, _ message: String) -> NSError {
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
