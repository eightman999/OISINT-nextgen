import SwiftUI

private struct LegalDestination: Identifiable {
    let id: String
    let label: String
    let url: String
}

private let legalDestinations = [
    LegalDestination(id: "terms", label: String(localized: "利用規約", bundle: .module), url: "https://oisint.com/terms"),
    LegalDestination(id: "privacy", label: String(localized: "プライバシー", bundle: .module), url: "https://oisint.com/privacy"),
    LegalDestination(id: "commercial", label: String(localized: "特商法表記", bundle: .module), url: "https://oisint.com/commercial-transactions"),
    LegalDestination(id: "refund", label: String(localized: "解約・返金案内", bundle: .module), url: "https://oisint.com/support"),
    LegalDestination(id: "support", label: String(localized: "サポート", bundle: .module), url: "https://oisint.com/support"),
]

/// RevenueCat固有型をUIへ持ち込まないPlus購入/復元画面。
public struct PlusPaywallView: View {
    @Environment(AppStore.self) private var app
    @State private var packages: [PlusPackage] = []
    @State private var message = ""
    @State private var busy = false

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("OISINT Plus")
                    .oisintFont(28, .bold)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                Text(app.entitlementProvider.currentStatus.isPlus
                    ? String(localized: "Plusが有効です。期限や更新状態は購入元で確認できます。", bundle: .module)
                    : String(localized: "調査の準備をより快適にする追加プランです。", bundle: .module))
                    .oisintFont(14)
                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)

                if !app.isAuthenticated {
                    Text("購入・復元には恒久アカウントの接続が必要です。", bundle: .module)
                        .oisintFont(13, .bold)
                        .foregroundStyle(DesignTokens.Colors.orange.color)
                    Button(String(localized: "Googleアカウントを接続", bundle: .module)) {
                        Task { await app.signInWithGoogle() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(app.authBusy)
                    NavigationLink(String(localized: "メールでログイン", bundle: .module)) {
                        AccountView()
                    }
                    .buttonStyle(.bordered)
                    .disabled(app.authBusy)
                    .accessibilityIdentifier("plus-email-login")
                    if let authError = app.authErrorMessage {
                        Text(authError)
                            .oisintFont(12)
                            .foregroundStyle(DesignTokens.Colors.danger.color)
                    }
                    if let entitlementError = app.entitlementErrorMessage {
                        Text(entitlementError)
                            .oisintFont(12)
                            .foregroundStyle(DesignTokens.Colors.danger.color)
                    }
                } else if app.authBusy {
                    ProgressView(String(localized: "購入アカウントを確認しています…", bundle: .module))
                } else if packages.isEmpty {
                    Text("購入プランを読み込めませんでした。設定と通信状態を確認してください。", bundle: .module)
                        .oisintFont(13)
                        .foregroundStyle(DesignTokens.Colors.danger.color)
                } else {
                    ForEach(packages) { package in
                        Button {
                            Task { await purchase(package) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(package.displayName)
                                        .oisintFont(15, .bold)
                                    Text("\(package.priceString) / \(package.period)")
                                        .oisintFont(13)
                                }
                                Spacer()
                                Text("購入", bundle: .module)
                                    .oisintFont(13, .bold)
                            }
                            .foregroundStyle(DesignTokens.Colors.text.color)
                            .padding(16)
                            .background(DesignTokens.Colors.surface.color)
                            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                            .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                                .stroke(DesignTokens.Colors.border.color, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(busy || offeringsUserID == nil)
                    }
                }

                if app.isAuthenticated {
                    Button(String(localized: "購入を復元", bundle: .module)) {
                        Task { await restore() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy || offeringsUserID == nil)
                    .accessibilityIdentifier("plus-restore")
                    if let entitlementError = app.entitlementErrorMessage {
                        Text(entitlementError)
                            .oisintFont(12)
                            .foregroundStyle(DesignTokens.Colors.danger.color)
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("購入前に確認すること", bundle: .module)
                        .oisintFont(13, .bold)
                    Text("価格・契約期間・更新・解約・返金条件は、購入元と下記の案内を確認してください。アカウント削除はストア定期購入の解約ではありません。", bundle: .module)
                        .oisintFont(11)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                    HStack(spacing: 12) {
                        ForEach(legalDestinations) { destination in
                            if let url = URL(string: destination.url) {
                                Link(destination.label, destination: url)
                                    .font(.system(size: 11, weight: .semibold))
                                    .accessibilityIdentifier("plus-legal-\(destination.id)")
                            }
                        }
                    }
                }
                .padding(14)
                .background(DesignTokens.Colors.surface.color)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                .overlay(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                    .stroke(DesignTokens.Colors.border.color, lineWidth: 1))

                if !message.isEmpty {
                    Text(message)
                        .oisintFont(13)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(DesignTokens.Colors.bg.color)
        .navigationTitle("Plus")
        .task(id: offeringsUserID) { await loadOfferings() }
    }

    // RevenueCatへのログイン完了後に取得し、アカウント切替時も再取得する。
    private var offeringsUserID: String? {
        app.entitlementUserID
    }

    private func loadOfferings() async {
        packages = []
        message = ""
        guard let userID = offeringsUserID else { return }
        do {
            let loadedPackages = try await app.entitlementProvider.offerings()
            guard !Task.isCancelled, offeringsUserID == userID else { return }
            packages = loadedPackages
            try await app.entitlementProvider.refresh()
        } catch {
            guard !Task.isCancelled, offeringsUserID == userID else { return }
            message = String(localized: "購入プランを確認できませんでした。", bundle: .module)
        }
    }

    private func purchase(_ package: PlusPackage) async {
        guard offeringsUserID != nil else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await app.entitlementProvider.purchase(package)
            message = String(localized: "購入状態を確認しました。", bundle: .module)
        } catch let error as EntitlementError {
            message = error.localizedDescription
        } catch {
            message = String(localized: "購入状態を確認できませんでした。", bundle: .module)
        }
    }

    private func restore() async {
        guard offeringsUserID != nil else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await app.entitlementProvider.restore()
            message = String(localized: "復元状態を確認しました。", bundle: .module)
        } catch let error as EntitlementError {
            message = error.localizedDescription
        } catch {
            message = String(localized: "復元状態を確認できませんでした。", bundle: .module)
        }
    }
}
