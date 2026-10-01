package com.oisint.android.ui.account

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.oisint.android.auth.AuthState
import com.oisint.android.design.DesignTokens

@Composable
fun AccountScreen(
    viewModel: AccountViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DesignTokens.Colors.bg)
            .verticalScroll(rememberScrollState())
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 16.dp)
            .testTag("account-screen"),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "← 戻る",
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = DesignTokens.Colors.orange,
            modifier = Modifier
                .testTag("account-back")
                .clickable(onClick = onBack)
                .padding(vertical = 18.dp),
        )

        Text("アカウント", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.text)
        Text(
            "匿名で始めた調査を、この端末だけに閉じずに引き継げます。Google接続では現在の匿名ユーザーIDを維持します。",
            fontSize = 12.sp,
            lineHeight = 19.sp,
            color = DesignTokens.Colors.textSecondary,
        )

        when (val authState = state.authState) {
            is AuthState.Authenticated -> AuthenticatedCard(authState, state, viewModel)
            is AuthState.Anonymous -> AuthForm(state, viewModel, isAnonymous = true)
            AuthState.SignedOut -> AuthForm(state, viewModel, isAnonymous = false)
            AuthState.Loading -> CircularProgressIndicator(Modifier.testTag("account-loading"))
            is AuthState.Error ->
                Text(authState.message, color = DesignTokens.Colors.danger, modifier = Modifier.testTag("account-auth-error"))
        }

        state.noticeMessage.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = DesignTokens.Colors.success, modifier = Modifier.testTag("account-notice"))
        }
        state.errorMessage.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = DesignTokens.Colors.danger, modifier = Modifier.testTag("account-error"))
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun AuthenticatedCard(
    authState: AuthState.Authenticated,
    state: AccountUiState,
    viewModel: AccountViewModel,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .testTag("account-authenticated")
            .background(DesignTokens.Colors.surface)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("接続済み", fontWeight = FontWeight.Bold, color = DesignTokens.Colors.success)
        Text(authState.email ?: "認証済みアカウント", color = DesignTokens.Colors.text)
        Text(
            "このアカウントで購入・復元できます。ログアウトするとPlus状態の表示を安全側へ戻します。",
            fontSize = 12.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        OutlinedButton(
            onClick = viewModel::signOut,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("account-sign-out"),
        ) {
            Text("ログアウト")
        }
        AccountDeletionControls(state, viewModel)
    }
}

@Composable
private fun AuthForm(
    state: AccountUiState,
    viewModel: AccountViewModel,
    isAnonymous: Boolean,
) {
    Column(
        Modifier.fillMaxWidth().testTag(if (isAnonymous) "account-anonymous" else "account-signed-out"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (isAnonymous) {
            Text("匿名利用中", fontWeight = FontWeight.Bold, color = DesignTokens.Colors.text)
            Text(
                "Google接続は現在の調査と所有権を引き継ぎます。メールで別アカウントへ入る場合は、誤移転防止のため明示確認が必要です。",
                fontSize = 12.sp,
                lineHeight = 19.sp,
                color = DesignTokens.Colors.textSecondary,
            )
        }
        OutlinedButton(
            onClick = viewModel::connectGoogle,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("account-google"),
        ) {
            Text(if (isAnonymous) "Googleアカウントを接続" else "Googleで続ける")
        }
        Text("メールアドレス", fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
        OutlinedTextField(
            value = state.email,
            onValueChange = viewModel::onEmailChanged,
            singleLine = true,
            enabled = !state.busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth().testTag("account-email"),
        )
        Text("パスワード", fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
        OutlinedTextField(
            value = state.password,
            onValueChange = viewModel::onPasswordChanged,
            singleLine = true,
            enabled = !state.busy,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("account-password"),
        )
        if (isAnonymous) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("account-switch-confirm")) {
                Checkbox(
                    checked = state.confirmAccountSwitch,
                    onCheckedChange = { viewModel.onConfirmAccountSwitchChanged(it) },
                    enabled = !state.busy,
                )
                Text("別のメールアカウントへ切り替えることを確認", fontSize = 12.sp, color = DesignTokens.Colors.textSecondary)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Button(
                onClick = viewModel::signIn,
                enabled = !state.busy,
                modifier = Modifier.weight(1f).testTag("account-sign-in"),
            ) { Text("サインイン") }
            OutlinedButton(
                onClick = viewModel::signUp,
                enabled = !state.busy,
                modifier = Modifier.weight(1f).testTag("account-sign-up"),
            ) { Text("新規登録") }
        }
        if (state.busy) CircularProgressIndicator(Modifier.size(18.dp).testTag("account-busy"), strokeWidth = 2.dp)
        AccountDeletionControls(state, viewModel)
    }
}

@Composable
private fun AccountDeletionControls(
    state: AccountUiState,
    viewModel: AccountViewModel,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("account-deletion")
            .padding(top = 18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("アカウントを完全に削除", fontWeight = FontWeight.Bold, color = DesignTokens.Colors.danger)
        Text(
            "削除すると、このアカウントの個人データとログイン情報を消去します。App Store / Google Play等のサブスクリプションは解約されません。先に各ストアで管理・解約してください。",
            fontSize = 12.sp,
            lineHeight = 18.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        if (state.confirmAccountDeletion) {
            Text(
                "もう一度押すと永久削除を実行します。取り消せません。",
                fontSize = 12.sp,
                color = DesignTokens.Colors.danger,
                modifier = Modifier.testTag("account-delete-confirmation"),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    onClick = viewModel::requestAccountDeletion,
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f).testTag("account-delete-confirm"),
                ) { Text("永久削除を実行") }
                OutlinedButton(
                    onClick = viewModel::cancelAccountDeletion,
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f).testTag("account-delete-cancel"),
                ) { Text("キャンセル") }
            }
        } else {
            OutlinedButton(
                onClick = viewModel::requestAccountDeletion,
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().testTag("account-delete-start"),
            ) { Text("アカウント削除を続ける") }
        }
    }
}
