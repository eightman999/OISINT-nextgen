package com.oisint.android.data.live

import com.oisint.android.data.InvestigationListener
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.realtime.PostgresAction
import io.github.jan.supabase.realtime.channel
import io.github.jan.supabase.realtime.postgresChangeFlow
import io.github.jan.supabase.realtime.realtime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch

/**
 * Realtime 購読（live.ts L371-482 subscribeInvestigation の移植）。
 * - channel 名 `investigation:{id}`
 * - postgres_changes を 7 テーブルに購読:
 *   investigations は `id=eq.{id}`、evidence のみ filter 無し
 *   （shared evidence に investigation_id が無いため）、他 5 テーブルは `investigation_id=eq.{id}`
 * - イベント受信ごとに 300ms debounce で全再取得（差分適用はしない）
 */
class RealtimeSubscriber(
    private val client: SupabaseClient,
    private val assembler: InvestigationAssembler,
    private val scope: CoroutineScope,
) {

    fun subscribe(investigationId: String, listener: InvestigationListener): () -> Unit {
        val channel = client.channel("investigation:$investigationId")
        var refetchJob: Job? = null
        var disposed = false

        // live.ts L379-390: 300ms debounce で全再取得。一時的な取得失敗は無視
        val refetch: () -> Unit = {
            refetchJob?.cancel()
            refetchJob = scope.launch {
                delay(300)
                try {
                    val investigation = assembler.fetch(investigationId)
                    if (!disposed && investigation != null) listener(investigation)
                } catch (_: Exception) {
                    // 次のイベントでリカバリ（live.ts L386-388）
                }
            }
        }

        val filtered = listOf(
            "requirement_evaluations",
            "candidates",
            "requirements",
            "votes",
            "investigation_events",
        ).map { table ->
            channel.postgresChangeFlow<PostgresAction>(schema = "public") {
                this.table = table
                filter("investigation_id", io.github.jan.supabase.postgrest.query.filter.FilterOperator.EQ, investigationId)
            }
        }
        val invFlow = channel.postgresChangeFlow<PostgresAction>(schema = "public") {
            table = "investigations"
            filter("id", io.github.jan.supabase.postgrest.query.filter.FilterOperator.EQ, investigationId)
        }
        val evidenceFlow = channel.postgresChangeFlow<PostgresAction>(schema = "public") {
            table = "evidence"
            // filter 無し（live.ts L413-420 のコメント: shared evidence は investigation_id を持たない）
        }

        val listenJob = merge(invFlow, evidenceFlow, *filtered.toTypedArray())
            .onEach { refetch() }
            .launchIn(scope)

        val subscribeJob = scope.launch {
            try {
                channel.subscribe()
            } catch (_: Exception) {
                // 購読確立の失敗は初期取得側でカバーされる（Realtime はベストエフォート）
            }
        }

        // live.ts L477-481: dispose で timer / channel を破棄
        return {
            disposed = true
            refetchJob?.cancel()
            listenJob.cancel()
            subscribeJob.cancel()
            scope.launch {
                try {
                    client.realtime.removeChannel(channel)
                } catch (_: Exception) {
                    // already removed
                }
            }
        }
    }
}
