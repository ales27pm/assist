import Foundation
import UIKit
import VisionKit
import Vision
import PDFKit
import QuickLook
import MessageUI
import UniformTypeIdentifiers
import ImageIO
import CoreText
import WidgetKit

/// Foreground user-facing document operations. Input contains app-owned IDs,
/// never arbitrary paths, attachment URLs, passwords, or executable links.
@MainActor
final class AssistDocumentActions: NSObject, @MainActor VNDocumentCameraViewControllerDelegate,
    UIDocumentPickerDelegate, QLPreviewControllerDataSource, @MainActor QLPreviewControllerDelegate,
    @MainActor MFMailComposeViewControllerDelegate, @MainActor MFMessageComposeViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    static let shared = AssistDocumentActions()
    typealias Completion = @Sendable (String?, NSError?) -> Void
    private var request: AssistDocumentActionsPolicy.Request?
    private var completion: Completion?
    private var token: UUID?
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private weak var presented: UIViewController?
    private var temporaryDirectory: URL?
    private var previewURL: URL?
    private var admission: AssistInboxAdmission?
    private var submitted = false
    private var observer: NSObjectProtocol?

    private override init() {
        super.init()
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.cancel() }
        }
        // Only our own protected staging directories are eligible for cleanup.
        Self.purgeAbandonedTemporaryDirectories()
    }

    func execute(_ json: String, completion: @escaping Completion) {
        guard self.completion == nil else { completion(nil, AssistDocumentActionsPolicy.failure(.busy)); return }
        do {
            let request = try AssistDocumentActionsPolicy.request(json)
            guard Self.foreground else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
            let id = UUID(); token = id; self.request = request; self.completion = completion
            admission = AssistInboxAdmission(); submitted = false
            deadline = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled, self?.token == id else { return }
                self?.cancel()
            }
            switch request.action {
            case .scan: try scan()
            case .export_pdf, .preview: readForPresentation(request, token: id)
            case .read, .index: read(request, token: id)
            case .search:
                AssistDocumentSpotlight.shared.search(text: request.string("query"), limit: request.integer("limit")) { [weak self] outcome in
                    guard let self, self.accepts(id) else { return }
                    do {
                        let rows = try outcome.get()
                        self.finish(fields: ["status": .string("results"),
                            "results": .array(rows.prefix(request.integer("limit")).map { .object(["inboxId": .string($0.0), "title": .string($0.1)]) }),
                            "truncated": .bool(rows.count > request.integer("limit")), "untrusted": .bool(true)])
                    } catch { self.finish(error: error) }
                }
            case .unindex:
                submitted = true
                task = Task { @MainActor [weak self] in
                    do {
                        try await AssistDocumentSpotlight.shared.remove(request.inboxId)
                        guard let self, self.accepts(id) else { return }
                        self.finish(fields: ["status": .string("unindexed"), "inboxId": .string(request.inboxId)])
                    } catch { self?.finishIfCurrent(id, error: error) }
                }
            case .compose: prepareComposer(request, token: id)
            }
        } catch {
            if self.completion != nil { finish(error: error) }
            else { completion(nil, Self.safe(error)) }
        }
    }

    func cancel() {
        guard completion != nil else { return }
        // Revoke admission before UI dismissal or cancellation can invoke delegates.
        admission?.cancel()
        let unknown = submitted
        token = nil
        AssistDocumentSpotlight.shared.cancelSearch()
        presented?.dismiss(animated: false)
        finish(error: AssistDocumentActionsPolicy.failure(unknown ? .outcomeUnknown : .cancelled))
    }

    private func scan() throws {
        guard VNDocumentCameraViewController.isSupported else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
        let camera = VNDocumentCameraViewController(); camera.delegate = self
        try present(camera)
    }
    func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        guard controller === presented else { return }
        controller.dismiss(animated: true)
        finish(fields: ["status": .string("cancelled")])
    }
    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        guard controller === presented else { return }
        controller.dismiss(animated: true); finish(error: error)
    }
    func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        guard controller === presented, let request, let id = token, let admission, accepts(id) else { return }
        do {
            guard scan.pageCount > 0, scan.pageCount <= request.integer("maxPages") else { throw AssistDocumentActionsPolicy.failure(.tooManyPages) }
            var pages: [Data] = []; var total = 0
            // Normalize orientation and bound pixels before off-main OCR/PDF work.
            for index in 0..<scan.pageCount {
                let bytes = try autoreleasepool { () throws -> Data in
                    let image = scan.imageOfPage(at: index)
                    guard image.size.width > 0, image.size.height > 0, image.size.width.isFinite, image.size.height.isFinite else { throw AssistInboxError.invalidItem }
                    let scale = min(1, 1536 / max(image.size.width, image.size.height))
                    let size = CGSize(width: max(1, floor(image.size.width * scale)), height: max(1, floor(image.size.height * scale)))
                    let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
                    let normalized = UIGraphicsImageRenderer(size: size, format: format).image { context in
                        UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
                        image.draw(in: CGRect(origin: .zero, size: size))
                    }
                    guard let bytes = normalized.jpegData(compressionQuality: 0.78) else { throw AssistInboxError.invalidItem }
                    return bytes
                }
                total += bytes.count
                guard total <= AssistSharedInbox.maximumItemBytes else { throw AssistInboxError.oversized }
                pages.append(bytes)
            }
            controller.dismiss(animated: true)
            presented = nil
            let inboxId = UUID()
            let scannedPages = pages
            submitted = true
            task = Task { @concurrent [weak self] in
                let outcome: Result<ScanResult, Error> = Result {
                    try Self.scanned(pages: scannedPages, inboxId: inboxId, admission: admission)
                }
                await self?.finishScan(id, outcome: outcome)
            }
        } catch { controller.dismiss(animated: true); finish(error: error) }
    }
    private struct ScanResult: Sendable { let item: AssistSharedInbox.Item; let text: String; let truncated: Bool; let pages: Int }
    private nonisolated static func scanned(pages: [Data], inboxId: UUID, admission: AssistInboxAdmission) throws -> ScanResult {
        var images: [CGImage] = []
        var text = ""; var truncated = false; var lines = 0
        for bytes in pages {
            try Task.checkCancellation(); try admission.check()
            let image = try decodedImage(bytes); images.append(image)
            let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
            request.recognitionLanguages = ["fr-FR", "en-US"]; request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image).perform([request])
            for row in request.results ?? [] {
                guard lines < 40 else { truncated = true; break }
                guard let value = row.topCandidates(1).first?.string else { continue }
                let next = AssistDocuments.bounded(text + value + "\n")
                text = next.0; truncated = truncated || next.1; lines += 1
                if next.1 { break }
            }
        }
        let data = try imagePDF(images)
        let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : text
        _ = try AssistToolValue.string(normalizedText).validated()
        try Task.checkCancellation(); try admission.check()
        let item = try AssistSharedInbox.appGroup().save(id: inboxId, kind: .pdf, data: data, source: .picker, admission: admission)
        return ScanResult(item: item, text: normalizedText, truncated: truncated, pages: pages.count)
    }
    private func finishScan(_ id: UUID, outcome: Result<ScanResult, Error>) {
        guard accepts(id) else { return }
        do {
            let result = try outcome.get()
            WidgetCenter.shared.reloadTimelines(ofKind: AssistSharedInbox.widgetKind)
            finish(fields: ["status": .string("scanned"), "inboxId": .string(result.item.id),
                "pageCount": .number(Double(result.pages)), "byteCount": .number(Double(result.item.byteCount)),
                "text": .string(result.text), "method": .string("vision_ocr"), "truncated": .bool(result.truncated),
                "untrusted": .bool(true), "documentState": .string(result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "no_text" : "text")])
        } catch { finish(error: error) }
    }

    private struct ReadResult: Sendable { let content: AssistSharedInbox.Content; let text: String; let method: String; let truncated: Bool; let state: String }
    private nonisolated static func readContent(_ inboxId: String) throws -> ReadResult {
        try Task.checkCancellation()
        let content = try AssistSharedInbox.appGroup().consume(inboxId)
        if content.item.kind == .pdf {
            guard let pdf = PDFDocument(data: content.data) else { throw AssistInboxError.invalidItem }
            if pdf.isEncrypted || pdf.isLocked { return ReadResult(content: content, text: "", method: "pdf_text", truncated: false, state: "protected_pdf") }
        }
        let (text, method, truncated) = try AssistDocuments.extract(content)
        return ReadResult(content: content, text: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : text,
                          method: method, truncated: truncated, state: text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "no_text" : "text")
    }
    private func read(_ request: AssistDocumentActionsPolicy.Request, token id: UUID) {
        task = Task { @concurrent [weak self] in
            let outcome = Result { try Self.readContent(request.inboxId) }
            await self?.finishRead(id, outcome: outcome)
        }
    }
    private func finishRead(_ id: UUID, outcome: Result<ReadResult, Error>) {
        guard accepts(id), let request else { return }
        do {
            let result = try outcome.get()
            WidgetCenter.shared.reloadTimelines(ofKind: AssistSharedInbox.widgetKind)
            if request.action == .index {
                guard result.state == "text" else { throw AssistDocumentActionsPolicy.failure(result.state == "protected_pdf" ? .protectedPDF : .noText) }
                submitted = true
                task = Task { @MainActor [weak self] in
                    do {
                        let expiry = try await AssistDocumentSpotlight.shared.add(result.content, title: request.string("title"), text: result.text, days: request.integer("expirationDays"))
                        guard let self, self.accepts(id) else { return }
                        self.finish(fields: ["status": .string("indexed"), "inboxId": .string(request.inboxId), "expiresAt": .string(ISO8601DateFormatter().string(from: expiry))])
                    } catch { self?.finishIfCurrent(id, error: error) }
                }
            } else {
                finish(fields: ["status": .string("read"), "inboxId": .string(request.inboxId), "kind": .string(result.content.item.kind.rawValue),
                    "text": .string(result.text), "method": .string(result.method), "truncated": .bool(result.truncated),
                    "documentState": .string(result.state), "untrusted": .bool(true)])
            }
        } catch { finish(error: error) }
    }

    private func readForPresentation(_ request: AssistDocumentActionsPolicy.Request, token id: UUID) {
        task = Task { @concurrent [weak self] in
            let outcome: Result<Data, Error> = Result {
                try Task.checkCancellation()
                let content = try AssistSharedInbox.appGroup().consume(request.inboxId)
                return try Self.pdf(content)
            }
            await self?.showPDF(id, outcome: outcome)
        }
    }
    private func showPDF(_ id: UUID, outcome: Result<Data, Error>) {
        guard accepts(id), let request else { return }
        do {
            let data = try outcome.get()
            let filename = request.action == .export_pdf ? request.string("filename") : "assist-document.pdf"
            let url = try temporary(data, filename: filename)
            if request.action == .preview {
                previewURL = url
                let controller = QLPreviewController(); controller.dataSource = self; controller.delegate = self
                guard QLPreviewController.canPreview(url as NSURL) else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
                try present(controller)
            } else {
                let controller = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
                controller.delegate = self; try present(controller); submitted = true
            }
        } catch { finish(error: error) }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === presented, let request, request.action == .export_pdf else { return }
        // The selected destination remains in the system picker; no path escapes.
        finish(fields: ["status": .string("exported"), "inboxId": .string(request.inboxId), "filename": .string(request.string("filename"))])
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === presented else { return }
        finish(fields: ["status": .string("cancelled")])
    }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { controller === presented && previewURL != nil ? 1 : 0 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
        // QL requests only [0, numberOfPreviewItems). Empty inert URL on a stale callback.
        ((index == 0 && controller === presented ? previewURL : nil) ?? URL(fileURLWithPath: "/dev/null")) as NSURL
    }
    func previewControllerDidDismiss(_ controller: QLPreviewController) {
        guard controller === presented, let request else { return }
        finish(fields: ["status": .string("closed"), "inboxId": .string(request.inboxId)])
    }

    private func prepareComposer(_ request: AssistDocumentActionsPolicy.Request, token id: UUID) {
        if let attachment = request.arguments["attachmentId"]?.stringValue {
            task = Task { @concurrent [weak self] in
                let outcome: Result<Data?, Error> = Result { try Self.pdf(AssistSharedInbox.appGroup().consume(attachment)) }
                await self?.showComposer(id, attachment: outcome)
            }
        } else { showComposer(id, attachment: .success(nil)) }
    }
    private func showComposer(_ id: UUID, attachment: Result<Data?, Error>) {
        guard accepts(id), let request else { return }
        do {
            let data = try attachment.get()
            if request.string("channel") == "email" {
                guard MFMailComposeViewController.canSendMail() else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
                let controller = MFMailComposeViewController(); controller.mailComposeDelegate = self
                controller.setToRecipients(request.recipients); controller.setSubject(request.string("subject"))
                controller.setMessageBody(request.string("body"), isHTML: false)
                if let data { controller.addAttachmentData(data, mimeType: "application/pdf", fileName: "assist-document.pdf") }
                try present(controller)
            } else {
                guard MFMessageComposeViewController.canSendText() else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
                let controller = MFMessageComposeViewController(); controller.messageComposeDelegate = self
                controller.recipients = request.recipients; controller.body = request.string("body")
                if let data {
                    guard MFMessageComposeViewController.canSendAttachments(), controller.addAttachmentData(data, typeIdentifier: UTType.pdf.identifier, filename: "assist-document.pdf") else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
                }
                try present(controller)
            }
            // From this point the person controls Send and may edit the draft.
            // Dismissal without its delegate receipt cannot prove non-submission.
            submitted = true
        } catch { finish(error: error) }
    }
    func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
        guard controller === presented else { return }
        let status: String
        switch result { case .sent: status = "queued_by_user"; case .saved: status = "saved_draft"; case .cancelled: status = "cancelled_by_user"; default: status = "failed" }
        controller.dismiss(animated: true)
        composeReceipt(status)
    }
    func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        guard controller === presented else { return }
        let status: String
        switch result { case .sent: status = "queued_by_user"; case .cancelled: status = "cancelled_by_user"; default: status = "failed" }
        controller.dismiss(animated: true); composeReceipt(status)
    }
    private func composeReceipt(_ status: String) {
        guard let request else { return }
        finish(fields: ["status": .string(status), "channel": .string(request.string("channel")), "deliveryVerified": .bool(false)])
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === presented else { return }
        // A generic dismissal is not a MessageUI/picker cancellation receipt.
        // Once the UI can send/export, a lost delegate result stays uncertain.
        if submitted { finish(error: AssistDocumentActionsPolicy.failure(.outcomeUnknown)) }
        else if request?.action == .preview, let request { finish(fields: ["status": .string("closed"), "inboxId": .string(request.inboxId)]) }
        else { finish(fields: ["status": .string("cancelled")]) }
    }

    private func present(_ controller: UIViewController) throws {
        guard Self.foreground, let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
              var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
        while let current = presenter.presentedViewController { presenter = current }
        guard !presenter.isBeingDismissed, !presenter.isBeingPresented else { throw AssistDocumentActionsPolicy.failure(.unavailable) }
        presented = controller
        controller.isModalInPresentation = request?.action == .compose
        presenter.present(controller, animated: true)
        controller.presentationController?.delegate = self
    }
    private static var foreground: Bool { UIApplication.shared.applicationState == .active }
    private func accepts(_ id: UUID) -> Bool {
        guard token == id, completion != nil else { return false }
        guard Self.foreground else { cancel(); return false }
        return true
    }
    private func finishIfCurrent(_ id: UUID, error: Error) { guard accepts(id) else { return }; finish(error: error) }
    private func finish(fields: [String: AssistToolValue]) {
        guard let request else { return }
        do { let json = try AssistDocumentActionsPolicy.response(request, fields: fields); finish(json: json, error: nil) }
        catch { finish(error: error) }
    }
    private func finish(error: Error) {
        // A failed/lost reply after a system submission is not proof that no
        // export, saved scan, Spotlight change or user send occurred.
        finish(json: nil, error: submitted ? AssistDocumentActionsPolicy.failure(.outcomeUnknown) : Self.safe(error))
    }
    private func finish(json: String?, error: NSError?) {
        let callback = completion
        completion = nil; token = nil; request = nil
        admission?.cancel(); admission = nil
        task?.cancel(); task = nil; deadline?.cancel(); deadline = nil
        presented = nil; previewURL = nil; submitted = false
        if let directory = temporaryDirectory { try? FileManager.default.removeItem(at: directory) }
        temporaryDirectory = nil
        callback?(json, error)
    }
    private func temporary(_ data: Data, filename: String) throws -> URL {
        guard !data.isEmpty, data.count <= AssistSharedInbox.maximumItemBytes else { throw AssistInboxError.oversized }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("AssistDocumentAction-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete])
        temporaryDirectory = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var protected = directory; try protected.setResourceValues(values)
        let file = directory.appendingPathComponent(filename)
        try data.write(to: file, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return file
    }
    private static func purgeAbandonedTemporaryDirectories() {
        guard let urls = try? FileManager.default.contentsOfDirectory(at: FileManager.default.temporaryDirectory, includingPropertiesForKeys: nil) else { return }
        for url in urls where url.lastPathComponent.hasPrefix("AssistDocumentAction-") {
            guard UUID(uuidString: String(url.lastPathComponent.dropFirst("AssistDocumentAction-".count))) != nil,
                  let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                  attributes[.type] as? FileAttributeType == .typeDirectory else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }
    private nonisolated static func safe(_ error: Error) -> NSError {
        let native = error as NSError
        if ["Assist.DocumentActions", "AssistDocuments"].contains(native.domain) { return native }
        if error is CancellationError { return AssistDocumentActionsPolicy.failure(.cancelled) }
        if let error = error as? AssistInboxError {
            return NSError(domain: "Assist.DocumentActions", code: 20, userInfo: [NSLocalizedDescriptionKey: error.localizedDescription])
        }
        return AssistDocumentActionsPolicy.failure(.unavailable)
    }

    private nonisolated static func decodedImage(_ data: Data) throws -> CGImage {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.intValue > 0, height.intValue > 0, width.intValue <= 4096, height.intValue <= 4096,
              width.intValue * height.intValue <= 16 * 1024 * 1024,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 2048] as CFDictionary) else { throw AssistInboxError.invalidItem }
        return image
    }
    private nonisolated static func pdf(_ content: AssistSharedInbox.Content) throws -> Data {
        switch content.item.kind {
        case .pdf:
            guard let pdf = PDFDocument(data: content.data) else { throw AssistInboxError.invalidItem }
            guard !pdf.isEncrypted, !pdf.isLocked else { throw AssistDocumentActionsPolicy.failure(.protectedPDF) }
            guard pdf.pageCount > 0, pdf.pageCount <= 50 else { throw AssistDocumentActionsPolicy.failure(.tooManyPages) }
            return content.data
        case .image: return try imagePDF([decodedImage(content.data)])
        case .text, .url:
            guard let text = String(data: content.data, encoding: .utf8), text.utf8.count <= AssistSharedInbox.maximumTextBytes else { throw AssistInboxError.invalidItem }
            return try textPDF(text)
        }
    }
    private nonisolated static func imagePDF(_ images: [CGImage]) throws -> Data {
        let data = NSMutableData(); var box = CGRect(x: 0, y: 0, width: 595, height: 842)
        guard let consumer = CGDataConsumer(data: data), let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { throw AssistInboxError.invalidItem }
        for image in images {
            try Task.checkCancellation()
            context.beginPDFPage(nil)
            let scale = min(547 / CGFloat(image.width), 794 / CGFloat(image.height))
            let width = CGFloat(image.width) * scale; let height = CGFloat(image.height) * scale
            context.draw(image, in: CGRect(x: (595 - width) / 2, y: (842 - height) / 2, width: width, height: height))
            context.endPDFPage()
        }
        context.closePDF()
        guard data.length > 0, data.length <= AssistSharedInbox.maximumItemBytes else { throw AssistInboxError.oversized }
        return data as Data
    }
    private nonisolated static func textPDF(_ text: String) throws -> Data {
        let data = NSMutableData(); var box = CGRect(x: 0, y: 0, width: 595, height: 842)
        guard let consumer = CGDataConsumer(data: data), let context = CGContext(consumer: consumer, mediaBox: &box, nil) else { throw AssistInboxError.invalidItem }
        let attributes = [kCTFontAttributeName: CTFontCreateWithName("Helvetica" as CFString, 12, nil)] as CFDictionary
        guard let string = CFAttributedStringCreate(nil, text as CFString, attributes) else { throw AssistInboxError.invalidItem }
        let framesetter = CTFramesetterCreateWithAttributedString(string)
        let path = CGPath(rect: CGRect(x: 32, y: 32, width: 531, height: 778), transform: nil)
        var offset = 0; var pages = 0
        while offset < CFAttributedStringGetLength(string) {
            try Task.checkCancellation(); pages += 1
            guard pages <= 50 else { throw AssistDocumentActionsPolicy.failure(.tooManyPages) }
            let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: offset, length: 0), path, nil)
            let visible = CTFrameGetVisibleStringRange(frame)
            guard visible.length > 0 else { throw AssistInboxError.invalidItem }
            context.beginPDFPage(nil); CTFrameDraw(frame, context); context.endPDFPage()
            offset += visible.length
        }
        context.closePDF()
        guard data.length > 0, data.length <= AssistSharedInbox.maximumItemBytes else { throw AssistInboxError.oversized }
        return data as Data
    }
}
