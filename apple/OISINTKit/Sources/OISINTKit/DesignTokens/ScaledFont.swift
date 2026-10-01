import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Web の px 指定フォントを Dynamic Type でスケールさせる（計画書 §3.3 / Issue #208 アクセシビリティ要件）。
/// iOS では UIFontMetrics(.body) のスケール（SwiftUI 環境の dynamicTypeSize と明示連動）、
/// macOS はシステム設定に Dynamic Type が無いため固定値。
struct OISINTScaledFont: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let size: CGFloat
    let weight: Font.Weight

    func body(content: Content) -> some View {
        #if canImport(UIKit)
        // UIFontMetrics のデフォルトは UITraitCollection.current 依存で SwiftUI の環境変化に
        // 追従しないため、dynamicTypeSize から UIContentSizeCategory を明示して渡す
        let category = UIContentSizeCategory(dynamicTypeSize)
        let scaled = UIFontMetrics(forTextStyle: .body).scaledValue(
            for: size,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: category)
        )
        content.font(.system(size: scaled, weight: weight))
        #else
        content.font(.system(size: size, weight: weight))
        #endif
    }
}

#if canImport(UIKit)
extension UIContentSizeCategory {
    /// SwiftUI DynamicTypeSize → UIKit UIContentSizeCategory の対応
    init(_ dynamicTypeSize: DynamicTypeSize) {
        switch dynamicTypeSize {
        case .xSmall: self = .extraSmall
        case .small: self = .small
        case .medium: self = .medium
        case .large: self = .large
        case .xLarge: self = .extraLarge
        case .xxLarge: self = .extraExtraLarge
        case .xxxLarge: self = .extraExtraExtraLarge
        case .accessibility1: self = .accessibilityMedium
        case .accessibility2: self = .accessibilityLarge
        case .accessibility3: self = .accessibilityExtraLarge
        case .accessibility4: self = .accessibilityExtraExtraLarge
        case .accessibility5: self = .accessibilityExtraExtraExtraLarge
        @unknown default: self = .large
        }
    }
}
#endif

extension View {
    /// `.font(.system(size:weight:))` の Dynamic Type 対応版
    /// （Swift 6 言語モードでは `View` extension が MainActor 推論され nonisolated な
    ///   ヘルパー関数から呼べないため、SDK の `.font()` と同じく nonisolated を明示）
    nonisolated public func oisintFont(_ size: CGFloat, _ weight: Font.Weight = .regular) -> some View {
        modifier(OISINTScaledFont(size: size, weight: weight))
    }
}
