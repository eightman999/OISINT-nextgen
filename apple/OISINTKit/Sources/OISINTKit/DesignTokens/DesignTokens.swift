import SwiftUI

/// デザイントークンの色。テスト照合用の hex 文字列（rawValue）と SwiftUI Color の両面を持つ（計画書 §3.1）
public struct ColorToken: Sendable, Equatable {
    public let hex: String

    public init(_ hex: String) {
        self.hex = hex
    }

    public var color: Color {
        var value: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&value)
        return Color(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// タグ配色（文字色 + 背景色）
public struct TagStyle: Sendable, Equatable {
    public let color: ColorToken
    public let background: ColorToken

    public init(color: String, background: String) {
        self.color = ColorToken(color)
        self.background = ColorToken(background)
    }
}

/// `src/theme.ts` の逐語移植（Issue #208 デザイン踏襲の正典）。
/// 値の正本は src/theme.ts。DesignTokensParityTests が theme.ts を実行時にパースして全値一致を機械検証する。
/// キー名・値・順序を theme.ts から改変しない。
public enum DesignTokens {
    // MARK: - colors（theme.ts `colors`、宣言順。キー数は DesignTokensParityTests が theme.ts 実測と照合）

    public enum Colors {
        public static let bg = ColorToken("#f1ece2")
        public static let canvas = ColorToken("#fbf8f1")
        public static let surface = ColorToken("#fffdf8")
        public static let surfaceSoft = ColorToken("#e9e1d4")
        public static let surfaceQuiet = ColorToken("#fcfbf8")
        public static let surfaceDisabled = ColorToken("#f1f1f1")

        // 純白 / 純黒。surface（#fffdf8）/ black（#1d2923 の墨色）とは意味が違う（theme.ts のコメント。#219）
        public static let white = ColorToken("#ffffff")
        public static let pureBlack = ColorToken("#000000")

        public static let text = ColorToken("#1d2923")
        public static let textSecondary = ColorToken("#4f5c55")
        public static let textTertiary = ColorToken("#59655e")
        public static let textOnColorDark = ColorToken("#101713")
        public static let placeholder = ColorToken("#9ca3af")

        public static let border = ColorToken("#d4c9b8")
        public static let borderSoft = ColorToken("#e5dbcd")

        public static let black = ColorToken("#1d2923")
        public static let blackHover = ColorToken("#33463b")

        public static let orange = ColorToken("#b23915")
        public static let orangeHover = ColorToken("#922d10")
        public static let orangeSoft = ColorToken("#ffb19a")
        public static let orangeFaint = ColorToken("#fff5f0")
        public static let amber = ColorToken("#c9953b")
        public static let red = ColorToken("#c9574d")

        public static let success = ColorToken("#2c9a66")
        public static let successSoft = ColorToken("#e8f5ee")
        public static let warning = ColorToken("#8a5700")
        public static let warningSoft = ColorToken("#fff3d9")
        public static let danger = ColorToken("#e14d4d")
        public static let dangerSoft = ColorToken("#fdeaea")
        public static let info = ColorToken("#1d5fa8")
        public static let infoSoft = ColorToken("#eef5fb")
        public static let googleBlue = ColorToken("#4285f4")
        public static let googleSoft = ColorToken("#f1f5fb")
        public static let importSoft = ColorToken("#f4f8fc")
        public static let hearingSoft = ColorToken("#f3f8fc")

        public static let chipBg = ColorToken("#faf5ec")
        public static let sidebarBg = ColorToken("#f4ede1")
        public static let activeBg = ColorToken("#fce9dc")

        /// テスト照合用の順序付き全キー（theme.ts の宣言順のまま）
        public static let all: [(key: String, token: ColorToken)] = [
            ("bg", bg), ("canvas", canvas), ("surface", surface), ("surfaceSoft", surfaceSoft),
            ("surfaceQuiet", surfaceQuiet), ("surfaceDisabled", surfaceDisabled),
            ("white", white), ("pureBlack", pureBlack),
            ("text", text), ("textSecondary", textSecondary), ("textTertiary", textTertiary),
            ("textOnColorDark", textOnColorDark), ("placeholder", placeholder),
            ("border", border), ("borderSoft", borderSoft),
            ("black", black), ("blackHover", blackHover),
            ("orange", orange), ("orangeHover", orangeHover),
            ("orangeSoft", orangeSoft), ("orangeFaint", orangeFaint), ("amber", amber), ("red", red),
            ("success", success), ("successSoft", successSoft),
            ("warning", warning), ("warningSoft", warningSoft),
            ("danger", danger), ("dangerSoft", dangerSoft), ("info", info), ("infoSoft", infoSoft),
            ("googleBlue", googleBlue), ("googleSoft", googleSoft),
            ("importSoft", importSoft), ("hearingSoft", hearingSoft),
            ("chipBg", chipBg), ("sidebarBg", sidebarBg), ("activeBg", activeBg),
        ]
    }

    // MARK: - rankColors（theme.ts L38-42）

    public static let rankColors: [ColorToken] = [
        ColorToken("#d99a00"),
        ColorToken("#ef3e3e"),
        ColorToken("#ef5a18"),
        ColorToken("#83abb2"),
        ColorToken("#e2a65e"),
    ]

    /// theme.ts `rankColor(rank)`: rank を 1..5 に clamp して 0-index 参照
    public static func rankColor(_ rank: Int) -> ColorToken {
        rankColors[min(max(rank, 1), rankColors.count) - 1]
    }

    public static func contrastRatio(_ foreground: ColorToken, _ background: ColorToken) -> Double {
        let foregroundLuminance = relativeLuminance(foreground)
        let backgroundLuminance = relativeLuminance(background)
        let lighter = max(foregroundLuminance, backgroundLuminance)
        let darker = min(foregroundLuminance, backgroundLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    public static func readableTextColor(for background: ColorToken) -> ColorToken {
        contrastRatio(Colors.textOnColorDark, background) >= contrastRatio(Colors.surface, background)
            ? Colors.textOnColorDark
            : Colors.surface
    }

    private static func relativeLuminance(_ token: ColorToken) -> Double {
        let value = UInt64(token.hex.dropFirst(), radix: 16) ?? 0
        let channels = [16, 8, 0].map { shift -> Double in
            let channel = Double((value >> shift) & 0xFF) / 255
            return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    }

    // MARK: - radius（theme.ts L44-51）

    public enum Radius {
        public static let xs: CGFloat = 6
        public static let sm: CGFloat = 9
        public static let md: CGFloat = 12
        public static let lg: CGFloat = 16
        public static let xl: CGFloat = 22
        public static let pill: CGFloat = 999

        /// テスト照合用の順序付き全キー
        public static let all: [(key: String, value: CGFloat)] = [
            ("xs", xs), ("sm", sm), ("md", md), ("lg", lg), ("xl", xl), ("pill", pill),
        ]
    }

    // MARK: - fonts（theme.ts L54-57）
    // theme.ts は Platform.OS === 'web' 以外で fonts.brand/ui = undefined（= システムフォント）。
    // ネイティブ＝システムフォントが正典に忠実（計画書 §3.3）。よって Font 定数は持たない。

    // MARK: - genreColorMap（theme.ts L60-77、16 組、宣言順）

    public static let genreColorMap: [(genre: String, token: ColorToken)] = [
        ("ラーメン", ColorToken("#f6a636")),
        ("つけ麺", ColorToken("#f6a636")),
        ("バーガー", ColorToken("#c77947")),
        ("アメリカン", ColorToken("#c77947")),
        ("寿司", ColorToken("#e84c4c")),
        ("カフェ", ColorToken("#d4b996")),
        ("パンケーキ", ColorToken("#d4b996")),
        ("ピザ", ColorToken("#f4c430")),
        ("イタリアン", ColorToken("#f4c430")),
        ("居酒屋", ColorToken("#7cb0b5")),
        ("焼鳥", ColorToken("#7cb0b5")),
        ("焼肉", ColorToken("#b94d4d")),
        ("ステーキ", ColorToken("#b94d4d")),
        ("ファミレス", ColorToken("#7cb87c")),
        ("定食", ColorToken("#6c9bd1")),
        ("フレンチ", ColorToken("#2a2a2a")),
    ]

    /// theme.ts `genreColor()` の fallback（L85）
    public static let genreFallback = ColorToken("#83abb2")

    /// theme.ts `genreColor(genre)`: 前方からの部分一致（includes → contains）、fallback #83abb2
    public static func genreColor(_ genre: String?) -> ColorToken {
        if let genre {
            for (key, token) in genreColorMap where genre.contains(key) {
                return token
            }
        }
        return genreFallback
    }

    // MARK: - spacing（docs/design/OISINT_UI_HTML_CSS_design_spec.md。theme.ts 対象外のため機械照合なし）

    public enum Spacing {
        public static let xs: CGFloat = 4
        public static let sm: CGFloat = 8
        public static let md: CGFloat = 12
        public static let base: CGFloat = 16
        public static let lg: CGFloat = 20
        public static let xl: CGFloat = 24
        public static let xxl: CGFloat = 32
        public static let xxxl: CGFloat = 40
    }

    // MARK: - Components（theme.ts tagColors + コンポーネント固有値。計画書 §3.1）

    public enum Components {
        /// src/theme.ts tagColors（CandidateCard.tsx / design.html .tag-* と一致）
        public static let tagGreen = TagStyle(color: "#277c56", background: "#e6f4ed")
        public static let tagBlue = TagStyle(color: "#1c727b", background: "#e5f4f6")
        public static let tagOrange = TagStyle(color: "#b23915", background: "#fff0e6")
        public static let tagRed = TagStyle(color: "#bd3030", background: "#fde9e9")

        /// src/components/MemberList.tsx avatarColors
        public static let avatarColors: [ColorToken] = [
            ColorToken("#f4a000"),
            ColorToken("#f4511e"),
            ColorToken("#2c9a66"),
            ColorToken("#1d5fa8"),
            ColorToken("#83abb2"),
        ]

        /// design.html カード影の実測近似: 0 2px 7px rgba(30,26,22,0.04)（計画書 §3.2）
        public static let cardShadowOpacity: Double = 0.04
        public static let cardShadowRadius: CGFloat = 3.5
        public static let cardShadowY: CGFloat = 2
    }
}
