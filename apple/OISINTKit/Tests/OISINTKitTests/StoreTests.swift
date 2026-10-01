import Foundation
import Testing
@testable import OISINTKit
import OISINTKitDebugFixtures

/// Stores の単体テスト（Phase 3 完了条件: 作成→進捗→候補3件、Phase 5: rerank トリガと debounce）
@MainActor
@Suite struct StoreTests {
    final class TimeoutThenSuccessProvider: DataProvider, @unchecked Sendable {
        let delegate: MockProvider
        let subject: String
        var createRequests: [CreateInvestigationRequest] = []
        private var shouldTimeout = true

        init(delegate: MockProvider, subject: String) {
            self.delegate = delegate
            self.subject = subject
        }

        func createInvestigation(_ request: CreateInvestigationRequest) async throws -> CreateInvestigationResponse {
            createRequests.append(request)
            if shouldTimeout {
                shouldTimeout = false
                throw OISINTError("timeout")
            }
            return try await delegate.createInvestigation(request)
        }

        func runInvestigation(_ request: RunInvestigationRequest) async throws -> RunInvestigationResponse {
            try await delegate.runInvestigation(request)
        }

        func rerankInvestigation(_ request: RerankInvestigationRequest) async throws -> RerankInvestigationResponse {
            try await delegate.rerankInvestigation(request)
        }

        func joinInvestigation(_ request: JoinInvestigationRequest) async throws -> JoinInvestigationResponse {
            try await delegate.joinInvestigation(request)
        }

        func getInvestigation(id: String) async throws -> Investigation? {
            try await delegate.getInvestigation(id: id)
        }

        func subscribeInvestigation(id: String, listener: @escaping InvestigationListener) async -> UnsubscribeHandle {
            await delegate.subscribeInvestigation(id: id, listener: listener)
        }

        func setVote(investigationId: String, candidateId: String, value: VoteValue) async throws {
            try await delegate.setVote(investigationId: investigationId, candidateId: candidateId, value: value)
        }

        func addRequirement(investigationId: String, text: String) async throws {
            try await delegate.addRequirement(investigationId: investigationId, text: text)
        }

        func getUserId() async throws -> String { subject }

        func getInvestigationByShareToken(_ shareToken: String) async -> Investigation? {
            await delegate.getInvestigationByShareToken(shareToken)
        }
    }

    func makeApp(provider: any DataProvider = MockProvider(stepInterval: .milliseconds(30))) -> AppStore {
        let defaults = UserDefaults(suiteName: "test-\(UUID().uuidString)")!
        return AppStore(provider: provider, mode: .mock, defaults: defaults)
    }

    @Test func homeStoreTimeoutThenBootstrapRetryReusesKeyForSameSubject() async throws {
        let provider = TimeoutThenSuccessProvider(
            delegate: MockProvider(stepInterval: .milliseconds(30)),
            subject: "bootstrap-user"
        )
        let app = makeApp(provider: provider)
        await app.bootstrap()
        let store = HomeStore()
        store.query = "池袋で3人。肉。"
        store.localName = "まさ"

        await store.start(app: app)
        #expect(provider.createRequests.count == 1)
        #expect(store.loading == false)
        #expect(app.path.isEmpty)

        await store.start(app: app)
        #expect(provider.createRequests.count == 2)
        #expect(provider.createRequests[0].idempotencyKey == provider.createRequests[1].idempotencyKey)
        #expect(provider.createRequests.allSatisfy { $0.authSubject == "bootstrap-user" })
        #expect(store.loading == false)
        #expect(app.path.count == 1)
    }

    @Test func homeStoreStartCreatesRunsAndNavigates() async throws {
        let app = makeApp()
        await app.bootstrap()
        let store = HomeStore()
        store.query = "池袋で3人。3000円くらい。肉。カード可。静かめ。"
        store.localName = "まさくん"

        await store.start(app: app)

        #expect(store.errorMessage.isEmpty)
        #expect(app.path.count == 1)
        guard case .investigation(let id, let shareToken) = app.path.first else {
            Issue.record("investigation 遷移になっていない")
            return
        }
        #expect(UUID(uuidString: id) != nil)
        #expect(shareToken?.count == 32)
        // ローカル履歴に記録される（§3.6-3）
        #expect(app.history.count == 1)
        #expect(app.history.first?.investigationId == id)
        // 表示名が保存される
        #expect(app.displayName == "まさくん")
    }

