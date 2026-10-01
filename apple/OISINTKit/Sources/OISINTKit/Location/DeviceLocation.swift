import CoreLocation
import Foundation

public struct GeographicCoordinate: Sendable, Equatable {
    public let latitude: Double
    public let longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

public enum CurrentLocationError: Error, Sendable, Equatable {
    case denied
    case restricted
    case servicesDisabled
    case timedOut
    case unavailable
}

public enum LocationNameError: Error, Sendable, Equatable {
    case timedOut
    case unavailable
}

public enum LocationRequestState: Sendable, Equatable {
    case idle
    case requesting
    case selected
    case denied
    case restricted
    case servicesDisabled
    case timedOut
    case unavailable
}

public struct LocationSelection: Sendable, Equatable {
    public enum Source: Sendable, Equatable {
        case current
        case manual
    }

    public let label: String
    public let source: Source

    public init(label: String, source: Source) {
        self.label = label
        self.source = source
    }
}

@MainActor
public protocol CurrentLocationProviding {
    func requestCurrentLocation() async throws -> GeographicCoordinate
}

@MainActor
public protocol LocationNameResolving {
    func resolveName(for coordinate: GeographicCoordinate) async throws -> String
}

@MainActor
public final class DeviceCurrentLocationProvider: NSObject, CurrentLocationProviding, CLLocationManagerDelegate {
    private let manager: CLLocationManager
    private let timeout: Duration
    private var continuation: CheckedContinuation<GeographicCoordinate, any Error>?
    private var timeoutTask: Task<Void, Never>?

    public init(timeout: Duration = .seconds(8)) {
        manager = CLLocationManager()
        self.timeout = timeout
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    public func requestCurrentLocation() async throws -> GeographicCoordinate {
        guard continuation == nil else { throw CurrentLocationError.unavailable }
        let servicesEnabled = await Task.detached(priority: .userInitiated) {
            CLLocationManager.locationServicesEnabled()
        }.value
        guard servicesEnabled else { throw CurrentLocationError.servicesDisabled }
        try Task.checkCancellation()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                scheduleTimeout()
                beginRequest()
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(.failure(CancellationError()))
            }
        }
    }

    private func beginRequest() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied:
            finish(.failure(CurrentLocationError.denied))
        case .restricted:
            finish(.failure(CurrentLocationError.restricted))
        @unknown default:
            finish(.failure(CurrentLocationError.unavailable))
        }
    }

    private func scheduleTimeout() {
        let delay = timeout
        timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.finish(.failure(CurrentLocationError.timedOut))
        }
    }

    private func finish(_ result: Result<GeographicCoordinate, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        manager.stopUpdatingLocation()
        continuation.resume(with: result)
    }

    public nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor [weak self] in
            self?.handleAuthorizationChange(status)
        }
    }

    private func handleAuthorizationChange(_ status: CLAuthorizationStatus) {
        guard continuation != nil else { return }
        switch status {
        case .notDetermined:
            break
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied:
            finish(.failure(CurrentLocationError.denied))
        case .restricted:
            finish(.failure(CurrentLocationError.restricted))
        @unknown default:
            finish(.failure(CurrentLocationError.unavailable))
        }
    }

    public nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let coordinate = locations.last(where: {
            $0.horizontalAccuracy >= 0 && abs($0.timestamp.timeIntervalSinceNow) <= 300
        }).map {
            GeographicCoordinate(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude)
        }
        Task { @MainActor [weak self] in
            if let coordinate {
                self?.finish(.success(coordinate))
            } else {
                self?.finish(.failure(CurrentLocationError.unavailable))
            }
        }
    }

    public nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor [weak self] in
            self?.finish(.failure(denied ? CurrentLocationError.denied : CurrentLocationError.unavailable))
        }
    }
}

@MainActor
public final class AppleLocationNameResolver: LocationNameResolving {
    private let timeout: Duration
    private var geocoder: CLGeocoder?
    private var continuation: CheckedContinuation<String, any Error>?
    private var timeoutTask: Task<Void, Never>?

    public init(timeout: Duration = .seconds(8)) {
        self.timeout = timeout
    }

    public func resolveName(for coordinate: GeographicCoordinate) async throws -> String {
        guard continuation == nil else { throw LocationNameError.unavailable }
        try Task.checkCancellation()

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let geocoder = CLGeocoder()
                self.geocoder = geocoder
                scheduleTimeout()
                geocoder.reverseGeocodeLocation(
                    CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude),
                    preferredLocale: Locale(identifier: "ja_JP")
                ) { [weak self] placemarks, error in
                    Task { @MainActor in
                        self?.handle(placemarks: placemarks, error: error)
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(.failure(CancellationError()))
            }
        }
    }

    private func scheduleTimeout() {
        let delay = timeout
        timeoutTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.finish(.failure(LocationNameError.timedOut))
        }
    }

    private func handle(placemarks: [CLPlacemark]?, error: (any Error)?) {
        guard error == nil, let placemark = placemarks?.first,
              let label = Self.coarseLabel(for: placemark)
        else {
            finish(.failure(LocationNameError.unavailable))
            return
        }
        finish(.success(label))
    }

    private static func coarseLabel(for placemark: CLPlacemark) -> String? {
        let values = [
            placemark.administrativeArea,
            placemark.locality ?? placemark.subAdministrativeArea,
        ]
        var components: [String] = []
        for value in values {
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty, !components.contains(value)
            else { continue }
            components.append(value)
        }
        return components.isEmpty ? nil : components.joined()
    }

    private func finish(_ result: Result<String, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        if case .failure = result {
            geocoder?.cancelGeocode()
        }
        geocoder = nil
        continuation.resume(with: result)
    }
}
