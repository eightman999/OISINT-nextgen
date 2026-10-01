package com.oisint.android.ui.account

import com.oisint.android.R
import androidx.compose.ui.res.stringResource
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
            stringResource(R.string.common_back),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            color = DesignTokens.Colors.orange,
            modifier = Modifier
                .testTag("account-back")
                .clickable(onClick = onBack)
                .padding(vertical = 18.dp),
        )

        Text(stringResource(R.string.account_title), fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = DesignTokens.Colors.text)
        Text(
            stringResource(R.string.account_intro),
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
                Text(stringResource(authState.messageRes), color = DesignTokens.Colors.danger, modifier = Modifier.testTag("account-auth-error"))
        }

        state.noticeMessage?.let {
            Text(stringResource(it), color = DesignTokens.Colors.success, modifier = Modifier.testTag("account-notice"))
        }
        state.errorMessage?.let {
            Text(stringResource(it), color = DesignTokens.Colors.danger, modifier = Modifier.testTag("account-error"))
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
        Text(stringResource(R.string.account_connected), fontWeight = FontWeight.Bold, color = DesignTokens.Colors.success)
        Text(authState.email ?: stringResource(R.string.account_authenticated_fallback), color = DesignTokens.Colors.text)
        Text(
            stringResource(R.string.account_authenticated_body),
            fontSize = 12.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        OutlinedButton(
            onClick = viewModel::signOut,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("account-sign-out"),
        ) {
            Text(stringResource(R.string.account_sign_out))
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
            Text(stringResource(R.string.account_anonymous_title), fontWeight = FontWeight.Bold, color = DesignTokens.Colors.text)
            Text(
                stringResource(R.string.account_anonymous_body),
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
            Text(stringResource(if (isAnonymous) R.string.account_connect_google else R.string.account_continue_google))
        }
        Text(stringResource(R.string.account_email_label), fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
        OutlinedTextField(
            value = state.email,
            onValueChange = viewModel::onEmailChanged,
            singleLine = true,
            enabled = !state.busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth().testTag("account-email"),
        )
        Text(stringResource(R.string.account_password_label), fontSize = 11.sp, color = DesignTokens.Colors.textSecondary)
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
                Text(stringResource(R.string.account_switch_confirm), fontSize = 12.sp, color = DesignTokens.Colors.textSecondary)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Button(
                onClick = viewModel::signIn,
                enabled = !state.busy,
                modifier = Modifier.weight(1f).testTag("account-sign-in"),
            ) { Text(stringResource(R.string.account_sign_in)) }
            OutlinedButton(
                onClick = viewModel::signUp,
                enabled = !state.busy,
                modifier = Modifier.weight(1f).testTag("account-sign-up"),
            ) { Text(stringResource(R.string.account_sign_up)) }
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
        Text(stringResource(R.string.account_delete_title), fontWeight = FontWeight.Bold, color = DesignTokens.Colors.danger)
        Text(
            stringResource(R.string.account_delete_body),
            fontSize = 12.sp,
            lineHeight = 18.sp,
            color = DesignTokens.Colors.textSecondary,
        )
        if (state.confirmAccountDeletion) {
            Text(
                stringResource(R.string.account_delete_confirmation),
                fontSize = 12.sp,
                color = DesignTokens.Colors.danger,
                modifier = Modifier.testTag("account-delete-confirmation"),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    onClick = viewModel::requestAccountDeletion,
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f).testTag("account-delete-confirm"),
                ) { Text(stringResource(R.string.account_delete_execute)) }
                OutlinedButton(
                    onClick = viewModel::cancelAccountDeletion,
                    enabled = !state.busy,
                    modifier = Modifier.weight(1f).testTag("account-delete-cancel"),
                ) { Text(stringResource(R.string.common_cancel)) }
            }
        } else {
            OutlinedButton(
                onClick = viewModel::requestAccountDeletion,
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth().testTag("account-delete-start"),
            ) { Text(stringResource(R.string.account_delete_continue)) }
        }
    }
}
