import Foundation

/// ディープリンクのパース（計画書 Phase 7）。
/// 対応: `oisint://i/<token>` / `https://oisint.com/i/<token>` /
///       `oisint://investigations/<id>` / `https://oisint.com/investigations/<id>`
public enum DeepLink {
    /// Supabase OAuth callback。exact allow-listの `oisint://account` 以外は受けない。
    public static func isAuthCallback(_ url: URL) -> Bool {
        guard url.scheme == "oisint" else { return false }
        return url.host == "account" && (url.path.isEmpty || url.path == "/")
    }

    public static func parse(_ url: URL) -> AppRoute? {
        let segments: [String]
        if url.scheme == "oisint" {
            // oisint://i/<token> は host="i" + path="/<token>"
            segments = [url.host].compactMap { $0 } + url.pathComponents.filter { $0 != "/" }
        } else if url.scheme == "https" || url.scheme == "http" {
            guard url.host == "oisint.com" || url.host == "www.oisint.com" else { return nil }
            segments = url.pathComponents.filter { $0 != "/" }
        } else {
            return nil
        }

        guard segments.count >= 2 else { return nil }
        switch segments[0] {
        case "i":
            let token = segments[1]
            // share_token は 32 桁 hex（validation.ts）。mock の seed token も同形式
            guard token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return nil }
            return .join(token: token)
        case "investigations":
            let id = segments[1]
            guard !id.isEmpty else { return nil }
            return .investigation(id: id, shareToken: nil)
        default:
            return nil
        }
    }
}
