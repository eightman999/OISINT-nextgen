import SwiftUI

/// app/_layout.tsx 相当のルート（AuthProvider → Stack）。
/// ナビゲーションは AppStore.path（AppRoute）で管理する。
public struct RootScene: View {
    @State private var app: AppStore

    public init(app: AppStore) {
        _app = State(initialValue: app)
    }

    public var body: some View {
        NavigationStack(path: Bindable(app).path) {
            HomeView()
                .navigationDestination(for: AppRoute.self) { route in
                    switch route {
                    case .investigation(let id, let shareToken):
                        InvestigationView(
                            investigationId: id,
                            shareToken: shareToken,
                            provider: app.provider,
                            mode: app.mode
                        )
                    case .join(let token):
                        JoinView(token: token)
                    case .account:
                        AccountView()
                    }
                }
        }
        .environment(app)
        .task {
            await app.bootstrap()
            #if DEBUG
            // UI テスト用の deep link 注入フック（DEBUG のみ。simctl openurl の代替導線）
            if let urlString = ProcessInfo.processInfo.environment["OISINT_TEST_OPEN_URL"],
               let url = URL(string: urlString),
               let route = DeepLink.parse(url) {
                app.path.append(route)
            }
            #endif
        }
        // ダークモード環境でも canon のライト値のまま破綻なく表示する（計画書 §3.6-4。
        // デザイン正典にダークトークンが存在しないため、システム自動反転による未定義配色を出さない）
        .preferredColorScheme(.light)
    }
}

/// app/i/[token].tsx の移植（Phase 7 で完成。プレビュー + 表示名 + 参加）
public struct JoinView: View {
    @Environment(AppStore.self) private var app
    let token: String

    @State private var localName = ""
    @State private var loading = false
    @State private var errorMessage = ""
    @State private var preview: Investigation?

    public init(token: String) {
        self.token = token
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let preview {
                        previewSection(preview)
                    }
                    Text("この調査に参加")
                        .oisintFont(28, .bold)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                        .padding(.bottom, 4)
                    Text("まず候補を見てから、必要なら表示名を設定できます。")
                        .oisintFont(13)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        .padding(.bottom, 8)
                    Text("表示名")
                        .oisintFont(14, .bold)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                    TextField("任意（未入力はゲスト）", text: $localName)
                        .textFieldStyle(.plain)
                        .oisintFont(16)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                        .padding(14)
                        .background(DesignTokens.Colors.surface.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                                .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                        )
                        .accessibilityIdentifier("join-name")
                    Button {
                        Task { await handleJoin() }
                    } label: {
                        HStack(spacing: 6) {
                            if loading {
                                ProgressView()
                                    .controlSize(.small)
                                    .tint(DesignTokens.Colors.surface.color)
                            }
                            Text("参加")
                                .oisintFont(15, .bold)
                                .foregroundStyle(DesignTokens.Colors.surface.color)
                        }
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(loading ? DesignTokens.Colors.border.color : DesignTokens.Colors.orange.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                    }
                    .buttonStyle(.plain)
                    .disabled(loading)
                    .accessibilityLabel(loading ? "調査に参加中" : "調査に参加")
                    .accessibilityIdentifier("join-button")
                    .padding(.top, 8)
                    if !errorMessage.isEmpty {
                        Text(errorMessage)
                            .oisintFont(12)
                            .foregroundStyle(DesignTokens.Colors.danger.color)
                    }
                }
                .frame(maxWidth: 480)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            FooterView()
        }
        .background(DesignTokens.Colors.bg.color)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("join-landing")
        .task {
            preview = await app.provider.getInvestigationByShareToken(token)
        }
    }

    private func previewSection(_ investigation: Investigation) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(investigation.title)
                .oisintFont(22, .bold)
                .foregroundStyle(DesignTokens.Colors.text.color)
                .accessibilityIdentifier("join-context-preview")
            Text("候補を先に確認できます。表示名は投票や条件追加のときに使います。")
                .oisintFont(13)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            VStack(spacing: 10) {
                ForEach(investigation.candidates) { candidate in
                    CandidateCardView(
                        candidate: candidate,
                        members: investigation.members,
                        requirements: investigation.requirements
                    )
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("join-candidates-preview")
            Text("今すぐ決めなくても、候補と根拠を見てから参加できます。")
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                .accessibilityIdentifier("impulse-exit")
        }
        .padding(.bottom, 12)
    }

    private func handleJoin() async {
        loading = true
        errorMessage = ""
        let name = localName.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = name.isEmpty ? "ゲスト" : name
        app.setDisplayName(name)
        do {
            let response = try await app.provider.joinInvestigation(
                JoinInvestigationRequest(shareToken: token, displayName: displayName, userId: app.userId)
            )
            app.recordHistory(
                InvestigationHistoryEntry(
                    investigationId: response.investigationId,
                    shareToken: token,
                    title: response.title,
                    updatedAt: OISINTClock.nowISO()
                )
            )
            app.path.removeAll { route in
                if case .join = route { return true }
                return false
            }
            app.openInvestigation(id: response.investigationId, shareToken: token)
        } catch let error as OISINTError where error.message == "調査が見つかりません" {
            errorMessage = "共有URLが無効か期限切れです。発行した人に新しいURLを依頼してください。"
        } catch let error as OISINTError where error.message.contains("上限") {
            errorMessage = "この調査は参加人数の上限に達しています。発行した人にご相談ください。"
        } catch {
            errorMessage = "共有調査に接続できませんでした。通信状態を確認して、もう一度お試しください。"
        }
        loading = false
    }
}
