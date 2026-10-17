import Foundation
import Darwin
import FileProvider
import UIKit
import UniformTypeIdentifiers

/// Keeps access to the user-selected directory local to the native module.
/// Persists only an app-private directory bookmark; no copy or path goes to JS.
@MainActor
@objc(AssistModelDirectoryPicker)
final class ModelDirectoryPicker: NSObject, UIDocumentPickerDelegate {
  private let bookmark = AssistModelDirectoryBookmark(dependencies: .init(
    read: { try AssistModelDirectoryBookmark.read(from: .standard) },
    write: { try AssistModelDirectoryBookmark.write($0, to: .standard) },
    resolve: { data in
      var stale = false
      let url = try URL(resolvingBookmarkData: data, options: [.withoutUI],
                        relativeTo: nil, bookmarkDataIsStale: &stale)
      return .init(url: url, isStale: stale)
    },
    create: { try $0.bookmarkData(options: .minimalBookmark,
                                 includingResourceValuesForKeys: nil, relativeTo: nil) },
    startAccess: { $0.startAccessingSecurityScopedResource() },
    stopAccess: { $0.stopAccessingSecurityScopedResource() },
    validate: { url in
      if let error = await ModelDirectoryPicker.validationError(for: url) { throw error }
    },
    allowsUnscopedAccess: { url in
      let manager = FileManager.default
      // These roots come from the running app's container, never from JavaScript,
      // a bookmark payload, a user preference or an external path.
      let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
      // Canonicalize only the trusted system-provided home (e.g. /var versus
      // /private/var), never a Documents/Library symlink controlled by app data.
      let roots = [home, home.resolvingSymlinksInPath()].flatMap { container in
        ["Documents", "Library"].map { container.appendingPathComponent($0, isDirectory: true) }
      }
      return AssistModelDirectoryBookmark.isTrustedDirectory(url, roots: roots) { candidate in
        guard let attributes = try? manager.attributesOfItem(atPath: candidate.path) else { return false }
        return attributes[.type] as? FileAttributeType == .typeDirectory
      }
    }
  ))
  private var selectionCompletion: ((String?, NSError?) -> Void)?
  private weak var documentPicker: UIDocumentPickerViewController?
  private var selectionVersion = 0
  private var bookmarkSelectionToken: UInt64?
  private var validatingSelection = false

  @objc var modelName: String? { bookmark.selectedURL?.lastPathComponent }

  /// Restores metadata/access only. Loading the engine always remains explicit.
  @objc(selectionStatus:)
  func selectionStatus(_ completion: @escaping ([String: Any]) -> Void) {
    Task { @MainActor in
      await bookmark.restoreIfNeeded()
      completion(bookmark.publicStatus)
    }
  }

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
    bookmarkSelectionToken = bookmark.beginSelection()
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
    guard let bookmarkToken = bookmarkSelectionToken else { return }
    let requestedVersion = selectionVersion
    validatingSelection = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        try await self.bookmark.select(candidate, token: bookmarkToken)
        guard self.selectionVersion == requestedVersion, self.selectionCompletion != nil else { return }
        self.finish(candidate.lastPathComponent, nil)
      } catch {
        guard self.selectionVersion == requestedVersion, self.selectionCompletion != nil else { return }
        self.finish(nil, error as NSError)
      }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    guard controller === documentPicker else { return }
    finish(nil, Self.error("E_CANCELLED", "Sélection du modèle annulée."))
  }

  /// Restores/revalidates the private bookmark and reacquires access after unload.
  @objc(withSelectedPath:)
  func withSelectedPath(_ completion: @escaping (String?, NSError?) -> Void) {
    Task { @MainActor in
      do { completion(try await bookmark.withSelectedURL().path, nil) }
      catch { completion(nil, error as NSError) }
    }
  }

  @objc func releaseAccess() {
    bookmark.releaseAccess()
  }

  @objc func invalidate() {
    cancelSelection()
    bookmark.invalidate()
  }

  @objc func cancelSelection() {
    selectionVersion += 1
    // The adapter also calls this when invalidating before a load/probe starts.
    // Cancel pending validation without revoking a worker's scoped access.
    bookmark.cancelPendingWork()
    documentPicker?.dismiss(animated: false)
    finish(nil, Self.error("E_CANCELLED", "Le module a été fermé."))
  }

  private func finish(_ name: String?, _ error: NSError?) {
    let completion = selectionCompletion
    selectionCompletion = nil
    if let token = bookmarkSelectionToken { bookmark.endSelection(token: token) }
    bookmarkSelectionToken = nil
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
