import SwiftUI
import OISINTKit

@main
struct OISINTApp: App {
    @State private var app: AppStore

    init() {
        // mock/live 分岐は ProviderFactory 1 箇所のみ（spec.md §26）
        let mode = ProviderFactory.currentMode()
        let provider: any DataProvider
        let providerErrorMessage: String?
        do {
            provider = try ProviderFactory.make(mode: mode, liveConfiguration: Self.liveConfiguration())
            providerErrorMessage = nil
        } catch {
            // DEBUGだけはローカルfixtureを明示許可する。Releaseはmockへ落とさず
            // fail-closed providerで設定エラーを画面へ出す。
            provider = UnavailableDataProvider(
                reason: "本番接続設定を確認できないため、現在は利用できません。"
            )
            providerErrorMessage = ProviderFactory.configurationUnavailableMessage
        }
        let authService: (any AuthProviding)? = (provider as? LiveProvider)?.authService
        let serverEntitlementFetcher: ServerEntitlementFetcher = {
            guard let liveProvider = provider as? LiveProvider else { return EntitlementStatus() }
            return try await liveProvider.fetchServerEntitlement(for: $0)
        }
        let entitlementProvider = ProviderFactory.makeEntitlementProvider(
            apiKey: Self.revenueCatAPIKey(),
            fetchServerEntitlement: serverEntitlementFetcher
        )
        _app = State(initialValue: AppStore(
            provider: provider,
            mode: mode,
            entitlementProvider: entitlementProvider,
            authService: authService,
            providerErrorMessage: providerErrorMessage
        ))
    }

    var body: some Scene {
        WindowGroup {
            RootScene(app: app)
                .onOpenURL { url in
                    if DeepLink.isAuthCallback(url) {
                        Task { await app.handleOpenURL(url) }
                    } else if let route = DeepLink.parse(url) {
                        app.path.append(route)
                    }
                }
        }
    }

    /// Info.plist（xcconfig 経由）から live 設定を読む。置くのは URL / anon key / API base URL のみ（§34）
    private static func liveConfiguration() -> ProviderFactory.LiveConfiguration? {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let urlString = info["OISINT_SUPABASE_URL"] as? String, !urlString.isEmpty,
              let supabaseURL = URL(string: urlString),
              let anonKey = info["OISINT_SUPABASE_ANON_KEY"] as? String, !anonKey.isEmpty
        else { return nil }
        let apiBase = (info["OISINT_API_BASE_URL"] as? String).flatMap(URL.init(string:))
            ?? URL(string: "https://api.oisint.com")!
        return ProviderFactory.LiveConfiguration(
            supabaseURL: supabaseURL,
            supabaseAnonKey: anonKey,
            apiBaseURL: apiBase
        )
    }

    /// RevenueCat公開API keyのみをInfo.plist/xcconfigから読む。server secretは受けない。
    private static func revenueCatAPIKey() -> String? {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let value = info["REVENUECAT_API_KEY"] as? String else { return nil }
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.hasPrefix("$(") else { return nil }
        return key
    }
}
