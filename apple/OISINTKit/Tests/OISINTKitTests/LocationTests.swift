import Foundation
import Testing
@testable import OISINTKit
import OISINTKitDebugFixtures

@MainActor
@Suite struct LocationTests {
    @Test func doesNotRequestPermissionDuringInitialization() {
        let provider = StubCurrentLocationProvider(.success(.init(latitude: 35.681236, longitude: 139.767125)))
        _ = HomeStore(currentLocationProvider: provider, locationNameResolver: StubLocationNameResolver(.success("東京都千代田区")))

        #expect(provider.requestCount == 0)
    }

    @Test func resolvedCurrentLocationBecomesCoarseSearchCondition() async throws {
        let coordinate = GeographicCoordinate(latitude: 35.681236, longitude: 139.767125)
        let locationProvider = StubCurrentLocationProvider(.success(coordinate))
        let store = HomeStore(
            currentLocationProvider: locationProvider,
            locationNameResolver: StubLocationNameResolver(.success("東京都千代田区"))
        )

        await store.requestCurrentLocation()

        #expect(locationProvider.requestCount == 1)
        #expect(store.locationState == .selected)
        #expect(store.selectedLocation == LocationSelection(label: "東京都千代田区付近", source: .current))
        #expect(store.locationErrorMessage.isEmpty)
    }

    @Test func startSendsPlaceNameButNeverCoordinates() async throws {
        let provider = MockProvider(stepInterval: .milliseconds(1))
        let defaults = UserDefaults(suiteName: "test-\(UUID().uuidString)")!
        let app = AppStore(provider: provider, mode: .mock, defaults: defaults)
        await app.bootstrap()
        let store = HomeStore(
            currentLocationProvider: StubCurrentLocationProvider(
                .success(.init(latitude: 35.681236, longitude: 139.767125))
            ),
            locationNameResolver: StubLocationNameResolver(.success("東京都千代田区"))
        )
        store.query = "静かに話せる店"

        await store.requestCurrentLocation()
        await store.start(app: app)

        guard case .investigation(let id, _) = app.path.first,
              let investigation = try await provider.getInvestigation(id: id)
        else {
            Issue.record("現在地条件つきの調査が作成されていない")
            return
        }
        #expect(investigation.rawQuery == "場所: 東京都千代田区付近。静かに話せる店")
        #expect(!investigation.rawQuery.contains("35.681236"))
        #expect(!investigation.rawQuery.contains("139.767125"))
    }

    @Test func deniedPermissionStopsLoadingAndKeepsManualFallback() async {
        let store = HomeStore(
            currentLocationProvider: StubCurrentLocationProvider(.failure(.denied)),
            locationNameResolver: StubLocationNameResolver(.success("未使用"))
        )

        await store.requestCurrentLocation()

        #expect(store.locationState == .denied)
        #expect(!store.isLocationRequesting)
        #expect(store.selectedLocation == nil)
        #expect(store.locationErrorMessage == "位置情報が許可されていません。場所名を入力して続けてください。")

        store.manualLocation = "  池袋駅  "
        store.applyManualLocation()
        #expect(store.selectedLocation == LocationSelection(label: "池袋駅", source: .manual))
        #expect(store.locationState == .selected)
        #expect(store.locationErrorMessage.isEmpty)
    }

    @Test(arguments: [
        (CurrentLocationError.servicesDisabled, LocationRequestState.servicesDisabled),
        (CurrentLocationError.timedOut, LocationRequestState.timedOut),
        (CurrentLocationError.unavailable, LocationRequestState.unavailable),
    ])
    func failuresStopLoading(argument: (CurrentLocationError, LocationRequestState)) async {
        let (error, expectedState) = argument
        let store = HomeStore(
            currentLocationProvider: StubCurrentLocationProvider(.failure(error)),
            locationNameResolver: StubLocationNameResolver(.success("未使用"))
        )

        await store.requestCurrentLocation()

        #expect(store.locationState == expectedState)
        #expect(!store.isLocationRequesting)
        #expect(store.selectedLocation == nil)
        #expect(!store.locationErrorMessage.isEmpty)
    }

    @Test func reverseGeocodingFailureFallsBackToManualInput() async {
        let store = HomeStore(
            currentLocationProvider: StubCurrentLocationProvider(
                .success(.init(latitude: 35.681236, longitude: 139.767125))
            ),
            locationNameResolver: StubLocationNameResolver(.failure(.unavailable))
        )

        await store.requestCurrentLocation()

        #expect(store.locationState == .unavailable)
        #expect(!store.isLocationRequesting)
        #expect(store.selectedLocation == nil)
        #expect(store.locationErrorMessage == "現在地を地名に変換できませんでした。場所名を入力して続けてください。")
    }
}

@MainActor
private final class StubCurrentLocationProvider: CurrentLocationProviding {
    enum Outcome {
        case success(GeographicCoordinate)
        case failure(CurrentLocationError)
    }

    private let outcome: Outcome
    private(set) var requestCount = 0

    init(_ outcome: Outcome) {
        self.outcome = outcome
    }

    func requestCurrentLocation() async throws -> GeographicCoordinate {
        requestCount += 1
        switch outcome {
        case .success(let coordinate):
            return coordinate
        case .failure(let error):
            throw error
        }
    }
}

@MainActor
private final class StubLocationNameResolver: LocationNameResolving {
    enum Outcome {
        case success(String)
        case failure(LocationNameError)
    }

    private let outcome: Outcome

    init(_ outcome: Outcome) {
        self.outcome = outcome
    }

    func resolveName(for coordinate: GeographicCoordinate) async throws -> String {
        switch outcome {
        case .success(let name):
            return name
        case .failure(let error):
            throw error
        }
    }
}
