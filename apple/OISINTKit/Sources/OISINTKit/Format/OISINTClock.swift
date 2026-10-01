import Foundation

/// Providerに依存しない更新時刻の生成。Releaseでmock実装をリンクしないための共通境界。
public enum OISINTClock {
    public static func nowISO() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}