    @Test func homeStoreEmptyQueryDoesNothing() async {
        let app = makeApp()
        let store = HomeStore()
        store.query = "   "
        await store.start(app: app)
        #expect(app.path.isEmpty)
    }

    @Test func investigationStoreLoadsAndReceivesProgress() async throws {
        let provider = MockProvider(stepInterval: .milliseconds(30))
        let app = makeApp(provider: provider)
        await app.bootstrap()

        let created = try await provider.createInvestigation(
            CreateInvestigationRequest(query: "テスト調査", displayName: "まさくん", userId: app.userId, idempotencyKey: "store-test-1", authSubject: app.userId ?? "mock-user")
        )
        let store = InvestigationStore(
            investigationId: created.investigationId,
            shareToken: created.shareToken,
            provider: provider,
            mode: .mock
        )
        await store.load()
        #expect(store.loading == false)
        #expect(store.investigation?.id == created.investigationId)

        _ = try await provider.runInvestigation(RunInvestigationRequest(investigationId: created.investigationId))

        // mock の 800ms 相当（30ms×5 遷移）を listener 経由で受けて complete + 候補 3 件になるまで待つ
        for _ in 0..<100 {
            if store.investigation?.status == .complete { break }
            try await Task.sleep(for: .milliseconds(30))
        }
        #expect(store.investigation?.status == .complete)
        #expect(store.investigation?.candidates.count == 3)
        // 候補が来たら先頭を自動選択（[id].tsx の挙動）
        #expect(store.selectedCandidateId == store.investigation?.candidates.first?.id)
        store.unsubscribe()
    }

    @Test func investigationStoreShareUrl() {
        let provider = MockProvider()
        let withToken = InvestigationStore(
            investigationId: "inv-001",
            shareToken: "0123456789abcdef0123456789abcdef",
            provider: provider,
            mode: .mock
        )
        #expect(withToken.shareUrl == "https://oisint.com/i/0123456789abcdef0123456789abcdef")
        let withoutToken = InvestigationStore(investigationId: "inv-001", shareToken: nil, provider: provider, mode: .mock)
        #expect(withoutToken.shareUrl == "https://oisint.com/investigations/inv-001")
    }

    @Test func voteDebounceCollapsesRapidVotesIntoOneRerank() async throws {
        // §25.3: vote → 500ms debounce。連打で 1 回に集約されることを順位変化で検証
        let provider = MockProvider()
        let app = makeApp(provider: provider)
        await app.bootstrap()

        let store = InvestigationStore(
            investigationId: "inv-001",
            shareToken: nil,
            provider: provider,
            mode: .mock,
            voteDebounce: .milliseconds(80)
        )
        await store.load()
        #expect(store.investigation?.candidates.map(\.id) == ["c-1", "c-2", "c-3"])

        // 自ユーザーで c-3 に 3 連打（up → down → up。最後は up が有効）
        let userId = try await provider.getUserId()
        store.handleVote(candidateId: "c-3", value: .up, userId: userId)
        store.handleVote(candidateId: "c-3", value: .down, userId: userId)
        store.handleVote(candidateId: "c-3", value: .up, userId: userId)

        // debounce 経過 + rerank 完了を待つ
        try await Task.sleep(for: .milliseconds(400))

        let after = try await provider.getInvestigation(id: "inv-001")
        // c-3 の合計: -1+1+1+1(自分) = 2、c-1: 2、c-2: -1 → 安定ソートで [c-1, c-3, c-2]
        #expect(after?.candidates.map(\.id) == ["c-1", "c-3", "c-2"], "vote 連打が 1 回の rerank に集約され順位が更新される")
        store.unsubscribe()
    }

    @Test func addRequirementTriggersImmediateRerank() async throws {
        // §25.3: requirement 追加 → 即時 rerank(trigger: requirement_added)
        let provider = MockProvider()
        let app = makeApp(provider: provider)
        await app.bootstrap()
        let userId = try await provider.getUserId()

        // 自ユーザーが owner の調査を作る（inv-001 は権限が無いため）
        let created = try await provider.createInvestigation(
            CreateInvestigationRequest(query: "q", displayName: "自分", userId: userId, idempotencyKey: "store-test-2", authSubject: userId)
        )
        let store = InvestigationStore(
            investigationId: created.investigationId,
            shareToken: created.shareToken,
            provider: provider,
            mode: .mock
        )
        await store.load()
        store.newRequirement = "個室"
        await store.handleAddRequirement(userId: userId)

        #expect(store.actionError.isEmpty)
        #expect(store.newRequirement.isEmpty)
        #expect(store.adding == false)
        let after = try await provider.getInvestigation(id: created.investigationId)
        #expect(after?.requirements.count == 6)
        // rerank は complete 前なので reranked: false で返るがエラーにしない（[id].tsx と同値）
    }

