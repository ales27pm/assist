import Foundation

@main
struct ApplePlacesChecks {
    static func main() throws {
        var checks = 0
        func expect(_ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw AssistApplePlacesPolicy.failure(.invalid) }
            checks += 1
        }
        func rejects(_ action: () throws -> Void) throws {
            do { try action() } catch { checks += 1; return }
            throw AssistApplePlacesPolicy.failure(.invalid)
        }
        let search = #"{"schemaVersion":1,"requestId":"request-1","query":"  Québec  ","limit":5}"#
        try expect(try AssistApplePlacesPolicy.search(search).query == "Québec")
        try expect(try AssistApplePlacesPolicy.search(search).limit == 5)
        for text in [
            search.replacingOccurrences(of: "\"schemaVersion\":1", with: "\"schemaVersion\":true"),
            search.replacingOccurrences(of: "\"requestId\":\"request-1\"", with: "\"requestId\":\"../path\""),
            search.replacingOccurrences(of: "\"limit\":5", with: "\"limit\":0"),
            search.replacingOccurrences(of: "\"limit\":5", with: "\"limit\":11"),
            search.replacingOccurrences(of: "\"limit\":5", with: "\"limit\":1.5"),
            search.replacingOccurrences(of: "\"limit\":5", with: "\"limit\":true"),
            search.replacingOccurrences(of: "\"limit\":5", with: "\"limit\":5,\"limit\":5"),
            search.replacingOccurrences(of: "  Québec  ", with: " "),
            search.replacingOccurrences(of: "  Québec  ", with: String(repeating: "é", count: 129)),
            search.replacingOccurrences(of: "  Québec  ", with: "<|tool_call>"),
            search.replacingOccurrences(of: "\"query\":", with: "\"url\":\"https://apple.com\",\"query\":"),
            String(search.dropLast()),
        ] { try rejects { _ = try AssistApplePlacesPolicy.search(text) } }
        let coordinate = #"{"latitude":46.8139,"longitude":-71.2080}"#
        let route = #"{"schemaVersion":1,"requestId":"route-1","origin":COORD,"destination":COORD,"transport":"walking"}"#
            .replacingOccurrences(of: "COORD", with: coordinate)
        try expect(try AssistApplePlacesPolicy.directions(route).transport == "walking")
        try expect(try AssistApplePlacesPolicy.directions(route.replacingOccurrences(of: "walking", with: "automobile")).origin.latitude == 46.8139)
        for text in [route.replacingOccurrences(of: "walking", with: "transit"),
                     route.replacingOccurrences(of: coordinate, with: #"{"latitude":91,"longitude":-71}"#),
                     route.replacingOccurrences(of: coordinate, with: #"{"latitude":46,"longitude":-181}"#),
                     route.replacingOccurrences(of: coordinate, with: #"{"latitude":true,"longitude":-71}"#),
                     route.replacingOccurrences(of: coordinate, with: #"{"latitude":null,"longitude":-71}"#),
                     route.replacingOccurrences(of: coordinate, with: #"{"latitude":46,"longitude":-71,"gps":true}"#),
                     route.replacingOccurrences(of: coordinate, with: #"{"latitude":46,"longitude":1e999}"#)] {
            try rejects { _ = try AssistApplePlacesPolicy.directions(text) }
        }
        for (latitude, longitude) in [(-90.0, -180.0), (90.0, 180.0), (0.0, 0.0)] {
            try expect(try AssistApplePlacesPolicy.coordinate(.object(["latitude": .number(latitude), "longitude": .number(longitude)])).latitude == latitude)
        }
        for number in [Double.nan, Double.infinity, -Double.infinity] {
            try rejects { _ = try AssistApplePlacesPolicy.coordinate(.object(["latitude": .number(number), "longitude": .number(0)])) }
        }
        let weather = #"{"schemaVersion":1,"requestId":"forecast-1","coordinate":COORD,"unit":"celsius","hourlyCount":12,"dailyCount":5}"#
            .replacingOccurrences(of: "COORD", with: coordinate)
        let parsed = try AssistApplePlacesPolicy.forecast(weather)
        try expect(parsed.hourlyCount == 12 && parsed.dailyCount == 5 && parsed.unit == "celsius")
        try expect(try AssistApplePlacesPolicy.forecast(weather.replacingOccurrences(of: "celsius", with: "fahrenheit")).unit == "fahrenheit")
        try expect(try AssistApplePlacesPolicy.forecast(weather.replacingOccurrences(of: "\"hourlyCount\":12", with: "\"hourlyCount\":0")).hourlyCount == 0)
        for text in [weather.replacingOccurrences(of: "celsius", with: "kelvin"),
                     weather.replacingOccurrences(of: "\"hourlyCount\":12", with: "\"hourlyCount\":13"),
                     weather.replacingOccurrences(of: "\"hourlyCount\":12", with: "\"hourlyCount\":-1"),
                     weather.replacingOccurrences(of: "\"dailyCount\":5", with: "\"dailyCount\":6"),
                     weather.replacingOccurrences(of: "\"dailyCount\":5", with: "\"dailyCount\":false"),
                     weather.replacingOccurrences(of: "\"unit\":", with: "\"token\":\"secret\",\"unit\":"),
                     String(repeating: " ", count: 2_049)] {
            try rejects { _ = try AssistApplePlacesPolicy.forecast(text) }
        }
        try expect(try AssistApplePlacesPolicy.attributionURL(URL(string: "https://weatherkit.apple.com/legal-attribution.html")!).hasPrefix("https://"))
        for text in ["http://apple.com/legal", "https://user:pass@apple.com/legal", "https://apple.com:8443/legal", "https://apple.com/legal#fragment"] {
            try rejects { _ = try AssistApplePlacesPolicy.attributionURL(URL(string: text)!) }
        }
        let operationId = UUID()
        let searchCall = AssistDeviceToolCall(name: .maps_search, arguments: ["query": .string("Québec"), "limit": .number(1)])
        let searchPayload = try AssistApplePlacesPolicy.toolRequest(searchCall, operationId: operationId)
        try expect(try AssistApplePlacesPolicy.search(searchPayload).requestId == operationId.uuidString)
        let searchResult: [String: AssistToolValue] = ["schemaVersion": .number(1), "requestId": .string(operationId.uuidString),
            "provider": .string("Apple Maps"), "results": .array([]), "truncated": .bool(false), "untrusted": .bool(true)]
        let searchResultJSON = try AssistJSON.encode(AssistToolValue.object(searchResult))
        try expect(try AssistApplePlacesPolicy.toolResult(searchResultJSON, call: searchCall, operationId: operationId) == .object(searchResult))
        for patch in [["provider": AssistToolValue.string("Other")], ["requestId": .string("another")], ["untrusted": .bool(false)], ["extra": .bool(true)]] {
            let row = searchResult.merging(patch) { _, new in new }
            try rejects { _ = try AssistApplePlacesPolicy.toolResult(AssistJSON.encode(AssistToolValue.object(row)), call: searchCall, operationId: operationId) }
        }
        let routeCall = AssistDeviceToolCall(name: .maps_directions, arguments: ["origin_latitude": .number(46.8139), "origin_longitude": .number(-71.208),
            "destination_latitude": .number(46.8), "destination_longitude": .number(-71.3), "transport": .string("walking")])
        var routeResult = try AssistToolValue.decodeJSON(AssistApplePlacesPolicy.toolRequest(routeCall, operationId: operationId)).objectDictionary!
        routeResult.merge(["provider": .string("Apple Maps"), "distanceMeters": .number(2), "expectedTravelSeconds": .number(3),
            "name": .string("Fixture"), "calculatedAt": .string("2026-10-19T12:00:00Z"), "estimateOnly": .bool(true), "navigationStarted": .bool(false)]) { _, new in new }
        _ = try AssistApplePlacesPolicy.toolResult(AssistJSON.encode(AssistToolValue.object(routeResult)), call: routeCall, operationId: operationId)
        checks += 1
        for patch in [["navigationStarted": AssistToolValue.bool(true)], ["distanceMeters": .number(-1)],
                      ["origin": .object(["latitude": .number(1), "longitude": .number(2)])]] {
            let row = routeResult.merging(patch) { _, new in new }
            try rejects { _ = try AssistApplePlacesPolicy.toolResult(AssistJSON.encode(AssistToolValue.object(row)), call: routeCall, operationId: operationId) }
        }
        var epoch = AssistApplePlacesPolicy.Epoch()
        let first = epoch.begin()
        try expect(epoch.accepts(first, foreground: true))
        try expect(!epoch.accepts(first, foreground: false))
        epoch.cancel(); try expect(!epoch.accepts(first, foreground: true))
        let second = epoch.begin()
        try expect(!epoch.accepts(first, foreground: true) && epoch.accepts(second, foreground: true))
        let now = Date(timeIntervalSince1970: 1_000)
        let scope = AssistApplePlacesPolicy.ResultScope(requestId: "r1", createdAt: now, ids: ["p1"])
        try expect(scope.accepts(requestId: "r1", resultId: "p1", now: now, foreground: true))
        try expect(scope.accepts(requestId: "r1", resultId: "p1", now: now.addingTimeInterval(600), foreground: true))
        try expect(!scope.accepts(requestId: "r1", resultId: "p1", now: now.addingTimeInterval(601), foreground: true))
        try expect(!scope.accepts(requestId: "r1", resultId: "p1", now: now.addingTimeInterval(-1), foreground: true))
        try expect(!scope.accepts(requestId: "r2", resultId: "p1", now: now, foreground: true))
        try expect(!scope.accepts(requestId: "r1", resultId: "p2", now: now, foreground: true))
        try expect(!scope.accepts(requestId: "r1", resultId: "p1", now: now, foreground: false))
        try expect(AssistApplePlacesPolicy.boundedText("ééé", maximumBytes: 5) == "éé")
        try expect(try AssistApplePlacesPolicy.response(["ok": .bool(true)]).contains("true"))
        try rejects { _ = try AssistApplePlacesPolicy.response(["text": .string("<|tool_response>")]) }
        try rejects { _ = try AssistApplePlacesPolicy.response(["value": .number(.nan)]) }
        print("PASS: \(checks) Apple places coordinate/schema, forecast bounds, attribution, cancellation and stale-result checks; no Apple network or location access")
    }
}
