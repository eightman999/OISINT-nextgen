import SwiftUI

/// app/index.tsx（Home = 調査作成）の P0 縮約移植（計画書 §3.6-2:
/// 検索ボックス + 現在地/手入力場所 + 表示名 + 例文 + Footer で成立。TasteProfilePanel は P1）。
/// 「一覧」は端末ローカル履歴セクションとして表示（§3.6-3）。
public struct HomeView: View {
    @Environment(AppStore.self) private var app
    @State private var store = HomeStore()
    @State private var startHovering = false
    @State private var isWideWorkbench = false

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    topbar
                        .padding(.bottom, 34)
                    if let providerError = app.providerErrorMessage {
                        Text(providerError)
                            .oisintFont(12, .bold)
                            .foregroundStyle(DesignTokens.Colors.danger.color)
                            .padding(.bottom, 16)
                            .accessibilityIdentifier("provider-config-error")
                    }
                    workbench
                    if !app.history.isEmpty {
                        historySection
                            .padding(.top, 24)
                    }
                }
                .frame(maxWidth: 1240)
                .padding(.horizontal, 22)
                .padding(.top, 18)
                .padding(.bottom, 54)
                .frame(maxWidth: .infinity)
            }
            FooterView()
        }
        .background(DesignTokens.Colors.bg.color)
        .onAppear {
            if store.localName.isEmpty, let displayName = app.displayName {
                store.localName = displayName
            }
        }
    }

    // MARK: - topbar（index.tsx: ロゴ + キャプション + livePill）

    private var topbar: some View {
        HStack(alignment: .center, spacing: 18) {
            // Web と同じ透過ロゴ画像（index.tsx: BRAND_LOGO 178×54 / resizeMode contain。
            // 背景色を重ねず Home のオフホワイトへ直接なじませる）
            Image("BrandLogo", bundle: .module)
                .resizable()
                .scaledToFit()
                .frame(width: 178, height: 54)
                .accessibilityLabel(Text("OISINT ロゴ", bundle: .module))
            Spacer()
            VStack(alignment: .trailing, spacing: 8) {
                Text("SHARED FOOD RESEARCH")
                    .oisintFont(9, .heavy)
                    .kerning(1.7)
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                HStack(spacing: 7) {
                    Circle()
                        .fill(DesignTokens.Colors.orange.color)
                        .frame(width: 7, height: 7)
                    Text("今夜の作戦会議", bundle: .module)
                        .oisintFont(10, .bold)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                }
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .background(DesignTokens.Colors.surface.color)
                .clipShape(Capsule())
                .overlay(Capsule().stroke(DesignTokens.Colors.border.color, lineWidth: 1))
                NavigationLink("Plus") {
                    PlusPaywallView()
                }
                .font(.caption.bold())
                .accessibilityIdentifier("plus-paywall-link")
                NavigationLink(String(localized: "アカウント", bundle: .module)) {
                    AccountView()
                }
                .font(.caption.bold())
                .accessibilityIdentifier("account-link")
            }
        }
        .frame(minHeight: 66)
    }

    // MARK: - workbench（index.tsx: 検索ボックス + 表示名 + 例文）

    private var workbench: some View {
        Group {
            if isWideWorkbench {
                HStack(alignment: .top, spacing: 26) {
                    researchCard
                    explanationCard
                }
            } else {
                VStack(alignment: .leading, spacing: 26) {
                    researchCard
                    explanationCard
                }
            }
        }
        .onGeometryChange(for: Bool.self) { proxy in
            proxy.size.width >= 920
        } action: { isWide in
            isWideWorkbench = isWide
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lp-workbench")
    }

    private var researchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("ここから調べる", bundle: .module)
                    .oisintFont(10, .heavy)
                    .kerning(1.2)
                    .foregroundStyle(DesignTokens.Colors.orange.color)
                Text("今夜の条件を、もう少しだけ具体的に。", bundle: .module)
                    .oisintFont(18, .heavy)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                Text("新しい店探しをはじめる", bundle: .module)
                    .oisintFont(10, .bold)
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            }
            .padding(.bottom, 14)
            .overlay(alignment: .bottom) {
                DesignTokens.Colors.borderSoft.color.frame(height: 1)
            }

            HStack(alignment: .center, spacing: 12) {
                Circle()
                    .fill(DesignTokens.Colors.orange.color)
                    .frame(width: 34, height: 34)
                    .overlay(
                        Text("?")
                            .oisintFont(14, .heavy)
                            .foregroundStyle(DesignTokens.Colors.surface.color)
                    )
                VStack(alignment: .leading, spacing: 3) {
                    Text("いまの気分を、そのまま書く", bundle: .module)
                        .oisintFont(15, .heavy)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                    Text("「静かめ」「駅から近い」「誰かが喜ぶ」も立派な条件。あとから場所と好みを足せます。", bundle: .module)
                        .oisintFont(11)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                }
            }
            .padding(.bottom, 4)

            LocationPickerView(store: store)
            searchBox

            if !store.errorMessage.isEmpty {
                Text(store.errorMessage)
                    .oisintFont(12)
                    .foregroundStyle(DesignTokens.Colors.danger.color)
            }

            identityRow
            examples

            Text("急ぎなら、場所と条件を一文だけで開始できます。調査の途中でも、みんなで条件を足せます。", bundle: .module)
                .oisintFont(10)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                .accessibilityIdentifier("impulse-exit")
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(isWideWorkbench ? 28 : 18)
        .background(DesignTokens.Colors.surface.color)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(DesignTokens.Colors.border.color, lineWidth: 1))
        .overlay(alignment: .top) {
            DesignTokens.Colors.orange.color.frame(height: 3)
        }
        .shadow(
            color: Color(.sRGB, red: 30 / 255, green: 26 / 255, blue: 22 / 255)
                .opacity(0.08),
            radius: 25,
            y: 9
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lp-workbench-main")
    }

    private var explanationCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("選び方の流れ", bundle: .module)
                    .oisintFont(10, .heavy)
                    .foregroundStyle(DesignTokens.Colors.orange.color)
                Spacer()
                Image(systemName: "arrow.down.right")
                    .foregroundStyle(DesignTokens.Colors.orange.color)
                    .accessibilityHidden(true)
            }

            Text("話しながら、\n候補が見えてくる。", bundle: .module)
                .oisintFont(24, .heavy)
                .foregroundStyle(DesignTokens.Colors.text.color)

            Text("候補を並べて終わりではなく、条件を持ち寄るたびに「じゃあ、ここはどう？」が見えてくる。", bundle: .module)
                .oisintFont(11)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)

            DesignTokens.Colors.border.color.frame(height: 1)

            processStep(
                index: "01",
                title: String(localized: "場面から書き込む", bundle: .module),
                text: String(localized: "人数、予算、空気感。うまく言葉にできない条件も、そのままで。", bundle: .module)
            )
            processStep(
                index: "02",
                title: String(localized: "候補の裏側を確かめる", bundle: .module),
                text: String(localized: "公開情報と出典を並べて、良さそうだけで終わらせない。", bundle: .module)
            )
            processStep(
                index: "03",
                title: String(localized: "みんなで「これだね」へ", bundle: .module),
                text: String(localized: "共有した画面で条件を足し、最後は自分たちの判断で決める。", bundle: .module)
            )

            Text("理由を見ながら、ちゃんと決める", bundle: .module)
                .oisintFont(9, .heavy)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .overlay(
                    RoundedRectangle(cornerRadius: 2)
                        .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                )
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(isWideWorkbench ? 28 : 22)
        .background(DesignTokens.Colors.surfaceSoft.color)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lp-workbench-aside")
    }

    private func processStep(index: String, title: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(index)
                .oisintFont(10, .heavy)
                .foregroundStyle(DesignTokens.Colors.orange.color)
                .frame(width: 22, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .oisintFont(12, .heavy)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                Text(text)
                    .oisintFont(10)
                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var searchBox: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField(
                String(localized: "例：池袋で、みんなが話しやすい肉の店を探して", bundle: .module),
                text: Bindable(store).query,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .oisintFont(13)
            .foregroundStyle(DesignTokens.Colors.text.color)
            .frame(minHeight: 48, alignment: .topLeading)
            .accessibilityIdentifier("home-query")

            Button {
                Task { await store.start(app: app) }
            } label: {
                HStack(spacing: 6) {
                    if store.loading {
                        ProgressView()
                            .controlSize(.small)
                            .tint(DesignTokens.Colors.surface.color)
                    }
                    Text("捜査をはじめる ↗", bundle: .module)
                        .oisintFont(12, .heavy)
                        .foregroundStyle(DesignTokens.Colors.surface.color)
                }
                .frame(minWidth: 154, minHeight: 46)
                .padding(.horizontal, 17)
                // hover 時は blackHover（Web の :hover。Mac / iPad ポインタのみ発火 §3.6-5）
                .background(
                    store.canStart
                        ? (startHovering ? DesignTokens.Colors.blackHover.color : DesignTokens.Colors.black.color)
                        : DesignTokens.Colors.border.color
                )
                .clipShape(RoundedRectangle(cornerRadius: 3))
            }
            .buttonStyle(.plain)
            .onHover { startHovering = $0 }
            .disabled(!store.canStart)
            .accessibilityLabel(store.loading ? String(localized: "調査を開始中", bundle: .module) : String(localized: "調査を開始", bundle: .module))
            .accessibilityHint(store.canStart ? String(localized: "入力した条件で候補を探します", bundle: .module) : String(localized: "検索条件を入力すると押せます", bundle: .module))
            .accessibilityIdentifier("home-start")
        }
        .padding(12)
        .background(DesignTokens.Colors.surface.color)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(DesignTokens.Colors.border.color, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("lp-search-box")
    }

    private var identityRow: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("呼ばれる名前", bundle: .module)
                    .oisintFont(11, .bold)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                Text("共有したときに表示されます", bundle: .module)
                    .oisintFont(10)
                    .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            }
            Spacer()
            TextField(String(localized: "表示名（任意）", bundle: .module), text: Bindable(store).localName)
                .textFieldStyle(.plain)
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.text.color)
                .padding(.horizontal, 11)
                .frame(minWidth: 190, maxWidth: 260, minHeight: 38)
                .background(DesignTokens.Colors.surface.color)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                        .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                )
                .accessibilityIdentifier("home-display-name")
        }
        .padding(.top, 3)
    }

    private var examples: some View {
        FlowLayout(spacing: 7) {
            Text("別のシーン：", bundle: .module)
                .oisintFont(10)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            ForEach(HomeStore.exampleQueries, id: \.self) { example in
                Button {
                    store.query = example
                } label: {
                    Text(example)
                        .oisintFont(10, .bold)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(DesignTokens.Colors.chipBg.color)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 2)
    }

    // MARK: - ローカル履歴（計画書 §3.6-3。既存チップ・カード意匠の流用）

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("最近の調査", bundle: .module)
                .oisintFont(16, .bold)
                .foregroundStyle(DesignTokens.Colors.text.color)
            ForEach(app.history) { entry in
                Button {
                    app.openInvestigation(id: entry.investigationId, shareToken: entry.shareToken)
                } label: {
                    HStack {
                        Text(entry.title)
                            .oisintFont(13, .semibold)
                            .foregroundStyle(DesignTokens.Colors.text.color)
                            .lineLimit(1)
                        Spacer()
                        Text("開く ↗", bundle: .module)
                            .oisintFont(11, .bold)
                            .foregroundStyle(DesignTokens.Colors.orange.color)
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 12)
                    .background(DesignTokens.Colors.surface.color)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                            .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("\(entry.title) を開く", bundle: .module))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home-history")
    }
}
