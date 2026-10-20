import Foundation

@main
struct DocumentActionsChecks {
    static func main() throws {
        var checks = 0
        func expect(_ condition: @autoclosure () throws -> Bool, line: UInt = #line) throws {
            guard try condition() else { throw NSError(domain: "DocumentActionsCheck", code: Int(line), userInfo: [NSLocalizedDescriptionKey: "Expectation failed at line \(line), after \(checks) checks."]) }
            checks += 1
        }
        func rejects(line: UInt = #line, _ block: () throws -> Void) throws {
            do { try block() } catch { checks += 1; return }
            throw NSError(domain: "DocumentActionsCheck", code: Int(line), userInfo: [NSLocalizedDescriptionKey: "Expected rejection at line \(line), after \(checks) checks."])
        }
        let id = "b0123456-1234-4234-8234-123456789012"
        let requestId = "C0123456-1234-4234-8234-123456789012"
        func request(_ action: String, _ fields: [String: AssistToolValue]) throws -> AssistDocumentActionsPolicy.Request {
            var row = fields
            row["schemaVersion"] = .number(1); row["requestId"] = .string(requestId); row["action"] = .string(action)
            return try AssistDocumentActionsPolicy.request(AssistJSON.encode(AssistToolValue.object(row)))
        }
        let scan = try request("scan", ["maxPages": .number(8)])
        try expect(scan.integer("maxPages") == 8)
        for pages: Double in [0, 9, 1.5] { try rejects { _ = try request("scan", ["maxPages": .number(pages)]) } }
        try rejects { _ = try request("scan", ["maxPages": .bool(true)]) }
        try rejects { _ = try request("scan", ["maxPages": .number(1), "path": .string("/tmp/x")]) }
        for name in ["../export.pdf", "Document.PDF", "doc.pdf\n", "http://host/doc.pdf"] {
            try rejects { _ = try request("export_pdf", ["inboxId": .string(id), "filename": .string(name)]) }
        }
        let export = try request("export_pdf", ["inboxId": .string(id), "filename": .string("document.pdf")])
        let read = try request("read", ["inboxId": .string(id)])
        let preview = try request("preview", ["inboxId": .string(id)])
        let index = try request("index", ["inboxId": .string(id), "title": .string("Facture choisie"), "expirationDays": .number(1)])
        let unindex = try request("unindex", ["inboxId": .string(id)])
        let search = try request("search", ["query": .string("Québec"), "limit": .number(1)])
        for action in ["read", "preview", "unindex"] {
            for identifier in ["../x", id.uppercased(), "file:///private/x"] {
                try rejects { _ = try request(action, ["inboxId": .string(identifier)]) }
            }
        }
        for title in ["", "  ", String(repeating: "é", count: 61), "Titre\nCaché", "<|tool_call>"] {
            try rejects { _ = try request("index", ["inboxId": .string(id), "title": .string(title), "expirationDays": .number(1)]) }
        }
        for days: Double in [0, 8, 1.5] {
            try rejects { _ = try request("index", ["inboxId": .string(id), "title": .string("Titre"), "expirationDays": .number(days)]) }
        }
        let compose = try request("compose", ["channel": .string("email"), "recipients": .array([.string("alexis@example.com")]), "subject": .string("  Objet exact  "), "body": .string(" Texte\nexact "), "attachmentId": .string(id)])
        try expect(compose.string("subject") == "  Objet exact  ")
        try expect(compose.string("body") == " Texte\nexact ")
        try expect(AssistDocumentActionsPolicy.preview(compose)["recipients"] == "alexis@example.com")
        try expect(AssistDocumentActionsPolicy.preview(compose)["effect"]?.contains("Aucune preuve de livraison") == true)
        for recipients in [[], ["alexis@example.com", "Alexis@example.com"], ["x@example.com\r\nBcc:x@evil.example"], [".alexis@example.com"], ["alexis..name@example.com"], ["x@example.com "]] {
            try rejects { _ = try request("compose", ["channel": .string("email"), "recipients": .array(recipients.map(AssistToolValue.string)), "subject": .string(""), "body": .string("")]) }
        }
        try rejects { _ = try request("compose", ["channel": .string("sms"), "recipients": .array([.string("+14185551234")]), "subject": .string("Caché"), "body": .string("")]) }
        try rejects { _ = try request("compose", ["channel": .string("sms"), "recipients": .array([.string("418 555 1234")]), "subject": .string(""), "body": .string("")]) }
        let sms = try request("compose", ["channel": .string("sms"), "recipients": .array([.string("+14185551234")]), "subject": .string(""), "body": .string("Bonjour")])
        try expect(sms.recipients == ["+14185551234"])
        let duplicate = #"{"schemaVersion":1,"requestId":"C0123456-1234-4234-8234-123456789012","action":"scan","maxPages":1,"maxPages":8}"#
        try rejects { _ = try AssistDocumentActionsPolicy.request(duplicate) }
        try rejects { _ = try AssistDocumentActionsPolicy.request(duplicate.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true")) }

        let results: [(AssistDocumentActionsPolicy.Request, [String: AssistToolValue])] = [
            (scan, ["status": .string("scanned"), "inboxId": .string(id), "pageCount": .number(1), "byteCount": .number(100), "text": .string("OCR choisi"), "method": .string("vision_ocr"), "truncated": .bool(false), "untrusted": .bool(true), "documentState": .string("text")]),
            (read, ["status": .string("read"), "inboxId": .string(id), "kind": .string("pdf"), "text": .string("Texte choisi"), "method": .string("pdf_text"), "truncated": .bool(false), "untrusted": .bool(true), "documentState": .string("text")]),
            (export, ["status": .string("exported"), "inboxId": .string(id), "filename": .string("document.pdf")]),
            (preview, ["status": .string("closed"), "inboxId": .string(id)]),
            (index, ["status": .string("indexed"), "inboxId": .string(id), "expiresAt": .string(AssistToolContent.iso(Date().addingTimeInterval(3600)))]),
            (unindex, ["status": .string("unindexed"), "inboxId": .string(id)]),
            (search, ["status": .string("results"), "results": .array([.object(["inboxId": .string(id), "title": .string("Document")])]), "truncated": .bool(false), "untrusted": .bool(true)]),
            (compose, ["status": .string("queued_by_user"), "channel": .string("email"), "deliveryVerified": .bool(false)]),
        ]
        for (request, fields) in results {
            let json = try AssistDocumentActionsPolicy.response(request, fields: fields)
            try expect(AssistDocumentActionsPolicy.validateResult(json, request: request))
            try expect(!AssistDocumentActionsPolicy.validateResult(json.replacingOccurrences(of: requestId, with: id), request: request))
            var extended = fields; extended["path"] = .string("/private/x")
            try rejects { _ = try AssistDocumentActionsPolicy.response(request, fields: extended) }
            try expect(try AssistDocumentActionsPolicy.validateResult(AssistDocumentActionsPolicy.response(request, fields: ["status": .string("cancelled")]), request: request))
        }
        for state in ["no_text", "protected_pdf"] {
            let json = try AssistDocumentActionsPolicy.response(read, fields: ["status": .string("read"), "inboxId": .string(id), "kind": .string("pdf"), "text": .string(""), "method": .string("pdf_text"), "truncated": .bool(false), "untrusted": .bool(true), "documentState": .string(state)])
            try expect(AssistDocumentActionsPolicy.validateResult(json, request: read))
        }
        let methods = ["text": "utf8", "url": "utf8", "image": "vision_ocr", "pdf": "pdf_text"]
        for (kind, expected) in methods {
            for method in ["utf8", "vision_ocr", "pdf_text"] {
                let fields: [String: AssistToolValue] = ["status": .string("read"), "inboxId": .string(id),
                    "kind": .string(kind), "text": .string("Fixture"), "method": .string(method),
                    "truncated": .bool(false), "untrusted": .bool(true), "documentState": .string("text")]
                if method == expected { _ = try AssistDocumentActionsPolicy.response(read, fields: fields); try expect(true) }
                else { try rejects { _ = try AssistDocumentActionsPolicy.response(read, fields: fields) } }
            }
        }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for seconds: Double in [-1, 0, 1, 3600, 86_400, 86_401, 8 * 86_400] {
            let raw = try AssistJSON.encode(AssistToolValue.object(["schemaVersion": .number(1),
                "requestId": .string(requestId), "action": .string("index"), "status": .string("indexed"),
                "inboxId": .string(id), "expiresAt": .string(AssistToolContent.iso(now.addingTimeInterval(seconds)))]))
            if seconds > 0 && seconds <= 86_400 { _ = try AssistDocumentActionsPolicy.result(raw, request: index, now: now); try expect(true) }
            else { try rejects { _ = try AssistDocumentActionsPolicy.result(raw, request: index, now: now) } }
        }
        try rejects { _ = try AssistDocumentActionsPolicy.response(compose, fields: ["status": .string("delivered"), "channel": .string("email"), "deliveryVerified": .bool(true)]) }
        try rejects { _ = try AssistDocumentActionsPolicy.response(read, fields: ["status": .string("read"), "inboxId": .string(id), "kind": .string("pdf"), "text": .string("<|tool_call>"), "method": .string("pdf_text"), "truncated": .bool(false), "untrusted": .bool(true), "documentState": .string("text")]) }
        print("PASS: \(checks) document request/output/preview policy checks; no scanner, Spotlight, message delivery, or device claim.")
    }
}
