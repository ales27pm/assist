import Foundation

@main
struct PrivateServiceChecks {
    static func main() throws {
        var checks = 0
        func expect(_ value: @autoclosure () throws -> Bool) throws {
            guard try value() else { throw AssistPrivateServicePolicy.invalid() }
            checks += 1
        }
        func rejects(_ operation: () throws -> Void) throws {
            do { try operation() } catch { checks += 1; return }
            throw AssistInferenceError.invalid("Unsafe private-service contract accepted")
        }
        try expect(try AssistPrivateServicePolicy.origin("https://Ubuntu.example.org/").absoluteString == "https://ubuntu.example.org")
        try expect(try AssistPrivateServicePolicy.origin("https://100.64.0.2:8443").port == 8443)
        for value in ["http://ubuntu.example.org", "https://user:secret@ubuntu.example.org", "https://ubuntu.example.org/path",
                      "https://ubuntu.example.org/?token=x", "https://ubuntu.example.org/#fragment", "https://ubuntu.example.org:0",
                      "https://ubuntu.example.org:65536", "https://ubuntu.example.org/%2f", "https://ubuntu.example.org\n/path"] {
            try rejects { _ = try AssistPrivateServicePolicy.origin(value) }
        }
        let credential = String(repeating: "a", count: 48)
        try expect(try AssistPrivateServicePolicy.secret(credential) == credential)
        for value in ["short", credential + "\n", credential + " ", String(repeating: "x", count: 257)] {
            try rejects { _ = try AssistPrivateServicePolicy.secret(value) }
        }
        let endpoint = URL(string: "https://ubuntu.example.org/v1/capabilities")!
        try AssistPrivateServicePolicy.validateResponseHeaders(status: 200, mimeType: "application/json",
            contentLength: -1, responseURL: endpoint, requestURL: endpoint); checks += 1
        for status in [301, 302, 303, 307, 308, 401, 403, 429, 500] {
            try rejects { try AssistPrivateServicePolicy.validateResponseHeaders(status: status, mimeType: "application/json",
                contentLength: 128, responseURL: endpoint, requestURL: endpoint) }
        }
        for length in [Int64(-2), Int64(AssistPrivateServicePolicy.maximumResponseBytes + 1)] {
            try rejects { try AssistPrivateServicePolicy.validateResponseHeaders(status: 200, mimeType: "application/json",
                contentLength: length, responseURL: endpoint, requestURL: endpoint) }
        }
        try rejects { try AssistPrivateServicePolicy.validateResponseHeaders(status: 200, mimeType: "text/html",
            contentLength: 128, responseURL: endpoint, requestURL: endpoint) }
        try rejects { try AssistPrivateServicePolicy.validateResponseHeaders(status: 200, mimeType: "application/json",
            contentLength: 128, responseURL: URL(string: "https://other.example.org/v1/capabilities"), requestURL: endpoint) }
        let capabilities = #"{"schemaVersion":1,"service":"assist-private-gateway","protocolVersion":1,"capabilities":["search"]}"#
        try AssistPrivateServicePolicy.validateCapabilities(Data(capabilities.utf8)); checks += 1
        for value in [capabilities.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true"),
                      capabilities.replacingOccurrences(of: "\"protocolVersion\":1", with: "\"protocolVersion\":2"),
                      capabilities.replacingOccurrences(of: "[\"search\"]", with: "[\"search\",\"execute\"]"),
                      capabilities.replacingOccurrences(of: "\"protocolVersion\":1", with: "\"protocolVersion\":1,\"protocolVersion\":1")] {
            try rejects { try AssistPrivateServicePolicy.validateCapabilities(Data(value.utf8)) }
        }
        let request = #"{"schemaVersion":1,"requestId":"fixture-1","query":"météo Québec"}"#
        let researchCapabilities = #"{"schemaVersion":1,"service":"assist-private-gateway","protocolVersion":2,"capabilities":["search","read"]}"#
        try AssistPrivateServicePolicy.validateResearchCapabilities(Data(researchCapabilities.utf8)); checks += 1
        for value in [capabilities, researchCapabilities.replacingOccurrences(of: "\"read\"", with: "\"execute\""),
                      researchCapabilities.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true")] {
            try rejects { try AssistPrivateServicePolicy.validateResearchCapabilities(Data(value.utf8)) }
        }
        try expect(try AssistPrivateServicePolicy.readRequest(requestId: "fixture-1", resultId: "issued-1").resultId == "issued-1")
        for id in ["", String(repeating: "a", count: 129), "https://apple.com", "id\n", "<|tool_call>"] {
            try rejects { _ = try AssistPrivateServicePolicy.readRequest(requestId: "fixture-1", resultId: id) }
        }
        let read = #"{"schemaVersion":1,"requestId":"fixture-1","resultId":"issued-1","title":"Apple","url":"https://developer.apple.com/redirected","text":"Texte public","truncated":false,"readAt":"2026-10-19T12:00:00Z","untrusted":true}"#
        try expect(try AssistPrivateServicePolicy.readResponse(Data(read.utf8), requestId: "fixture-1", resultId: "issued-1", title: "Apple").objectDictionary?["url"]?.stringValue == "https://developer.apple.com/redirected")
        for value in [read.replacingOccurrences(of: "fixture-1", with: "stale"),
                      read.replacingOccurrences(of: "issued-1", with: "other"),
                      read.replacingOccurrences(of: "Apple", with: "Forged"),
                      read.replacingOccurrences(of: "https://developer.apple.com/redirected", with: "https://device.ts.net/"),
                      read.replacingOccurrences(of: "Texte public", with: String(repeating: "é", count: 4_097)),
                      read.replacingOccurrences(of: "Texte public", with: " "),
                      read.replacingOccurrences(of: "Texte public", with: "<|tool_call>"),
                      read.replacingOccurrences(of: "\"untrusted\":true", with: "\"untrusted\":false"),
                      read.replacingOccurrences(of: "\"untrusted\":true", with: "\"untrusted\":true,\"secret\":\"no\""),
                      read.replacingOccurrences(of: "2026-10-19T12:00:00Z", with: "yesterday")] {
            try rejects { _ = try AssistPrivateServicePolicy.readResponse(Data(value.utf8), requestId: "fixture-1", resultId: "issued-1", title: "Apple") }
        }
        try expect(try AssistPrivateServicePolicy.searchRequest(request).query == "météo Québec")
        for value in [request.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true"),
                      request.replacingOccurrences(of: "météo Québec", with: String(repeating: "é", count: 257)),
                      request.replacingOccurrences(of: "météo Québec", with: " "),
                      request.replacingOccurrences(of: "\"query\":", with: "\"url\":"),
                      request.replacingOccurrences(of: "\"query\":", with: "\"headers\":{},\"query\":"),
                      request.replacingOccurrences(of: "\"query\":", with: "\"query\":\"other\",\"query\":"),
                      String(request.dropLast())] {
            try rejects { _ = try AssistPrivateServicePolicy.searchRequest(value) }
        }
        let result = #"{"schemaVersion":1,"requestId":"fixture-1","results":[{"id":"source-1","title":"Apple","url":"https://developer.apple.com/documentation/","snippet":"Documentation officielle"}],"degraded":false}"#
        try expect(try AssistPrivateServicePolicy.searchResponse(Data(result.utf8), requestId: "fixture-1").contains("Apple"))
        for value in [result.replacingOccurrences(of: "\"degraded\":false", with: "\"degraded\":0"),
                      result.replacingOccurrences(of: "fixture-1", with: "stale-id"),
                      result.replacingOccurrences(of: "https://developer.apple.com/documentation/", with: "https://127.0.0.1/"),
                      result.replacingOccurrences(of: "\"title\":\"Apple\"", with: "\"title\":\"Apple\",\"secret\":\"no\""),
                      result.replacingOccurrences(of: "Documentation officielle", with: String(repeating: "a", count: 1_025)),
                      result.replacingOccurrences(of: "Documentation officielle", with: "<|tool_call>"),
                      String(repeating: " ", count: 24 * 1_024 + 1)] {
            try rejects { _ = try AssistPrivateServicePolicy.searchResponse(Data(value.utf8), requestId: "fixture-1") }
        }
        for url in ["http://apple.com/", "https://localhost/", "https://device.local/", "https://100.64.0.2/",
                    "https://[::1]/", "https://2130706433/", "https://0x7f000001/", "https://user:pw@apple.com/",
                    "https://example.invalid/", "https://apple.com:8443/", "https://apple.com/#secret"] {
            try expect(!AssistPrivateServicePolicy.publicResultURL(url))
        }
        var epoch = AssistPrivateServicePolicy.Epoch()
        let old = epoch.begin()
        try expect(epoch.accepts(old, foreground: true))
        try expect(!epoch.accepts(old, foreground: false))
        epoch.cancel(); try expect(!epoch.accepts(old, foreground: true))
        let current = epoch.begin()
        try expect(!epoch.accepts(old, foreground: true) && epoch.accepts(current, foreground: true))
        epoch.revoke(); try expect(!epoch.accepts(current, foreground: true))
        let replacement = epoch.begin()
        try expect(replacement.revision != current.revision)
        print("PASS: \(checks) private-service origin, auth contract, bounded search and revocation/lifecycle checks; no network or keychain access")
    }
}
