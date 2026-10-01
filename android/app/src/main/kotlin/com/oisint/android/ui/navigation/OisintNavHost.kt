package com.oisint.android.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navDeepLink
import com.oisint.android.di.AppContainer
import com.oisint.android.ui.account.AccountScreen
import com.oisint.android.ui.account.AccountViewModel
import com.oisint.android.ui.about.AboutScreen
import com.oisint.android.ui.home.HomeScreen
import com.oisint.android.ui.home.HomeViewModel
import com.oisint.android.ui.investigation.InvestigationScreen
import com.oisint.android.ui.investigation.InvestigationViewModel
import com.oisint.android.ui.join.JoinScreen
import com.oisint.android.ui.join.JoinViewModel
import com.oisint.android.ui.search.SearchScreen
import com.oisint.android.ui.paywall.PaywallScreen
import com.oisint.android.ui.paywall.PaywallViewModel

/**
 * ルート構成。Web の Expo Router 3 ルート（index / investigations/[id] / i/[token]）に対応。
 * join/{token} は https://oisint.com/i/{token} と oisint://i/{token} の deep link を受ける
 * （spec.md L862-864。assetlinks.json 配信は別 Issue）。
 */
object Routes {
    const val HOME = "home"
    /** #308: Home から説明を分離した「選び方の流れ」ページ */
    const val ABOUT = "about"
    /** #308: 条件入力〜捜査開始だけを担う検索ページ */
    const val SEARCH = "search"
    const val PAYWALL = "paywall"
    const val ACCOUNT = "account"
    const val INVESTIGATION = "investigation/{id}?shareToken={shareToken}"
    const val JOIN = "join/{token}"
    fun investigation(id: String, shareToken: String?): String =
        "investigation/$id" + (shareToken?.let { "?shareToken=$it" } ?: "")
}

@Composable
fun OisintNavHost(
    navController: NavHostController,
    container: AppContainer,
    isWide: Boolean = false,
) {
    NavHost(navController = navController, startDestination = Routes.HOME) {
        composable(Routes.HOME) {
            val vm: HomeViewModel = viewModel(
                factory = factory { HomeViewModel(container.dataProvider) },
            )
            HomeScreen(
                viewModel = vm,
                onNavigateToInvestigation = { id, shareToken ->
                    navController.navigate(Routes.investigation(id, shareToken))
                },
                onNavigateToAbout = { navController.navigate(Routes.ABOUT) },
                onNavigateToSearch = { navController.navigate(Routes.SEARCH) },
                onNavigateToPaywall = { navController.navigate(Routes.PAYWALL) },
                onNavigateToAccount = { navController.navigate(Routes.ACCOUNT) },
            )
        }
        composable(Routes.ABOUT) {
            AboutScreen(onBack = { navController.popBackStack() })
        }
        composable(Routes.SEARCH) { entry ->
            // Home と同じ HomeViewModel インスタンスを共有し、場面テンプレートで入れた
            // 条件をそのまま引き継ぐ（別インスタンスにすると入力が分断される）
            val homeEntry = remember(entry) { navController.getBackStackEntry(Routes.HOME) }
            val vm: HomeViewModel = viewModel(
                viewModelStoreOwner = homeEntry,
                factory = factory { HomeViewModel(container.dataProvider) },
            )
            SearchScreen(
                viewModel = vm,
                onBack = { navController.popBackStack() },
                onNavigateToInvestigation = { id, shareToken ->
                    navController.navigate(Routes.investigation(id, shareToken))
                },
            )
        }
        composable(Routes.PAYWALL) {
            val vm: PaywallViewModel = viewModel(
                factory = factory { PaywallViewModel(container.entitlementProvider) },
            )
            PaywallScreen(
                vm,
                onBack = { navController.popBackStack() },
                onNavigateToAccount = { navController.navigate(Routes.ACCOUNT) },
            )
        }
        composable(Routes.ACCOUNT) {
            val vm: AccountViewModel = viewModel(
                factory = factory { AccountViewModel(container.authController) },
            )
            AccountScreen(vm, onBack = { navController.popBackStack() })
        }
        composable(Routes.INVESTIGATION) { backStackEntry ->
            val id = backStackEntry.arguments?.getString("id")
            val shareToken = backStackEntry.arguments?.getString("shareToken")
            val vm: InvestigationViewModel = viewModel(
                key = "investigation-$id",
                factory = factory { InvestigationViewModel(container.dataProvider, id) },
            )
            InvestigationScreen(viewModel = vm, shareToken = shareToken, isWide = isWide)
        }
        composable(
            route = Routes.JOIN,
            deepLinks = listOf(
                navDeepLink { uriPattern = "https://oisint.com/i/{token}" },
                navDeepLink { uriPattern = "oisint://i/{token}" },
            ),
        ) { backStackEntry ->
            val token = backStackEntry.arguments?.getString("token")
            val vm: JoinViewModel = viewModel(
                key = "join-$token",
                factory = factory {
                    JoinViewModel(
                        container.dataProvider,
                        token,
                        container.previewInvestigationByShareToken,
                    )
                },
            )
            JoinScreen(
                viewModel = vm,
                onNavigateToInvestigation = { id, shareToken ->
                    navController.navigate(Routes.investigation(id, shareToken))
                },
            )
        }
    }
}

private inline fun <reified VM : ViewModel> factory(
    crossinline create: () -> VM,
): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = create() as T
}
