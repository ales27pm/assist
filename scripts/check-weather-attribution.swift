import Foundation

@main
struct WeatherAttributionChecks {
    static func main() throws {
        var checks = 0
        func expect(_ value: @autoclosure () throws -> Bool) throws {
            guard try value() else { throw AssistWeatherAttributionPolicy.failure() }; checks += 1
        }
        func rejects(_ action: () throws -> Void) throws {
            do { try action() } catch { checks += 1; return }; throw AssistWeatherAttributionPolicy.failure()
        }
        let url = "https://weatherkit.apple.com/assets/branding/en/Apple_Weather_blk_en_3X_090122.png"
        let dark = "https://weatherkit.apple.com/assets/branding/fr-CA/Apple_Weather_wht_fr-CA_3X_090122.png"
        try expect(try AssistWeatherAttributionPolicy.markURL(url, appearance: "light").absoluteString == url)
        try expect(try AssistWeatherAttributionPolicy.markURL(dark, appearance: "dark").absoluteString == dark)
        for raw in [url.replacingOccurrences(of: "https:", with: "http:"), url + "?token=secret", url + "#x",
                    url.replacingOccurrences(of: "weatherkit.apple.com", with: "weatherkit.apple.com.evil.test"),
                    url.replacingOccurrences(of: "weatherkit.apple.com", with: "127.0.0.1"),
                    url.replacingOccurrences(of: "weatherkit.apple.com", with: "user:secret@weatherkit.apple.com"),
                    url.replacingOccurrences(of: "weatherkit.apple.com", with: "weatherkit.apple.com:443"),
                    url.replacingOccurrences(of: ".png", with: ".svg"),
                    url.replacingOccurrences(of: "assets/branding/en", with: "api/v1/weather/en"),
                    url.replacingOccurrences(of: "Apple_Weather", with: "arbitrary"),
                    url.replacingOccurrences(of: "_blk_", with: "_wht_"),
                    url.replacingOccurrences(of: "/assets/", with: "/assets/%2e%2e/"),
                    url.replacingOccurrences(of: "_3X_", with: "_9X_")] {
            try rejects { _ = try AssistWeatherAttributionPolicy.markURL(raw, appearance: "light") }
        }
        let json = "{\"schemaVersion\":1,\"requestId\":\"mark-1\",\"markURL\":\"\(url)\",\"appearance\":\"light\"}"
        try expect(try AssistWeatherAttributionPolicy.request(json).requestId == "mark-1")
        for invalid in [json.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true"),
                        json.replacingOccurrences(of: "\"appearance\":", with: "\"html\":\"<svg/>\",\"appearance\":"),
                        json.replacingOccurrences(of: "\"appearance\":", with: "\"appearance\":\"light\",\"appearance\":"),
                        json.replacingOccurrences(of: "mark-1", with: "../secret"), String(repeating: " ", count: 2_049)] {
            try rejects { _ = try AssistWeatherAttributionPolicy.request(invalid) }
        }
        let endpoint = URL(string: url)!
        try AssistWeatherAttributionPolicy.headers(status: 200, mime: "image/png", length: 3_152, responseURL: endpoint, requestURL: endpoint); checks += 1
        for status in [301, 302, 307, 308, 401, 404, 429, 500] {
            try rejects { try AssistWeatherAttributionPolicy.headers(status: status, mime: "image/png", length: 3_152, responseURL: endpoint, requestURL: endpoint) }
        }
        try rejects { try AssistWeatherAttributionPolicy.headers(status: 200, mime: "image/svg+xml", length: 128, responseURL: endpoint, requestURL: endpoint) }
        try rejects { try AssistWeatherAttributionPolicy.headers(status: 200, mime: "image/png", length: 32 * 1_024 + 1, responseURL: endpoint, requestURL: endpoint) }
        try rejects { try AssistWeatherAttributionPolicy.headers(status: 200, mime: "image/png", length: -2, responseURL: endpoint, requestURL: endpoint) }
        try rejects { try AssistWeatherAttributionPolicy.headers(status: 200, mime: "image/png", length: 128, responseURL: URL(string: dark), requestURL: endpoint) }
        try AssistWeatherAttributionPolicy.dimensions(width: 231, height: 42); checks += 1
        for (width, height) in [(0, 42), (231, 0), (769, 42), (231, 129), (768, 128)] {
            try rejects { try AssistWeatherAttributionPolicy.dimensions(width: width, height: height) }
        }
        try rejects { try AssistWeatherAttributionPolicy.png(Data("<svg/>".utf8)) }
        try rejects { try AssistWeatherAttributionPolicy.png(Data(repeating: 0, count: 32 * 1_024 + 1)) }
        var epoch = AssistWeatherAttributionPolicy.Epoch()
        let first = try epoch.begin("a")
        try expect(epoch.accepts("a", ticket: first, foreground: true))
        try expect(!epoch.accepts("a", ticket: first, foreground: false))
        try rejects { _ = try epoch.begin("a") }
        let second = try epoch.begin("b")
        try rejects { _ = try epoch.begin("c") }
        epoch.cancel("a"); try expect(!epoch.accepts("a", ticket: first, foreground: true))
        try expect(epoch.accepts("b", ticket: second, foreground: true))
        let replacement = try epoch.begin("a")
        try expect(replacement != first && !epoch.accepts("a", ticket: first, foreground: true))
        epoch.cancelAll(); try expect(!epoch.accepts("a", ticket: replacement, foreground: true))
        print("PASS: \(checks) official weather attribution URL, PNG/header/pixel bounds and per-owner cancellation checks; no Apple account or weather request")
    }
}
