import Foundation
import CoreLocation
import MapKit
import UIKit
import WeatherKit

/// Foreground, user-invoked readers. MainActor owns the MapKit objects, result
/// handles and completion lifetime; no model or caller supplies executable URLs.
@MainActor
final class AssistApplePlaces {
    static let shared = AssistApplePlaces()
    typealias Completion = (Result<String, Error>) -> Void
    private var epoch = AssistApplePlacesPolicy.Epoch()
    private var completion: Completion?
    private var task: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var search: MKLocalSearch?
    private var route: MKDirections?
    private var resultScope: AssistApplePlacesPolicy.ResultScope?
    private var results: [String: MKMapItem] = [:]

    private init() {}

    func statusJSON() throws -> String {
        try AssistApplePlacesPolicy.response([
            "schemaVersion": .number(1), "maps": .string("available"),
            "weather": .string("requires_signed_weatherkit_entitlement"),
            "weatherDeviceVerified": .bool(false), "locationMode": .string("explicit_text_or_coordinates"),
        ])
    }

    func searchPlaces(_ requestJSON: String, completion: @escaping Completion) {
        do {
            let query = try AssistApplePlacesPolicy.search(requestJSON)
            let id = try begin(completion)
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = query.query
            request.resultTypes = [.address, .pointOfInterest]
            let operation = MKLocalSearch(request: request)
            search = operation
            task = Task { @MainActor in
                guard self.accepts(id) else { self.finishCancelled(id); return }
                do {
                    let response = try await operation.start()
                    guard self.accepts(id) else { self.finishCancelled(id); return }
                    var rows: [AssistToolValue] = []
                    var accepted: [String: MKMapItem] = [:]
                    for item in response.mapItems.prefix(query.limit) {
                        let coordinate = item.location.coordinate
                        let value = AssistToolValue.object([
                            "latitude": .number(coordinate.latitude), "longitude": .number(coordinate.longitude),
                        ])
                        _ = try AssistApplePlacesPolicy.coordinate(value)
                        let resultId = UUID().uuidString
                        let name = AssistApplePlacesPolicy.boundedText(item.name ?? "", maximumBytes: 256)
                        let address = AssistApplePlacesPolicy.boundedText(
                            item.addressRepresentations?.fullAddress(includingRegion: true, singleLine: true) ?? "",
                            maximumBytes: 512)
                        rows.append(.object(["id": .string(resultId), "name": .string(name),
                                             "address": .string(address), "coordinate": value]))
                        accepted[resultId] = item
                    }
                    let json = try AssistApplePlacesPolicy.response([
                        "schemaVersion": .number(1), "requestId": .string(query.requestId), "provider": .string("Apple Maps"),
                        "results": .array(rows), "truncated": .bool(response.mapItems.count > query.limit),
                        "untrusted": .bool(true),
                    ])
                    self.results = accepted
                    self.resultScope = .init(requestId: query.requestId, createdAt: Date(), ids: Set(accepted.keys))
                    self.finish(id, .success(json))
                } catch { self.finish(id, .failure(Self.safe(error))) }
            }
        } catch { completion(.failure(Self.safe(error))) }
    }

    func directions(_ requestJSON: String, completion: @escaping Completion) {
        do {
            let query = try AssistApplePlacesPolicy.directions(requestJSON)
            let id = try begin(completion)
            let request = MKDirections.Request()
            request.source = Self.mapItem(query.origin)
            request.destination = Self.mapItem(query.destination)
            request.transportType = query.transport == "walking" ? .walking : .automobile
            request.requestsAlternateRoutes = false
            let operation = MKDirections(request: request)
            route = operation
            task = Task { @MainActor in
                guard self.accepts(id) else { self.finishCancelled(id); return }
                do {
                    let response = try await operation.calculate()
                    guard self.accepts(id) else { self.finishCancelled(id); return }
                    guard let first = response.routes.first, first.distance.isFinite,
                          first.distance >= 0, first.expectedTravelTime.isFinite,
                          first.expectedTravelTime >= 0 else { throw AssistApplePlacesPolicy.failure(.unavailable) }
                    let json = try AssistApplePlacesPolicy.response([
                        "schemaVersion": .number(1), "requestId": .string(query.requestId), "provider": .string("Apple Maps"),
                        "origin": query.origin.value, "destination": query.destination.value,
                        "transport": .string(query.transport), "distanceMeters": .number(first.distance),
                        "expectedTravelSeconds": .number(first.expectedTravelTime),
                        "name": .string(AssistApplePlacesPolicy.boundedText(first.name, maximumBytes: 256)),
                        "calculatedAt": .string(Self.timestamp(Date())), "estimateOnly": .bool(true),
                        "navigationStarted": .bool(false),
                    ])
                    self.finish(id, .success(json))
                } catch { self.finish(id, .failure(Self.safe(error))) }
            }
        } catch { completion(.failure(Self.safe(error))) }
    }