    @Test func addRequirementWithoutUserIdSetsPermissionError() async {
        let provider = MockProvider()
        let store = InvestigationStore(investigationId: "inv-001", shareToken: nil, provider: provider, mode: .mock)
        await store.load()
        store.newRequirement = "個室"
        await store.handleAddRequirement(userId: nil)
        #expect(store.actionError == "条件を追加する権限がありません。")
    }

    @Test func handleShareCopiesAndSetsFlag() async {
        let provider = MockProvider()
        let store = InvestigationStore(
            investigationId: "inv-001",
            shareToken: "0123456789abcdef0123456789abcdef",
            provider: provider,
            mode: .mock
        )
        var copied: String?
        store.handleShare { text in
            copied = text
            return true
        }
        #expect(copied == "https://oisint.com/i/0123456789abcdef0123456789abcdef")
        #expect(store.shareCopied)

        store.handleShare { _ in false }
        #expect(!store.shareCopied)
        #expect(store.actionError == "共有URLをコピーできませんでした。URLを選択してコピーしてください。")
    }

    @Test func historyIsCappedAndDeduplicated() {
        let app = makeApp()
        for index in 0..<25 {
            app.recordHistory(
                InvestigationHistoryEntry(
                    investigationId: "inv-\(index)",
                    shareToken: nil,
                    title: "調査 \(index)",
                    updatedAt: "2026-08-16T00:00:00Z"
                )
            )
        }
        #expect(app.history.count == 20, "履歴は 20 件で打ち切り")
        #expect(app.history.first?.investigationId == "inv-24", "新しい順")

        // 同一 ID は重複せず先頭へ移動
        app.recordHistory(
            InvestigationHistoryEntry(investigationId: "inv-10", shareToken: nil, title: "調査 10 再訪", updatedAt: "2026-08-16T01:00:00Z")
        )
        #expect(app.history.count == 20)
        #expect(app.history.first?.investigationId == "inv-10")
        #expect(app.history.filter { $0.investigationId == "inv-10" }.count == 1)
    }

    @Test func decisionTextMatchesWebImplementation() {
        // decisionText.ts の出力形（seed c-1 を選択した場合）
        let seed = MockSeed.investigation
        let candidate = seed.candidates[0]
        let result = DecisionText.generate(
            investigation: seed,
            selectedCandidate: candidate,
            options: DecisionText.Options(mapUrl: DecisionText.mapUrl(for: candidate))
        )
        #expect(result.short.hasPrefix("店名: 店A"))
        #expect(result.short.contains("日時・住所: 不明 / 東京都豊島区池袋1-2-3"))
        #expect(result.short.contains("選んだ理由: 池袋駅東口から徒歩5分（example.com）"))
        #expect(result.short.contains("電話番号: 不明"))
        #expect(result.detailed.contains("落とした2件の理由:"))
        #expect(result.detailed.contains("・店B: 判定理由: 予算 3000〜4000円でやや高め（出典不明）"))
        #expect(result.detailed.contains("残る不明: 0件"))
        #expect(result.detailed.contains("検証用URL: https://example.com/shop-a"))
    }

    @Test func deepLinkParsing() {
        // Phase 7 完了条件: https / oisint スキーム / 不正 URL の 3 系統
        let token = "0123456789abcdef0123456789abcdef"
        #expect(DeepLink.parse(URL(string: "oisint://i/\(token)")!) == .join(token: token))
        #expect(DeepLink.parse(URL(string: "https://oisint.com/i/\(token)")!) == .join(token: token))
        #expect(DeepLink.parse(URL(string: "https://oisint.com/investigations/abc-123")!) == .investigation(id: "abc-123", shareToken: nil))
        #expect(DeepLink.parse(URL(string: "oisint://investigations/abc-123")!) == .investigation(id: "abc-123", shareToken: nil))
        // 不正系
        #expect(DeepLink.parse(URL(string: "https://evil.com/i/\(token)")!) == nil)
        #expect(DeepLink.parse(URL(string: "oisint://i/NOT-A-TOKEN")!) == nil)
        #expect(DeepLink.parse(URL(string: "oisint://unknown/x")!) == nil)
        #expect(DeepLink.parse(URL(string: "https://oisint.com/")!) == nil)
    }
}
