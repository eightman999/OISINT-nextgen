import Foundation
import Testing
@testable import OISINTKit
import OISINTKitDebugFixtures

/// mock フローのヘッドレス検証（計画書 Phase 2 ゲート:
/// create → run → 状態遷移 → complete で候補 3 件）。
/// stepInterval はテスト短縮のため 40ms を注入（実アプリは既定 800ms）。
@Suite struct MockProviderFlowTests {
    /// リスナー通知を集めるヘルパ
    final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var snapshots: [Investigation] = []

        func add(_ investigation: Investigation) {
            lock.lock()
            defer { lock.unlock() }
            snapshots.append(investigation)
        }

        var statuses: [InvestigationStatus] {
            lock.lock()
            defer { lock.unlock() }
            return snapshots.map(\.status)
        }

        var latest: Investigation? {
            lock.lock()
            defer { lock.unlock() }
            return snapshots.last
        }
    }

    @Test func seedIsRegisteredWithFixedShareToken() async throws {
        let provider = MockProvider()
        // mock.ts L140-144: seed の shareToken は 0123456789abcdef0123456789abcdef に差し替え
        let seed = await provider.getInvestigationByShareToken("0123456789abcdef0123456789abcdef")
        #expect(seed?.id == "inv-001")
        #expect(seed?.candidates.count == 3)
        let byId = try await provider.getInvestigation(id: "inv-001")
        #expect(byId?.title == "8/23 池袋 夜飯")
    }

    @Test func createRunCompletesWithThreeCandidates() async throws {
        let provider = MockProvider(stepInterval: .milliseconds(40))
        let collector = Collector()

        let created = try await provider.createInvestigation(
            CreateInvestigationRequest(query: "池袋で3人。3000円くらい。肉。", displayName: "まさくん", idempotencyKey: "mock-flow-test-1", authSubject: "mock-user")
        )
        #expect(UUID(uuidString: created.investigationId) != nil)
        #expect(created.shareToken.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil)

        let initial = try await provider.getInvestigation(id: created.investigationId)
        #expect(initial?.status == .recalling)
        #expect(initial?.candidates.isEmpty == true)
        #expect(initial?.requirements.count == 5)  // seed requirements の clone
        #expect(initial?.members.count == 1)
        #expect(initial?.members.first?.role == .owner)

        let handle = await provider.subscribeInvestigation(id: created.investigationId) { investigation in
            collector.add(investigation)
        }
        defer { handle.cancel() }

        _ = try await provider.runInvestigation(RunInvestigationRequest(investigationId: created.investigationId))

        // complete まで待つ（40ms × 5 遷移 + マージン）
        var waited = 0
        while waited < 100 {
            let current = try await provider.getInvestigation(id: created.investigationId)
            if current?.status == .complete { break }
            try await Task.sleep(for: .milliseconds(50))
            waited += 1
        }

        let final = try await #require(provider.getInvestigation(id: created.investigationId))
        #expect(final.status == .complete)
        #expect(final.candidates.count == 3, "complete 時に seed の候補 3 件が割当される")
        #expect(final.candidates.map(\.rank) == [1, 2, 3])
        #expect(final.candidates.allSatisfy { $0.investigationId == created.investigationId })

        // mock.ts simulateRun の遷移順（recalling → searching → collecting_evidence → evaluating → ranking → complete）
        let statuses = collector.statuses
        let order: [InvestigationStatus] = [.recalling, .searching, .collectingEvidence, .evaluating, .ranking, .complete]
        let observedOrder = order.filter { statuses.contains($0) }
        #expect(observedOrder.map { order.firstIndex(of: $0)! } == observedOrder.map { order.firstIndex(of: $0)! }.sorted(),
                "状態遷移が statusOrder どおりに単調進行する")
        #expect(statuses.contains(.complete))
    }

    @Test func runUnknownInvestigationThrows() async {
        let provider = MockProvider()
        await #expect(throws: OISINTError("調査が見つかりません")) {
            _ = try await provider.runInvestigation(RunInvestigationRequest(investigationId: "no-such-id"))
        }
    }

    @Test func rerankByVoteSortsByVoteSum() async throws {
        let provider = MockProvider()
        // seed (inv-001, complete) の投票合計: c-1 = 1+1+0 = 2, c-2 = 0-1+0 = -1, c-3 = -1+1+1 = 1
        let before = try await #require(provider.getInvestigation(id: "inv-001"))
        #expect(before.candidates.map(\.id) == ["c-1", "c-2", "c-3"])

        let response = try await provider.rerankInvestigation(
            RerankInvestigationRequest(investigationId: "inv-001", trigger: .vote)
        )
        #expect(response.reranked)

        let after = try await #require(provider.getInvestigation(id: "inv-001"))
        #expect(after.candidates.map(\.id) == ["c-1", "c-3", "c-2"], "votes 合計降順（2, 1, -1）")
        #expect(after.candidates.map(\.rank) == [1, 2, 3], "rank は 1..N に振り直し")
    }

    @Test func rerankBeforeCompleteReturnsFalse() async throws {
        let provider = MockProvider(stepInterval: .seconds(10))  // 完了させない
        let created = try await provider.createInvestigation(
            CreateInvestigationRequest(query: "q", displayName: "d", idempotencyKey: "mock-flow-test-2", authSubject: "mock-user")
        )
        let response = try await provider.rerankInvestigation(
            RerankInvestigationRequest(investigationId: created.investigationId, trigger: .vote)
        )
        #expect(!response.reranked, "complete 以外では reranked: false（mock.ts L187）")
    }

    @Test func joinAddsViewerOnceAndIsIdempotent() async throws {
        let provider = MockProvider()
        let token = "0123456789abcdef0123456789abcdef"

        let joined = try await provider.joinInvestigation(
            JoinInvestigationRequest(shareToken: token, displayName: "よんにん")
        )
        #expect(joined.investigationId == "inv-001")
        #expect(joined.title == "8/23 池袋 夜飯")

        var current = try await #require(provider.getInvestigation(id: "inv-001"))
        #expect(current.members.count == 4, "join 後 member-count が 4人（golden-path E2E と同値）")
        #expect(current.members.last?.role == .viewer)

        // 同一 identity での再 join は冪等（§25.4）
        _ = try await provider.joinInvestigation(
            JoinInvestigationRequest(shareToken: token, displayName: "よんにん")
        )
        current = try await #require(provider.getInvestigation(id: "inv-001"))
        #expect(current.members.count == 4)
    }

    @Test func joinUnknownTokenThrows() async {
        let provider = MockProvider()
        await #expect(throws: OISINTError("調査が見つかりません")) {
            _ = try await provider.joinInvestigation(
                JoinInvestigationRequest(shareToken: "ffffffffffffffffffffffffffffffff", displayName: "x")
            )
        }
    }

    @Test func setVoteUpdatesCandidateVotes() async throws {
        let provider = MockProvider()
        let userId = try await provider.getUserId()
        #expect(userId.range(of: "^u-[0-9a-f]{8}$", options: .regularExpression) != nil, "mock userId は 'u-' + hex8")

        try await provider.setVote(investigationId: "inv-001", candidateId: "c-2", value: .up)
        let current = try await #require(provider.getInvestigation(id: "inv-001"))
        let candidate = try #require(current.candidates.first { $0.id == "c-2" })
        #expect(candidate.votes[userId] == .up)
    }

    @Test func addRequirementRequiresEditorRole() async throws {
        let provider = MockProvider()
        // mock の自ユーザーは inv-001 の member ではない → 権限エラー（mock.ts L238-242）
        await #expect(throws: OISINTError("条件を追加する権限がありません")) {
            try await provider.addRequirement(investigationId: "inv-001", text: "個室")
        }
        // owner (u-1) としてなら追加できる
        let ok = await provider.addRequirementForUser(investigationId: "inv-001", text: "個室", userId: "u-1")
        #expect(ok)
        let current = try await #require(provider.getInvestigation(id: "inv-001"))
        #expect(current.requirements.count == 6)
        let added = try #require(current.requirements.last)
        #expect(added.text == "個室")
        #expect(added.normalizedText == "個室")
        #expect(added.kind == .other)
        #expect(added.priority == .should)
        #expect(added.weight == 0.5)
    }

    @Test func creatorCanAddRequirementToOwnInvestigation() async throws {
        let provider = MockProvider()
        let userId = try await provider.getUserId()
        let created = try await provider.createInvestigation(
            CreateInvestigationRequest(query: "q", displayName: "自分", userId: userId, idempotencyKey: "mock-flow-test-3", authSubject: userId)
        )
        try await provider.addRequirement(investigationId: created.investigationId, text: "静かめ")
        let current = try await #require(provider.getInvestigation(id: created.investigationId))
        #expect(current.requirements.count == 6)
    }

    @Test func subscribeNotifiesCurrentValueImmediately() async throws {
        let provider = MockProvider()
        let collector = Collector()
        let handle = await provider.subscribeInvestigation(id: "inv-001") { investigation in
            collector.add(investigation)
        }
        defer { handle.cancel() }
        try await Task.sleep(for: .milliseconds(100))
        let latest = collector.latest
        #expect(latest?.id == "inv-001", "購読直後に現在値が即時通知される（mock.ts L223-231）")
    }
}
