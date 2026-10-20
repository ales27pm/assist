import Foundation
import ImageIO
#if canImport(UIKit)
import UIKit
#endif

private final class AssistWeatherMarkRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum AssistWeatherMarkLoader {
    /// No cookies, credentials, redirect follow, caller HTML, SVG, or browser.
    @concurrent
    static func load(_ request: AssistWeatherAttributionPolicy.Request) async throws -> String {
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil; settings.httpCookieStorage = nil; settings.urlCredentialStorage = nil
        settings.httpShouldSetCookies = false; settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 12; settings.timeoutIntervalForResource = 15
        settings.httpMaximumConnectionsPerHost = 1
        let session = URLSession(configuration: settings)
        defer { session.invalidateAndCancel() }
        var urlRequest = URLRequest(url: request.markURL)
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("image/png", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: urlRequest, delegate: AssistWeatherMarkRedirects())
        guard let response = response as? HTTPURLResponse else { throw AssistWeatherAttributionPolicy.failure() }
        try AssistWeatherAttributionPolicy.headers(status: response.statusCode, mime: response.mimeType,
            length: response.expectedContentLength, responseURL: response.url, requestURL: request.markURL)
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < AssistWeatherAttributionPolicy.maximumAssetBytes else { throw AssistWeatherAttributionPolicy.failure() }
            data.append(byte)
        }
        try Task.checkCancellation()
        let asset = try decode(data, request: request)
        try Task.checkCancellation()
        return try AssistWeatherAttributionPolicy.response(asset)
    }

    /// Decode after metadata bounds, then re-encode as a clean PNG without
    /// changing pixels, colours, aspect ratio, text or the official mark.
    static func decode(_ data: Data, request: AssistWeatherAttributionPolicy.Request) throws -> AssistWeatherAttributionPolicy.Asset {
        try AssistWeatherAttributionPolicy.png(data)
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1, CGImageSourceGetType(source) as String? == "public.png",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { throw AssistWeatherAttributionPolicy.failure() }
        try AssistWeatherAttributionPolicy.dimensions(width: width, height: height)
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              image.width == width, image.height == height else { throw AssistWeatherAttributionPolicy.failure() }
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, "public.png" as CFString, 1, nil) else {
            throw AssistWeatherAttributionPolicy.failure()
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw AssistWeatherAttributionPolicy.failure() }
        let png = encoded as Data
        try AssistWeatherAttributionPolicy.png(png)
        return .init(schemaVersion: 1, requestId: request.requestId, sourceURL: request.markURL.absoluteString,
                     pngDataURI: "data:image/png;base64," + png.base64EncodedString(), width: width, height: height, rendered: true)
    }
}

#if canImport(UIKit)
@MainActor
final class AssistWeatherAttribution {
    static let shared = AssistWeatherAttribution()
    typealias Completion = @Sendable (String?, NSError?) -> Void
    private struct Pending {
        let ticket: UUID
        let task: Task<Void, Never>
        let deadline: Task<Void, Never>
        let completion: Completion
    }
    private var epoch = AssistWeatherAttributionPolicy.Epoch()
    private var pending: [String: Pending] = [:]
    private init() {}
    private var foreground: Bool { UIApplication.shared.applicationState == .active }

    func render(_ json: String, completion: @escaping Completion) {
        do {
            let request = try AssistWeatherAttributionPolicy.request(json)
            guard foreground else { throw AssistWeatherAttributionPolicy.failure() }
            let ticket = try epoch.begin(request.requestId)
            let task = Task { @MainActor in
                guard self.epoch.accepts(request.requestId, ticket: ticket, foreground: self.foreground) else {
                    self.finish(request.requestId, ticket: ticket, json: nil); return
                }
                do {
                    let value = try await AssistWeatherMarkLoader.load(request)
                    self.finish(request.requestId, ticket: ticket, json: value)
                } catch { self.finish(request.requestId, ticket: ticket, json: nil) }
            }
            let deadline = Task { @concurrent [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                await self?.finish(request.requestId, ticket: ticket, json: nil)
            }
            pending[request.requestId] = .init(ticket: ticket, task: task, deadline: deadline, completion: completion)
        } catch { completion(nil, AssistWeatherAttributionPolicy.failure()) }
    }
    func cancel(_ requestId: String, completion: @escaping Completion) {
        guard AssistWeatherAttributionPolicy.identifier(requestId) else { completion(nil, AssistWeatherAttributionPolicy.failure()); return }
        if let value = pending[requestId] { finish(requestId, ticket: value.ticket, json: nil) }
        completion("{\"schemaVersion\":1,\"requestId\":\"\(requestId)\",\"cancelled\":true}", nil)
    }
    func cancelAll() {
        // Copy identities before callbacks can start another owner's request.
        let previous = pending.map { ($0.key, $0.value.ticket) }
        for (id, ticket) in previous { finish(id, ticket: ticket, json: nil) }
    }
    private func finish(_ id: String, ticket: UUID, json: String?) {
        guard let value = pending[id], value.ticket == ticket else { return }
        let accepted = epoch.accepts(id, ticket: ticket, foreground: foreground)
        epoch.cancel(id); pending.removeValue(forKey: id) // revoke before cancellation/callback
        value.task.cancel(); value.deadline.cancel()
        value.completion(accepted ? json : nil, accepted && json != nil ? nil : AssistWeatherAttributionPolicy.failure())
    }
}
#endif