    func forecast(_ requestJSON: String, completion: @escaping Completion) {
        do {
            let query = try AssistApplePlacesPolicy.forecast(requestJSON)
            let id = try begin(completion)
            task = Task { @MainActor in
                guard self.accepts(id) else { self.finishCancelled(id); return }
                do {
                    let json = try await Self.loadForecast(query)
                    self.finish(id, .success(json))
                } catch { self.finish(id, .failure(Self.safe(error))) }
            }
        } catch { completion(.failure(Self.safe(error))) }
    }

    /// Explicit user gesture only. Retained results are native-only, expire in
    /// ten minutes and are discarded on any new operation or cancellation.
    func openPlace(_ requestId: String, resultId: String, completion: @escaping Completion) {
        guard self.completion == nil else { completion(.failure(AssistApplePlacesPolicy.failure(.busy))); return }
        guard resultScope?.accepts(requestId: requestId, resultId: resultId, now: Date(), foreground: foreground) == true,
              let item = results[resultId] else {
            completion(.failure(AssistApplePlacesPolicy.failure(.invalid))); return
        }
        // This synchronous API reports Maps accepting the request, not arrival,
        // route completion or the destination having been visited.
        let accepted = item.openInMaps(launchOptions: nil)
        do { completion(.success(try AssistApplePlacesPolicy.response([
            "schemaVersion": .number(1), "opened": .bool(accepted), "navigationStarted": .bool(false),
        ]))) } catch { completion(.failure(Self.safe(error))) }
    }

    func cancel() {
        epoch.cancel() // revoke before cancellation can produce callbacks
        let callback = completion
        completion = nil
        deadline?.cancel(); deadline = nil
        task?.cancel(); task = nil
        search?.cancel(); search = nil
        route?.cancel(); route = nil
        clearResults()
        callback?(.failure(AssistApplePlacesPolicy.failure(.cancelled)))
    }

