import Foundation
import Supabase

/// Realtime 購読（spec.md §20 / live.ts subscribeInvestigation L371-482 の移植）。
/// channel `investigation:<id>` に 7 購読（全て event *）を張り、変更イベントを
/// 300ms debounce で refetch にまとめる。セッション確立後に subscribe する
/// （先に subscribe すると RLS 付き Postgres Changes が anon として拒否される）。
final class InvestigationSubscription: @unchecked Sendable {
    private let client: SupabaseClient
    private let investigationId: String
    private var channel: RealtimeChannelV2?
    private var subscriptions: [RealtimeSubscription] = []
    private var debounceTask: Task<Void, Never>?
    private var setupTask: Task<Void, Never>?
    private var disposed = false
    private let lock = NSLock()

    init(
        client: SupabaseClient,
        investigationId: String,
        ensureSession: @escaping @Sendable () async throws -> Void,
        refetch: @escaping @Sendable () async -> Void
    ) {
        self.client = client
        self.investigationId = investigationId

        setupTask = Task { [weak self] in
            do {
                // 認証済みセッションを確立してから Realtime を購読する（live.ts のコメント逐語準拠）
                try await ensureSession()
                guard let self, !self.isDisposed else { return }

                let channel = client.realtimeV2.channel("investigation:\(investigationId)")
                let onChange: @Sendable (AnyAction) -> Void = { [weak self] _ in
                    self?.scheduleRefetch(refetch)
                }
                // 7 購読（live.ts と同一の table / filter。evidence のみ filter 無し）
                var tokens: [RealtimeSubscription] = []
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "investigations", filter: "id=eq.\(investigationId)", callback: onChange))
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "evidence", callback: onChange))
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "requirement_evaluations", filter: "investigation_id=eq.\(investigationId)", callback: onChange))
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "candidates", filter: "investigation_id=eq.\(investigationId)", callback: onChange))
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "requirements", filter: "investigation_id=eq.\(investigationId)", callback: onChange))
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "votes", filter: "investigation_id=eq.\(investigationId)", callback: onChange))
                tokens.append(channel.onPostgresChange(AnyAction.self, schema: "public", table: "investigation_events", filter: "investigation_id=eq.\(investigationId)", callback: onChange))

                self.store(channel: channel, tokens: tokens)
                try await channel.subscribeWithError()
                // 初期データ取得（live.ts: subscribe 直後に refetch()）
                self.scheduleRefetch(refetch)
            } catch {
                // 認証障害の詳細は UI へ漏らさない。Store 側の再試行導線に任せる（live.ts と同値）
            }
        }
    }

    private var isDisposed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return disposed
    }

    private func store(channel: RealtimeChannelV2, tokens: [RealtimeSubscription]) {
        lock.lock()
        defer { lock.unlock() }
        self.channel = channel
        self.subscriptions = tokens
    }

    /// live.ts refetch: 変更イベントが連続で届くため 300ms debounce でまとめて再取得
    private func scheduleRefetch(_ refetch: @escaping @Sendable () async -> Void) {
        lock.lock()
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, self?.isDisposed == false else { return }
            await refetch()
        }
        lock.unlock()
    }

    /// live.ts の unsubscribe クロージャ相当
    func cancel() {
        lock.lock()
        disposed = true
        let channelToRemove = channel
        channel = nil
        subscriptions.removeAll()
        debounceTask?.cancel()
        setupTask?.cancel()
        lock.unlock()
        if let channelToRemove {
            let client = self.client
            Task { await client.realtimeV2.removeChannel(channelToRemove) }
        }
    }
}
