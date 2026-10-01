import Foundation

/// provider モード（web src/lib/api.ts の 'mock' | 'live'）
public enum DataProviderMode: String, Sendable {
    #if DEBUG
    case mock
    #endif
    case live
}

/// mock/live 分岐はここ 1 箇所のみ（spec.md §26: 「Provider 生成箇所 1 箇所に閉じ込める。
/// 呼び出し側や UI に if (mock) を書かない」）。
public enum ProviderFactory {
    /// RevenueCat SDKはこの境界でだけ生成する。公開key未設定時はfail-closedで
    /// 購入/復元を利用不能にし、Plusを推測付与しない。
    @MainActor
    public static func makeEntitlementProvider(
        apiKey: String?,
        fetchServerEntitlement: @escaping ServerEntitlementFetcher = { _ in EntitlementStatus() }
    ) -> any EntitlementProviding {
        guard let apiKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines),
              !apiKey.isEmpty else {
            return UnavailableEntitlementProvider()
        }
        return RevenueCatEntitlementProvider(
            apiKey: apiKey,
            fetchServerEntitlement: fetchServerEntitlement
        )
    }

    /// web api.ts のモード規則の移植（計画書 §2.7）:
    /// 1. OISINT_DATA_PROVIDER_MODE（mock/live）が最優先
    /// 2. 未指定時: DEBUG ビルド = mock、Release ビルド = live
    /// 3. Release で mock を許すのは allowMockInRelease（OISINT_ALLOW_MOCK）のみ。
    ///    「Production never falls back to mock」（api.ts コメント逐語）
    #if DEBUG
    public static func decideMode(
        explicitMode: String?,
        isDebugBuild: Bool,
        allowMockInRelease: Bool
    ) -> DataProviderMode {
        let requested = explicitMode ?? (isDebugBuild ? "mock" : "live")
        let mockAllowed = isDebugBuild || allowMockInRelease
        return (requested == "mock" && mockAllowed) ? .mock : .live
    }
    #else
    public static func decideMode(
        explicitMode: String?,
        isDebugBuild: Bool
    ) -> DataProviderMode {
        // Releaseでは環境変数に関わらず live 固定。mock case と文字列は成果物へ持ち込まない。
        _ = explicitMode
        _ = isDebugBuild
        return .live
    }
    #endif

    /// 実行時のモード決定（環境変数 OISINT_DATA_PROVIDER_MODE を参照）
    #if DEBUG
    public static func currentMode(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        allowMockInRelease: Bool = false
    ) -> DataProviderMode {
        let isDebugBuild = true
        return decideMode(
            explicitMode: environment["OISINT_DATA_PROVIDER_MODE"],
            isDebugBuild: isDebugBuild,
            allowMockInRelease: allowMockInRelease
        )
    }
    #else
    public static func currentMode(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> DataProviderMode {
        // Releaseでは環境変数に関わらず live 固定。
        _ = environment
        return .live
    }
    #endif

    /// live 接続設定（Info.plist / xcconfig 由来。secret は含まない §34）
    public struct LiveConfiguration: Sendable {
        public var supabaseURL: URL
        public var supabaseAnonKey: String
        public var apiBaseURL: URL

        public init(supabaseURL: URL, supabaseAnonKey: String, apiBaseURL: URL) {
            self.supabaseURL = supabaseURL
            self.supabaseAnonKey = supabaseAnonKey
            self.apiBaseURL = apiBaseURL
        }
    }

    /// Provider 生成（アプリ起動時に 1 回だけ呼ぶ）。
    /// 設定不足の live は「見えるエラー」で失敗させる
    /// （api.ts: 'Live Supabase API is not configured...' と同じ思想。mock へ silent fallback しない）
    public static func make(
        mode: DataProviderMode,
        liveConfiguration: LiveConfiguration?,
        debugProvider: (@Sendable () -> any DataProvider)? = nil
    ) throws -> any DataProvider {
        switch mode {
        #if DEBUG
        case .mock:
            return (debugProvider ?? { MockProvider() })()
        #endif
        case .live:
            guard let liveConfiguration else {
                throw OISINTError("Live Supabase API is not configured. Set OISINT_SUPABASE_URL and OISINT_SUPABASE_ANON_KEY.")
            }
            guard Self.isValidSupabaseOrigin(liveConfiguration.supabaseURL),
                  Self.isValidAPIOrigin(liveConfiguration.apiBaseURL) else {
                throw OISINTError("Live API接続先が不正です。")
            }
            return LiveProvider(configuration: liveConfiguration)
        }
    }

    private static func isValidSupabaseOrigin(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        let production = url.scheme?.lowercased() == "https" &&
            host.range(of: #"^[a-z0-9][a-z0-9-]*\.supabase\.co$"#, options: .regularExpression) != nil
        #if DEBUG
        let local = ["localhost", "127.0.0.1", "::1"].contains(host) &&
            ["http", "https"].contains(url.scheme?.lowercased())
        #else
        let local = false
        #endif
        return (production || local) &&
            (url.port == nil || url.port == 443 || local) &&
            url.user == nil && url.query == nil && url.fragment == nil &&
            (url.path.isEmpty || url.path == "/")
    }

    private static func isValidAPIOrigin(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        #if DEBUG
        let local = ["localhost", "127.0.0.1", "::1"].contains(host) &&
            ["http", "https"].contains(url.scheme?.lowercased())
        #else
        let local = false
        #endif
        let production = url.scheme?.lowercased() == "https" && host == "api.oisint.com"
        return (production || local) &&
            (url.port == nil || url.port == 443 || local) &&
            url.user == nil && url.query == nil && url.fragment == nil &&
            (url.path.isEmpty || url.path == "/")
    }
}