    private var foreground: Bool { UIApplication.shared.applicationState == .active }
    private func accepts(_ id: UUID) -> Bool { epoch.accepts(id, foreground: foreground) }
    private func begin(_ completion: @escaping Completion) throws -> UUID {
        guard foreground else { throw AssistApplePlacesPolicy.failure(.cancelled) }
        guard self.completion == nil else { throw AssistApplePlacesPolicy.failure(.busy) }
        clearResults()
        self.completion = completion
        let id = epoch.begin()
        deadline = Task { @concurrent [weak self] in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            guard !Task.isCancelled else { return }
            await self?.expire(id)
        }
        return id
    }
    private func finishCancelled(_ id: UUID) { finish(id, .failure(AssistApplePlacesPolicy.failure(.cancelled))) }
    private func finish(_ id: UUID, _ result: Result<String, Error>) {
        guard epoch.active == id else { return }
        let permitted = accepts(id)
        let callback = completion
        completion = nil; task = nil; search = nil; route = nil; epoch.cancel()
        deadline?.cancel(); deadline = nil
        if !permitted { clearResults() }
        callback?(permitted ? result : .failure(AssistApplePlacesPolicy.failure(.cancelled)))
    }
    private func clearResults() { results.removeAll(); resultScope = nil }
    private func expire(_ id: UUID) {
        guard epoch.active == id else { return }
        let pendingTask = task
        let pendingSearch = search
        let pendingRoute = route
        // finish revokes the epoch before cancelling framework requests. Locals
        // hold the old requests even if the callback immediately starts a new one.
        finish(id, .failure(AssistApplePlacesPolicy.failure(.unavailable)))
        pendingTask?.cancel(); pendingSearch?.cancel(); pendingRoute?.cancel()
    }
    private static func mapItem(_ coordinate: AssistApplePlacesPolicy.Coordinate) -> MKMapItem {
        MKMapItem(location: CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude), address: nil)
    }

    /// Weather data and JSON projection run outside the UI actor. Only immutable
    /// validated values cross back; no WeatherKit object enters bridge storage.
    @concurrent
    private static func loadForecast(_ query: AssistApplePlacesPolicy.Forecast) async throws -> String {
        let service = WeatherService.shared
        let location = CLLocation(latitude: query.coordinate.latitude, longitude: query.coordinate.longitude)
        let now = Date()
        async let current = service.weather(for: location, including: .current)
        async let hourly = hours(service, location: location, now: now, count: query.hourlyCount)
        async let daily = days(service, location: location, now: now, count: query.dailyCount)
        async let attribution = weatherAttribution(service)
        let (condition, hourValues, dayValues, credit) = try await (current, hourly, daily, attribution)
        try Task.checkCancellation()
        let unit: UnitTemperature = query.unit == "celsius" ? .celsius : .fahrenheit
        func temperature(_ value: Measurement<UnitTemperature>) -> AssistToolValue { .number(value.converted(to: unit).value) }
        let provider = credit.serviceName
        guard !provider.isEmpty, provider.utf8.count <= 256,
              !credit.legalAttributionText.isEmpty, credit.legalAttributionText.utf8.count <= 4_096 else {
            throw AssistApplePlacesPolicy.failure(.attributionUnavailable)
        }
        let creditValue: AssistToolValue
        do {
            creditValue = .object([
                "serviceName": .string(provider),
                "legalPageURL": .string(try AssistApplePlacesPolicy.attributionURL(credit.legalPageURL)),
                "combinedMarkLightURL": .string(try AssistApplePlacesPolicy.attributionURL(credit.combinedMarkLightURL)),
                "combinedMarkDarkURL": .string(try AssistApplePlacesPolicy.attributionURL(credit.combinedMarkDarkURL)),
                // Legal copy is never truncated into an incomplete attribution.
                "legalAttributionText": .string(credit.legalAttributionText),
            ])
        } catch { throw AssistApplePlacesPolicy.failure(.attributionUnavailable) }
        return try AssistApplePlacesPolicy.response([
            "schemaVersion": .number(1), "requestId": .string(query.requestId), "coordinate": query.coordinate.value,
            "temperatureUnit": .string(query.unit), "retrievedAt": .string(timestamp(now)), "attribution": creditValue,
            "current": .object([
                "date": .string(timestamp(condition.date)), "condition": .string(condition.condition.rawValue),
                "symbolName": .string(condition.symbolName), "temperature": temperature(condition.temperature),
                "apparentTemperature": temperature(condition.apparentTemperature), "humidity": .number(condition.humidity),
                "windKilometersPerHour": .number(condition.wind.speed.converted(to: .kilometersPerHour).value),
            ]),
            "hourly": .array(hourValues.prefix(query.hourlyCount).map { value in
                .object(["date": .string(timestamp(value.date)), "condition": .string(value.condition.rawValue),
                         "temperature": temperature(value.temperature), "precipitationChance": .number(value.precipitationChance)])
            }),
            "daily": .array(dayValues.prefix(query.dailyCount).map { value in
                .object(["date": .string(timestamp(value.date)), "condition": .string(value.condition.rawValue),
                         "highTemperature": temperature(value.highTemperature), "lowTemperature": temperature(value.lowTemperature),
                         "precipitationChance": .number(value.precipitationChance)])
            }),
            "forecastNotGuarantee": .bool(true),
        ])
    }

    @concurrent
    private static func weatherAttribution(_ service: WeatherService) async throws -> WeatherAttribution {
        do { return try await service.attribution }
        catch {
            let classified = safe(error)
            // Keep actual permission/network/cancellation failures distinct from
            // an attribution-only failure. No raw service error crosses the bridge.
            if classified.domain == "Assist.ApplePlaces", classified.code != AssistApplePlacesPolicy.Failure.unavailable.rawValue {
                throw classified
            }
            throw AssistApplePlacesPolicy.failure(.attributionUnavailable)
        }
    }
    @concurrent
    private static func hours(_ service: WeatherService, location: CLLocation, now: Date, count: Int) async throws -> [HourWeather] {
        guard count > 0 else { return [] }
        let forecast = try await service.weather(for: location, including: .hourly(startDate: now, endDate: now.addingTimeInterval(Double(count) * 3_600)))
        // WeatherKit may include a surrounding hour; never expose an older hour.
        return Array(forecast.filter { $0.date >= now }.prefix(count))
    }
    @concurrent
    private static func days(_ service: WeatherService, location: CLLocation, now: Date, count: Int) async throws -> [DayWeather] {
        guard count > 0 else { return [] }
        let forecast = try await service.weather(for: location, including: .daily(startDate: now, endDate: now.addingTimeInterval(Double(count) * 86_400)))
        return Array(forecast.prefix(count))
    }
    nonisolated private static func timestamp(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
    nonisolated private static func safe(_ error: Error) -> NSError {
        let value = error as NSError
        if value.domain == "Assist.ApplePlaces" { return value }
        if error is CancellationError { return AssistApplePlacesPolicy.failure(.cancelled) }
        if let error = error as? WeatherError, error == .permissionDenied {
            return AssistApplePlacesPolicy.failure(.weatherAuthorization)
        }
        if value.domain == NSURLErrorDomain { return AssistApplePlacesPolicy.failure(.network) }
        return AssistApplePlacesPolicy.failure(.unavailable)
    }
}
