import SwiftUI

/// src/components/Footer.tsx の移植。
/// Geoapify/OSM のクレジット表記を全画面のフッターに常設する（spec.md §27 必須）。
///
/// レイアウト（#241 / Web 側 #244）: Web 正典（origin/master src/components/Footer.tsx）は
/// `isCompact = width < 720` を閾値に、スマホ幅では「クレジット行 + リンク行（flexWrap 折り返し）」の
/// 2 行構成（column / flex-start / gap 2、padding 10/16）、720 以上では従来どおり
/// クレジット左・リンク右の 1 行（space-between / gap 12、padding 16/24）に切り替える。
/// 本ビューは常にウィンドウ全幅に置かれる（RootScene / HomeView / InvestigationView 直下）ため、
/// 自身の幅 = Web の useWindowDimensions().width 相当として同一閾値で判定する。
public struct FooterView: View {
    /// Web 正典の isCompact = width < 720 と同一閾値
    private static let compactWidth: CGFloat = 720

    @State private var isCompact = false

    public init() {}

    public var body: some View {
        // Geometry の action は Sendable closure として扱われるため、main actor-isolated
        // static property を closure 内から参照せず、値だけを先に取り込む。
        let compactWidth = Self.compactWidth
        Group {
            if isCompact {
                // compact（スマホ幅）: innerCompact = column / flex-start / gap 2 と同値の 2 行構成
                VStack(alignment: .leading, spacing: 2) {
                    credit
                    // linksCompact = width 100% + links の flexWrap: wrap（見切れ・横スクロールなし）
                    FlowLayout(spacing: 2) { links }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                // 720 以上（iPad / Mac）: inner = row / space-between / gap 12 と同値の 1 行
                HStack(alignment: .center, spacing: 12) {
                    credit
                    Spacer(minLength: 0)
                    FlowLayout(spacing: 2) { links }
                }
            }
        }
        .frame(maxWidth: 1100)
        .padding(.vertical, isCompact ? 10 : 16)
        .padding(.horizontal, isCompact ? 16 : 24)
        .frame(maxWidth: .infinity)
        .background(DesignTokens.Colors.surfaceSoft.color)
        .overlay(alignment: .top) {
            DesignTokens.Colors.borderSoft.color.frame(height: 1)
        }
        // フッター全幅（= ウィンドウ幅）を実測して Web と同じ閾値で切り替える
        .onGeometryChange(for: Bool.self) { proxy in
            proxy.size.width < compactWidth
        } action: { compact in
            isCompact = compact
        }
        // コンテナ testID は children: .contain で子の identifier を保つ（伝播上書き防止）
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("footer-credit")
    }

    private var credit: some View {
        Text("© OpenStreetMap contributors · Powered by Geoapify")
            .oisintFont(12)
            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
    }

    @ViewBuilder private var links: some View {
        footerLink(String(localized: "使い方", bundle: .module), path: "help", label: String(localized: "OISINTの使い方ガイドを開く", bundle: .module), identifier: "footer-help")
        footerLink(String(localized: "サポート", bundle: .module), path: "support", label: String(localized: "OISINTのサポートを開く", bundle: .module), identifier: "footer-support")
        footerLink(String(localized: "お問い合わせ", bundle: .module), path: "contact", label: String(localized: "OISINTにお問い合わせする", bundle: .module), identifier: "footer-contact")
        footerLink(String(localized: "フィードバック", bundle: .module), path: "feedback", label: String(localized: "OISINTにフィードバックを送る", bundle: .module), identifier: "footer-feedback")
    }

    /// サポート系画面はネイティブでは P1（計画書 §3.6-2）のため、実在する Web ページをブラウザで開く
    private func footerLink(_ title: String, path: String, label: String, identifier: String) -> some View {
        Link(destination: URL(string: "https://oisint.com/\(path)")!) {
            Text("\(title) ↗")
                .oisintFont(12, .bold)
                .foregroundStyle(DesignTokens.Colors.orange.color)
                .padding(.horizontal, 8)
                .frame(minHeight: 32)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
}
