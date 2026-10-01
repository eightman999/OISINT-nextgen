import Foundation
import Observation

/// Home（調査作成）画面の状態。app/index.tsx の handleStart を移植。
@MainActor
@Observable
public final class HomeStore {
    public var query = ""
    public var localName = ""
    public var loading = false
    public var errorMessage = ""
    public var manualLocation = ""
    public private(set) var selectedLocation: LocationSelection?
    public private(set) var locationState: LocationRequestState = .idle
    public private(set) var locationErrorMessage = ""

    private let currentLocationProvider: any CurrentLocationProviding
    private let locationNameResolver: any LocationNameResolving
    private let createIdempotencyKeyState = CreateIdempotencyKeyState()

    /// app/index.tsx の例文（SCENES の query 逐語）
    public static let exampleQueries: [String] = [
        "池袋で3人。3000円くらい。肉。カード可。静かめ。",
        "新宿で4人。ひとり6000円前後。個室。落ち着いた和食。",
        "渋谷で2人。ランチ。写真映えするカフェ。駅から徒歩5分以内。",
    ]

    public init(
        currentLocationProvider: any CurrentLocationProviding = DeviceCurrentLocationProvider(),
        locationNameResolver: any LocationNameResolving = AppleLocationNameResolver()
    ) {
        self.currentLocationProvider = currentLocationProvider
        self.locationNameResolver = locationNameResolver
    }

    public var canStart: Bool {
        !loading && !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var isLocationRequesting: Bool {
        locationState == .requesting
    }

    public func requestCurrentLocation() async {
        guard !isLocationRequesting else { return }
        locationState = .requesting
        locationErrorMessage = ""

        do {
            let coordinate = try await currentLocationProvider.requestCurrentLocation()
            let resolvedName = try await locationNameResolver.resolveName(for: coordinate)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !resolvedName.isEmpty else { throw LocationNameError.unavailable }
            let label = resolvedName.hasSuffix("付近") ? resolvedName : "\(resolvedName)付近"
            selectedLocation = LocationSelection(label: label, source: .current)
            locationState = .selected
        } catch let error as CurrentLocationError {
            handleLocationError(error)
        } catch let error as LocationNameError {
            locationState = error == .timedOut ? .timedOut : .unavailable
            selectedLocation = nil
            locationErrorMessage = String(localized: "現在地を地名に変換できませんでした。場所名を入力して続けてください。", bundle: .module)
        } catch is CancellationError {
            locationState = .idle
            selectedLocation = nil
            locationErrorMessage = ""
        } catch {
            locationState = .unavailable
            selectedLocation = nil
            locationErrorMessage = String(localized: "現在地を取得できませんでした。場所名を入力して続けてください。", bundle: .module)
        }
    }

    public func applyManualLocation() {
        let label = manualLocation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return }
        selectedLocation = LocationSelection(label: label, source: .manual)
        locationState = .selected
        locationErrorMessage = ""
    }

    public func clearLocation() {
        selectedLocation = nil
        manualLocation = ""
        locationState = .idle
        locationErrorMessage = ""
    }

    private func handleLocationError(_ error: CurrentLocationError) {
        selectedLocation = nil
        switch error {
        case .denied:
            locationState = .denied
            locationErrorMessage = String(localized: "位置情報が許可されていません。場所名を入力して続けてください。", bundle: .module)
        case .restricted:
            locationState = .restricted
            locationErrorMessage = String(localized: "端末の制限により位置情報を使用できません。場所名を入力して続けてください。", bundle: .module)
        case .servicesDisabled:
            locationState = .servicesDisabled
            locationErrorMessage = String(localized: "位置情報サービスが無効です。場所名を入力して続けてください。", bundle: .module)
        case .timedOut:
            locationState = .timedOut
            locationErrorMessage = String(localized: "現在地の取得がタイムアウトしました。場所名を入力して続けてください。", bundle: .module)
        case .unavailable:
            locationState = .unavailable
            locationErrorMessage = String(localized: "現在地を取得できませんでした。場所名を入力して続けてください。", bundle: .module)
        }
    }

    /// index.tsx handleStart: 表示名は空なら「ゲスト」/ create → run → 遷移 / 失敗文言逐語
    public func start(app: AppStore) async {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty, !loading else { return }
        let requestQuery = [selectedLocation.map { "場所: \($0.label)" }, trimmedQuery]
            .compactMap { $0 }
            .joined(separator: "。")

        loading = true
        errorMessage = ""
        defer { loading = false }
        let name = localName.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = name.isEmpty ? "ゲスト" : name
        app.setDisplayName(name)
        let requestSubject: String
        do {
            // Homeの表示stateではなく、create開始直前のprovider auth sessionからsubjectを確定する。
            requestSubject = try await app.provider.getUserId()
        } catch {
            errorMessage = String(localized: "調査を開始できませんでした。入力内容を確認して、もう一度お試しください。", bundle: .module)
            return
        }
        let idempotencyKey = createIdempotencyKeyState.keyFor(
            subject: requestSubject,
            input: requestQuery,
            displayName: displayName
        )

        do {
            let created = try await app.provider.createInvestigation(
                CreateInvestigationRequest(
                    query: requestQuery,
                    displayName: displayName,
                    userId: requestSubject,
                    idempotencyKey: idempotencyKey,
                    authSubject: requestSubject
                )
            )
            guard try await app.provider.getUserId() == requestSubject else {
                // create応答が旧subjectのものなら、新subjectのHomeへ反映しない。
                return
            }
            let currentName = localName.trimmingCharacters(in: .whitespacesAndNewlines)
            let currentDisplayName = currentName.isEmpty ? "ゲスト" : currentName
            let currentQuery = [selectedLocation.map { "場所: \($0.label)" }, query.trimmingCharacters(in: .whitespacesAndNewlines)]
                .compactMap { $0 }
                .joined(separator: "。")
            guard currentDisplayName == displayName, currentQuery == requestQuery else {
                return
            }
            // 投げっぱなし起動（§25.2。完了は Realtime / mock listener で受ける）
            _ = try await app.provider.runInvestigation(
                RunInvestigationRequest(investigationId: created.investigationId)
            )
            app.recordHistory(
                InvestigationHistoryEntry(
                    investigationId: created.investigationId,
                    shareToken: created.shareToken,
                    title: String(requestQuery.prefix(30)),
                    updatedAt: OISINTClock.nowISO()
                )
            )
            app.openInvestigation(id: created.investigationId, shareToken: created.shareToken)
            createIdempotencyKeyState.clear()
        } catch {
            errorMessage = String(localized: "調査を開始できませんでした。入力内容を確認して、もう一度お試しください。", bundle: .module)
        }
    }
}
