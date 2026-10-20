import Foundation
import UIKit
import UniformTypeIdentifiers
import PDFKit
import Vision
import ImageIO
import WidgetKit

/// Explicit user document operations only. This is not a filesystem, arbitrary
/// URL reader, model tool executor or permission to read an entire provider.
@MainActor
final class AssistDocuments: NSObject, UIDocumentPickerDelegate {
    static let shared = AssistDocuments()
    typealias Completion = @MainActor @Sendable (String?, NSError?) -> Void
    private enum PickerOperation { case importing(UUID), exporting(URL) }
    private var operation: PickerOperation?
    private var completion: Completion?
    private weak var picker: UIDocumentPickerViewController?
    private var processing = false
    private var generation = UUID()
    private var reader: Task<Void, Never>?
    private var importer: Task<Void, Never>?
    private var importAdmission: AssistInboxAdmission?
    private var readCompletion: Completion?

    func statusJSON() throws -> String {
        let available = (try? AssistSharedInbox.appGroup()) != nil
        return try encode(["schemaVersion": 1, "available": available,
                           "import": true, "export": true, "readKinds": ["text", "url", "pdf", "image"]])
    }

    func listInboxJSON() throws -> String {
        struct List: Encodable { let schemaVersion = 1; let items: [AssistSharedInbox.Item] }
        return try AssistSharedInbox.encoded(List(items: AssistSharedInbox.appGroup().list()))
    }

    func presentImport(completion: @escaping Completion) {
        guard self.completion == nil, reader == nil else { completion(nil, failure("Une opération de document est déjà ouverte.")); return }
        guard let presenter = presenter(), presenter.presentedViewController == nil else {
            completion(nil, failure("Impossible d’ouvrir le sélecteur actuellement.")); return
        }
        guard (try? AssistSharedInbox.appGroup()) != nil else { completion(nil, AssistInboxError.unavailable as NSError); return }
        generation = UUID(); importAdmission = AssistInboxAdmission()
        operation = .importing(generation); self.completion = completion
        let controller = UIDocumentPickerViewController(forOpeningContentTypes: [.plainText, .pdf, .image], asCopy: true)
        controller.allowsMultipleSelection = false; controller.delegate = self; picker = controller
        presenter.present(controller, animated: true)
    }

    func readItem(_ id: String, completion: @escaping Completion) {
        guard self.completion == nil, reader == nil else { completion(nil, failure("Une opération de document est déjà ouverte.")); return }
        let token = UUID(); generation = token; readCompletion = completion
        reader = Task { @concurrent [weak self] in
            let outcome: Result<String, Error> = Result {
                try Task.checkCancellation()
                let content = try AssistSharedInbox.appGroup().consume(id)
                let (text, method, truncated) = try Self.extract(content)
                try Task.checkCancellation()
                return try Self.encodeResult(id: id, kind: content.item.kind.rawValue, text: text, method: method, truncated: truncated)
            }
            await self?.finishRead(token: token, outcome: outcome)
        }
    }

    func removeItem(_ id: String, completion: @escaping Completion) {
        do {
            let removed = try AssistSharedInbox.appGroup().remove(id)
            AssistDocumentSpotlight.shared.documentRemoved(id)
            WidgetCenter.shared.reloadTimelines(ofKind: AssistSharedInbox.widgetKind)
            completion(try encode(["schemaVersion": 1, "id": id, "removed": removed]), nil)
        } catch { completion(nil, error as NSError) }
    }

