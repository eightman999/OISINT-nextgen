package com.oisint.android.ui.home

import com.oisint.android.R
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.oisint.android.data.DataProvider
import com.oisint.android.format.Profile
import com.oisint.android.model.CreateInvestigationRequest
import com.oisint.android.model.LocationSearchAnchor
import com.oisint.android.model.LocationSelection
import com.oisint.android.model.RunInvestigationRequest
import com.oisint.android.model.TasteProfile
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicReference

/**
 * Home 画面の状態。正典は `app/index.tsx` の state とハンドラ群
 * （handleStart L193-227 / selectScene L181-185 / toggleChip L187-191）。
 */
data class HomeUiState(
    val query: String = "",
    val displayName: String = "",
    val selectedChips: List<String> = emptyList(),
    val selectedSceneId: String = "",
    val location: LocationSelection? = null,
    val tasteProfile: TasteProfile = TasteProfile(),
    val loading: Boolean = false,
    /** 表示用エラー（string resource ID）。null はエラーなし。 */
    @StringRes val errorMessage: Int? = null,
    /** 作成成功時に一度だけ発火する遷移イベント（id, shareToken） */
    val navigateTo: Pair<String, String>? = null,
) {
    val canStart: Boolean get() = !loading && query.trim().isNotEmpty()
}

class HomeViewModel(private val provider: DataProvider) : ViewModel() {

    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()
    private val createIdempotencyKeyState = CreateIdempotencyKeyState()
    /** 同一Home process内で、現在のcreate/runだけがloadingを所有する。 */
    private val activeStartToken = AtomicReference<Any?>(null)

    fun onQueryChange(value: String) = _uiState.update { it.copy(query = value) }
    fun onDisplayNameChange(value: String) = _uiState.update { it.copy(displayName = value) }
    fun onLocationChange(value: LocationSelection?) = _uiState.update { it.copy(location = value) }
    fun onTasteProfileChange(value: TasteProfile) = _uiState.update { it.copy(tasteProfile = value) }

    /** index.tsx L181-185 selectScene: シーン選択で query を差し替える */
    fun selectScene(sceneId: String, sceneQuery: String) =
        _uiState.update { it.copy(selectedSceneId = sceneId, query = sceneQuery) }

    /** index.tsx L187-191 toggleChip */
    fun toggleChip(chip: String) = _uiState.update { state ->
        val next = if (state.selectedChips.contains(chip)) {
            state.selectedChips - chip
        } else {
            state.selectedChips + chip
        }
        state.copy(selectedChips = next)
    }

    fun onNavigated() = _uiState.update { it.copy(navigateTo = null) }

    /** index.tsx L193-227 handleStart（query 合成 → create → run 投げっぱなし → 遷移） */
    fun handleStart() {
        val state = _uiState.value
        if (state.loading) return
        val name = state.displayName.trim().ifEmpty { "ゲスト" }
        if (state.query.trim().isEmpty()) return

        // UIのdisabledだけに依存せず、同一Looper上の高速二重tapと別threadからの
        // 直接呼び出しを同じ原子guardで拒否する。
        val requestToken = Any()
        if (!activeStartToken.compareAndSet(null, requestToken)) return

        val fullQuery = listOfNotNull(
            Profile.locationToQuery(state.location),
            state.query.trim(),
            *state.selectedChips.toTypedArray(),
            Profile.tasteProfileToQuery(state.tasteProfile),
        ).joinToString(" / ")

        _uiState.update { it.copy(loading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val userId = provider.getUserId()
                val idempotencyKey = createIdempotencyKeyState.keyFor(userId, fullQuery, name)
                val created = provider.createInvestigation(
                    CreateInvestigationRequest(
                        query = fullQuery,
                        displayName = name,
                        userId = userId,
                        idempotencyKey = idempotencyKey,
                        authSubject = userId,
                    ),
                )
                // create応答が返るまでにsubjectが切り替わった場合、旧結果を
                // 新subjectのHomeへ反映しない。live API側のJWT照合とも二重化する。
                if (provider.getUserId() != userId) {
                    createIdempotencyKeyState.clearIfMatches(
                        userId,
                        fullQuery,
                        name,
                        idempotencyKey,
                    )
                    releaseStartIfOwner(requestToken)
                    return@launch
                }
                val current = _uiState.value
                val currentName = current.displayName.trim().ifEmpty { "ゲスト" }
                val currentQuery = listOfNotNull(
                    Profile.locationToQuery(current.location),
                    current.query.trim(),
                    *current.selectedChips.toTypedArray(),
                    Profile.tasteProfileToQuery(current.tasteProfile),
                ).joinToString(" / ")
                if (currentName != name || currentQuery != fullQuery) {
                    createIdempotencyKeyState.clearIfMatches(
                        userId,
                        fullQuery,
                        name,
                        idempotencyKey,
                    )
                    releaseStartIfOwner(requestToken)
                    return@launch
                }
                provider.runInvestigation(
                    RunInvestigationRequest(
                        created.investigationId,
                        searchAnchor = locationSearchAnchor(state.location),
                    ),
                )
                // run完了後もsubject/inputを再確認し、旧responseを新Homeへ採用しない。
                if (provider.getUserId() != userId) {
                    createIdempotencyKeyState.clearIfMatches(
                        userId,
                        fullQuery,
                        name,
                        idempotencyKey,
                    )
                    releaseStartIfOwner(requestToken)
                    return@launch
                }
                val afterRun = _uiState.value
                val afterRunName = afterRun.displayName.trim().ifEmpty { "ゲスト" }
                val afterRunQuery = listOfNotNull(
                    Profile.locationToQuery(afterRun.location),
                    afterRun.query.trim(),
                    *afterRun.selectedChips.toTypedArray(),
                    Profile.tasteProfileToQuery(afterRun.tasteProfile),
                ).joinToString(" / ")
                if (afterRunName != name || afterRunQuery != fullQuery) {
                    createIdempotencyKeyState.clearIfMatches(
                        userId,
                        fullQuery,
                        name,
                        idempotencyKey,
                    )
                    releaseStartIfOwner(requestToken)
                    return@launch
                }
                if (activeStartToken.get() !== requestToken) return@launch
                createIdempotencyKeyState.clearIfMatches(
                    userId,
                    fullQuery,
                    name,
                    idempotencyKey,
                )
                _uiState.update {
                    it.copy(navigateTo = created.investigationId to created.shareToken)
                }
            } catch (_: Exception) {
                if (activeStartToken.get() === requestToken) {
                    _uiState.update {
                        it.copy(errorMessage = R.string.home_start_failed)
                    }
                }
            } finally {
                releaseStartIfOwner(requestToken)
            }
        }
    }

    private fun releaseStartIfOwner(requestToken: Any) {
        if (activeStartToken.compareAndSet(requestToken, null)) {
            _uiState.update { it.copy(loading = false) }
        }
    }
}

/** index.tsx L83-93 locationSearchAnchor: GPS 由来かつ範囲内の座標だけを anchor 化する。 */
private fun locationSearchAnchor(location: LocationSelection?): LocationSearchAnchor? {
    if (location?.source != "gps") return null
    val lat = location.latitude
    val lng = location.longitude
    if (lat == null || !lat.isFinite() || lat < -90 || lat > 90) return null
    if (lng == null || !lng.isFinite() || lng < -180 || lng > 180) return null
    return LocationSearchAnchor(lat, lng)
}
