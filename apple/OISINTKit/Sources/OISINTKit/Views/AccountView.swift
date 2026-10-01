import SwiftUI

/// Web/Androidと同じ認証境界を使うアカウント管理画面。
/// 認証・課金の状態はAppStoreだけが所有し、表示はsubject切替時にfail-closedになる。
public struct AccountView: View {
    @Environment(AppStore.self) private var app
    @State private var email = ""
    @State private var password = ""
    @State private var passwordConfirmation = ""
    @State private var isRegistering = false
    @State private var confirmAccountSwitch = false
    @State private var confirmDeletion = false

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("アカウント")
                    .oisintFont(28, .bold)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                Text("ログイン、アカウントの切替、ログアウト、永久削除をここで管理します。")
                    .oisintFont(13)
                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)

                if app.isAuthenticated {
                    authenticatedSection
                } else {
                    if app.isAnonymous {
                        Text("匿名利用中。メールでログイン・新規登録する場合は別アカウントになります。現在の調査履歴は引き継がれません。")
                            .oisintFont(13)
                            .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                    }
                    authenticationForm
                }

                if app.isAnonymous || app.isAuthenticated {
                    deletionSection
                }

                if let message = app.authErrorMessage, !message.isEmpty {
                    Text(message)
                        .oisintFont(12)
                        .foregroundStyle(DesignTokens.Colors.danger.color)
                        .accessibilityIdentifier("account-auth-error")
                }
                if let message = app.authNoticeMessage, !message.isEmpty {
                    Text(message)
                        .oisintFont(13)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                        .accessibilityIdentifier("account-auth-notice")
                }
                if let message = app.entitlementErrorMessage, !message.isEmpty {
                    Text(message)
                        .oisintFont(12)
                        .foregroundStyle(DesignTokens.Colors.orange.color)
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(DesignTokens.Colors.bg.color)
        .navigationTitle("アカウント")
        .accessibilityIdentifier("account-screen")
        .onChange(of: isRegistering) { _, _ in
            password = ""
            passwordConfirmation = ""
        }
        .onChange(of: app.isAuthenticated) { _, authenticated in
            if authenticated {
                password = ""
                passwordConfirmation = ""
            }
        }
    }

    private var authenticatedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("接続済み")
                .oisintFont(15, .bold)
                .foregroundStyle(DesignTokens.Colors.success.color)
            Text(app.authEmail ?? "恒久アカウント")
                .oisintFont(14)
                .foregroundStyle(DesignTokens.Colors.text.color)
            Text("ログアウトすると、表示中のPlus状態も安全側へ戻ります。")
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            Button("ログアウト") {
                Task { await app.signOut() }
            }
            .buttonStyle(.bordered)
            .disabled(app.authBusy)
            .accessibilityIdentifier("account-sign-out")
        }
    }

    private var authenticationForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button("Googleアカウントで続ける") {
                Task { await app.signInWithGoogle() }
            }
            .buttonStyle(.borderedProminent)
            .disabled(app.authBusy)
            .accessibilityIdentifier("account-google")

            Picker("メール認証", selection: $isRegistering) {
                Text("ログイン").tag(false)
                Text("新規登録").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(app.authBusy)
            .accessibilityIdentifier("account-email-mode")

            Text(isRegistering
                ? "メールアドレスを確認して、OISINTアカウントを作成します。"
                : "登録済みのOISINTアカウントのメールアドレスとパスワードでログインできます。")
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            TextField("メールアドレス", text: $email)
                .textFieldStyle(.roundedBorder)
                .textContentType(.username)
                #if os(iOS)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                #endif
                .disabled(app.authBusy)
                .accessibilityIdentifier("account-email")
            SecureField("パスワード", text: $password)
                .textFieldStyle(.roundedBorder)
                .textContentType(isRegistering ? .newPassword : .password)
                .disabled(app.authBusy)
                .accessibilityIdentifier("account-password")

            if isRegistering {
                Text("12文字以上で、英大文字・英小文字・数字を含めてください。")
                    .oisintFont(12)
                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                SecureField("パスワード（確認）", text: $passwordConfirmation)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.newPassword)
                    .disabled(app.authBusy)
                    .accessibilityIdentifier("account-password-confirmation")
                if !passwordConfirmation.isEmpty, let validationMessage = registrationValidationMessage {
                    Text(validationMessage)
                        .oisintFont(12)
                        .foregroundStyle(DesignTokens.Colors.danger.color)
                }
            }

            if app.isAnonymous {
                Toggle("別のメールアカウントへ切り替えることを確認", isOn: $confirmAccountSwitch)
                    .font(.caption)
                    .accessibilityIdentifier("account-switch-confirm")
            }

            if isRegistering {
                Button("新規登録して確認メールを送る") {
                    Task {
                        let accepted = await app.signUpWithEmail(
                            email: email, password: password, confirmAccountSwitch: confirmAccountSwitch
                        )
                        password = ""
                        passwordConfirmation = ""
                        if accepted { isRegistering = false }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(app.authBusy || registrationValidationMessage != nil || (app.isAnonymous && !confirmAccountSwitch))
                .accessibilityIdentifier("account-email-signup")
                HStack {
                    Link("利用規約", destination: URL(string: "https://oisint.com/terms")!)
                    Link("プライバシーポリシー", destination: URL(string: "https://oisint.com/privacy")!)
                }
                .font(.caption)
            } else {
                Button("メールでログイン") {
                    Task {
                        await app.signInWithEmail(
                            email: email,
                            password: password,
                            confirmAccountSwitch: confirmAccountSwitch
                        )
                        password = ""
                    }
                }
                .buttonStyle(.bordered)
                .disabled(app.authBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)
                .accessibilityIdentifier("account-email-login")
                Button("確認メールを再送") {
                    Task { await app.resendSignUpConfirmation(email: email) }
                }
                .disabled(app.authBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("account-email-resend")
            }
        }
    }

    private var registrationValidationMessage: String? {
        EmailRegistrationValidation.message(email: email, password: password, confirmation: passwordConfirmation)
    }

    private var deletionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("アカウントを完全に削除")
                .oisintFont(15, .bold)
                .foregroundStyle(DesignTokens.Colors.danger.color)
            Text("削除すると個人データとログイン情報を消去します。App Store / Google Play等のサブスクリプションは解約されません。先に各ストアで管理・解約してください。")
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            if confirmDeletion {
                Text("もう一度押すと永久削除を実行します。取り消せません。")
                    .oisintFont(12)
                    .foregroundStyle(DesignTokens.Colors.danger.color)
                    .accessibilityIdentifier("account-delete-confirmation")
                HStack {
                    Button("永久削除を実行") {
                        Task { await app.deleteAccount() }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(DesignTokens.Colors.danger.color)
                    .disabled(app.authBusy)
                    .accessibilityIdentifier("account-delete-confirm")
                    Button("キャンセル") {
                        confirmDeletion = false
                    }
                    .buttonStyle(.bordered)
                    .disabled(app.authBusy)
                    .accessibilityIdentifier("account-delete-cancel")
                }
            } else {
                Button("アカウント削除を続ける") {
                    confirmDeletion = true
                }
                .buttonStyle(.bordered)
                .disabled(app.authBusy)
                .accessibilityIdentifier("account-delete-start")
            }
        }
        .padding(.top, 12)
        .accessibilityIdentifier("account-deletion")
    }
}