    /// Only bounded plain text and a validated .txt basename, never paths,
    /// attachments, recipients or arbitrary URLs from the caller.
    func exportText(_ payloadJSON: String, completion: @escaping Completion) {
        guard self.completion == nil, reader == nil else { completion(nil, failure("Une opération de document est déjà ouverte.")); return }
        do {
            guard payloadJSON.utf8.count <= 96 * 1024,
                  let value = try JSONSerialization.jsonObject(with: Data(payloadJSON.utf8)) as? [String: Any],
                  Set(value.keys) == ["text", "filename"], let text = value["text"] as? String,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= AssistSharedInbox.maximumTextBytes,
                  let filename = value["filename"] as? String,
                  filename.range(of: #"^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}\.txt$"#, options: .regularExpression) != nil else {
                throw AssistInboxError.invalidItem
            }
            guard let presenter = presenter(), presenter.presentedViewController == nil else { throw AssistInboxError.unavailable }
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AssistExport-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
            let url = directory.appendingPathComponent(filename)
            do { try Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtection]) }
            catch { try? FileManager.default.removeItem(at: directory); throw error }
            generation = UUID(); operation = .exporting(directory); self.completion = completion
            let controller = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            controller.delegate = self; picker = controller
            presenter.present(controller, animated: true)
        } catch { completion(nil, error as NSError) }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, completion != nil, !processing, let operation else { return }
        switch operation {
        case .exporting:
            finish(try? encode(["schemaVersion": 1, "status": "exported"]), error: nil)
        case .importing(let identifier):
            guard urls.count == 1, let url = urls.first else { finish(nil, error: AssistInboxError.invalidItem as NSError); return }
            guard let admission = importAdmission else { finish(nil, error: AssistInboxError.unavailable as NSError); return }
            processing = true
            importer = Task { @concurrent [weak self] in
                let outcome: Result<AssistSharedInbox.Item, Error> = Result {
                    try Task.checkCancellation()
                    try admission.check()
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    var coordinatorError: NSError?
                    var imported: Result<AssistSharedInbox.Item, Error>?
                    NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinatorError) { selected in
                        imported = Result {
                            let type = try selected.resourceValues(forKeys: [.contentTypeKey]).contentType
                                ?? UTType(filenameExtension: selected.pathExtension)
                            let kind: AssistSharedInbox.Kind
                            if type?.conforms(to: .pdf) == true { kind = .pdf }
                            else if type?.conforms(to: .image) == true { kind = .image }
                            else if type?.conforms(to: .plainText) == true { kind = .text }
                            else { throw AssistInboxError.unsupported }
                            let bytes = try AssistSharedInbox.readSelectedFile(selected,
                                maximumBytes: kind == .text ? AssistSharedInbox.maximumTextBytes : AssistSharedInbox.maximumItemBytes)
                            try Task.checkCancellation()
                            try admission.check()
                            return try AssistSharedInbox.appGroup().save(id: identifier, kind: kind, data: bytes, source: .picker,
                                                                        admission: admission)
                        }
                    }
                    if let coordinatorError { throw coordinatorError }
                    guard let imported else { throw AssistInboxError.invalidItem }
                    return try imported.get()
                }
                await self?.finishImport(token: identifier, outcome: outcome)
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === picker else { return }
        finish(try? encode(["schemaVersion": 1, "status": "cancelled"]), error: nil)
    }

    func cancel() {
        importAdmission?.cancel(); importAdmission = nil
        generation = UUID(); reader?.cancel(); reader = nil; importer?.cancel(); importer = nil
        let callback = readCompletion; readCompletion = nil
        callback?(nil, failure("Lecture annulée."))
        picker?.dismiss(animated: false)
        if completion != nil { finish(nil, error: failure("Opération de document annulée.")) }
    }

    private func finishImport(token: UUID, outcome: Result<AssistSharedInbox.Item, Error>) {
        guard generation == token, completion != nil else { return }
        do {
            struct Imported: Encodable { let schemaVersion = 1; let item: AssistSharedInbox.Item }
            let item = try outcome.get()
            WidgetCenter.shared.reloadTimelines(ofKind: AssistSharedInbox.widgetKind)
            finish(try AssistSharedInbox.encoded(Imported(item: item)), error: nil)
        } catch { finish(nil, error: error as NSError) }
    }

    private func finishRead(token: UUID, outcome: Result<String, Error>) {
        guard generation == token, let callback = readCompletion else { return }
        reader = nil; readCompletion = nil
        WidgetCenter.shared.reloadTimelines(ofKind: AssistSharedInbox.widgetKind)
        switch outcome { case .success(let json): callback(json, nil); case .failure(let error): callback(nil, error as NSError) }
    }
    private func finish(_ json: String?, error: NSError?) {
        importAdmission?.cancel(); importAdmission = nil
        let callback = completion; completion = nil; processing = false; picker = nil
        importer?.cancel(); importer = nil
        if case .exporting(let directory) = operation { try? FileManager.default.removeItem(at: directory) }
        operation = nil; callback?(json, error)
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "AssistDocuments", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func encode(_ object: [String: Any]) throws -> String {
        guard let json = String(data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), encoding: .utf8) else { throw AssistInboxError.invalidItem }
        return json
    }
    private func presenter() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              let root = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return nil }
        var candidate = root
        while let presented = candidate.presentedViewController { candidate = presented }
        return candidate
    }

    nonisolated static func extract(_ content: AssistSharedInbox.Content) throws -> (String, String, Bool) {
        switch content.item.kind {
        case .text, .url:
            guard let text = String(data: content.data, encoding: .utf8) else { throw AssistInboxError.invalidItem }
            let bounded = bounded(text); return (bounded.0, "utf8", bounded.1)
        case .pdf:
            guard let pdf = PDFDocument(data: content.data) else { throw AssistInboxError.invalidItem }
            guard !pdf.isEncrypted, !pdf.isLocked else { throw AssistDocumentActionsPolicy.failure(.protectedPDF) }
            guard pdf.pageCount > 0, pdf.pageCount <= 50 else { throw AssistDocumentActionsPolicy.failure(.tooManyPages) }
            var text = ""
            var truncated = pdf.pageCount > 5
            for index in 0..<min(pdf.pageCount, 5) {
                try Task.checkCancellation()
                let next = bounded(text + (pdf.page(at: index)?.string ?? "") + "\n")
                text = next.0; truncated = truncated || next.1
                if next.1 { break }
            }
            // PDFKit text only: scanned PDFs require a separate OCR feature.
            return (text, "pdf_text", truncated)
        case .image:
            guard let source = CGImageSourceCreateWithData(content.data as CFData, nil),
                  CGImageSourceGetCount(source) == 1,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                  width.intValue > 0, height.intValue > 0, width.intValue <= 4096, height.intValue <= 4096,
                  width.intValue * height.intValue <= 16 * 1024 * 1024,
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048] as CFDictionary) else { throw AssistInboxError.invalidItem }
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
            request.recognitionLanguages = ["fr-FR", "en-US"]; request.usesLanguageCorrection = true
            try Task.checkCancellation()
            try VNImageRequestHandler(cgImage: image).perform([request])
            let rows = request.results ?? []
            let text = rows.prefix(40).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            let result = bounded(text)
            return (result.0, "vision_ocr", result.1 || rows.count > 40)
        }
    }
    nonisolated static func bounded(_ text: String) -> (String, Bool) {
        var count = 0; var result = ""
        for character in text {
            let bytes = character.utf8.count
            if count + bytes > 8192 { return (result, true) }
            result.append(character); count += bytes
        }
        return (result, false)
    }
    private nonisolated static func encodeResult(id: String, kind: String, text: String, method: String, truncated: Bool) throws -> String {
        let object: [String: Any] = ["schemaVersion": 1, "id": id, "kind": kind, "text": text,
                                     "method": method, "truncated": truncated, "untrusted": true]
        guard let json = String(data: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), encoding: .utf8) else { throw AssistInboxError.invalidItem }
        return json
    }
}
