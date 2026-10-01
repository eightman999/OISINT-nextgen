import Foundation
#if DEBUG

/// src/lib/providers/mock.ts のDebug fixture移植（計画書 §1.9）。
/// ネットワーク・外部 API なしで全フロー完走する（Issue #208 要求 / spec.md §26 mock-first）。
public actor MockProvider: DataProvider {
    private var investigations: [String: Investigation] = [:]
    private var listeners: [String: [UUID: InvestigationListener]] = [:]
    private var activeRuns: Set<String> = []
    private let mockUserId: String
    /// mock.ts simulateRun の 800ms 間隔。テストでは短縮注入可能（値の意味は変えない）
    private let stepInterval: Duration

    public init(stepInterval: Duration = .milliseconds(800)) {
        self.stepInterval = stepInterval
        // mock.ts L23-25: 'u-' + 8 桁 hex
        self.mockUserId = "u-" + String((0..<8).map { _ in "0123456789abcdef".randomElement()! })
        // mock.ts L140-144: seed は shareToken を固定値に差し替えて登録
        var seed = MockSeed.investigation
        seed.shareToken = "0123456789abcdef0123456789abcdef"
        investigations[seed.id] = seed
    }

    // MARK: - ヘルパ（mock.ts と同名の関数に対応）

    private func memberIdentity(displayName: String, userId: String?) -> String {
        if let trimmed = userId?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            return trimmed
        }
        return "display-name:" + displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func notify(_ investigation: Investigation) {
        guard let subscribed = listeners[investigation.id] else { return }
        for listener in subscribed.values {
            listener(investigation)
        }
    }

    private func updateStatus(id: String, status: InvestigationStatus) {
        guard var investigation = investigations[id] else { return }
        investigation.status = status
        investigation.updatedAt = Self.nowISO()
        investigations[id] = investigation
        notify(investigation)
    }

    private func simulateRun(id: String) {
        guard !activeRuns.contains(id) else { return }
        guard let investigation = investigations[id], investigation.status != .complete else { return }

        // mock.ts L62-69 の steps 逐語
        let steps: [InvestigationStatus] = [.recalling, .searching, .collectingEvidence, .evaluating, .ranking, .complete]
        updateStatus(id: id, status: steps[0])
        activeRuns.insert(id)

        Task { [stepInterval] in
            for step in steps.dropFirst() {
                try? await Task.sleep(for: stepInterval)
                self.advanceRun(id: id, step: step)
            }
        }
    }

    private func advanceRun(id: String, step: InvestigationStatus) {
        guard activeRuns.contains(id), var current = investigations[id] else {
            activeRuns.remove(id)
            return
        }
        if step == .complete {
            // mock.ts L88-99: complete 時に seed candidates を clone して割当（rank 1..N、investigationId 差替）
            current.candidates = MockSeed.investigation.candidates.enumerated().map { index, candidate in
                var next = candidate
                next.investigationId = id
                next.rank = index + 1
                return next
            }
            current.status = .complete
            current.updatedAt = Self.nowISO()
            investigations[id] = current
            activeRuns.remove(id)
            notify(current)
        } else {
            updateStatus(id: id, status: step)
        }
    }

    /// mock.ts computeRerankedCandidates: vote トリガ時のみ votes 合計降順で並べ替え、rank を 1..N に振り直す
    static func computeRerankedCandidates(_ candidates: [Candidate], trigger: RerankTrigger) -> [Candidate] {
        var next = candidates
        if trigger == .vote {
            // JS の sort は安定ソート。Swift の sort も安定性保証は無いが enumerated で安定化する
            next = next.enumerated()
                .sorted { left, right in
                    let leftScore = left.element.votes.values.reduce(0) { $0 + $1.rawValue }
                    let rightScore = right.element.votes.values.reduce(0) { $0 + $1.rawValue }
                    if leftScore != rightScore { return leftScore > rightScore }
                    return left.offset < right.offset
                }
                .map(\.element)
        }
        for index in next.indices {
            next[index].rank = index + 1
        }
        return next
    }

    static func nowISO() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private static func randomHex(_ length: Int) -> String {
        String((0..<length).map { _ in "0123456789abcdef".randomElement()! })
    }

    // MARK: - DataProvider

    public func createInvestigation(_ request: CreateInvestigationRequest) async throws -> CreateInvestigationResponse {
        let investigationId = UUID().uuidString.lowercased()
        let shareToken = Self.randomHex(32)
        let now = Self.nowISO()
        // mock.ts L155: title は query 先頭 30 文字、空なら「新しい調査」
        let title = request.query.isEmpty ? "新しい調査" : String(request.query.prefix(30))
        let investigation = Investigation(
            id: investigationId,
            title: title,
            status: .recalling,
            rawQuery: request.query,
            requirements: MockSeed.investigation.requirements,
            candidates: [],
            members: [
                InvestigationMember(
                    id: memberIdentity(displayName: request.displayName, userId: request.userId),
                    displayName: request.displayName,
                    isOnline: true,
                    role: .owner
                ),
            ],
            shareToken: shareToken,
            createdAt: now,
            updatedAt: now
        )
        investigations[investigationId] = investigation
        notify(investigation)
        return CreateInvestigationResponse(investigationId: investigationId, shareToken: shareToken)
    }

    public func runInvestigation(_ request: RunInvestigationRequest) async throws -> RunInvestigationResponse {
        guard let investigation = investigations[request.investigationId] else {
            throw OISINTError("調査が見つかりません")
        }
        simulateRun(id: request.investigationId)
        return RunInvestigationResponse(status: investigation.status)
    }

    public func rerankInvestigation(_ request: RerankInvestigationRequest) async throws -> RerankInvestigationResponse {
        guard var investigation = investigations[request.investigationId] else {
            throw OISINTError("調査が見つかりません")
        }
        guard investigation.status == .complete else {
            return RerankInvestigationResponse(reranked: false)
        }
        investigation.candidates = Self.computeRerankedCandidates(investigation.candidates, trigger: request.trigger)
        investigation.updatedAt = Self.nowISO()
        investigations[request.investigationId] = investigation
        notify(investigation)
        return RerankInvestigationResponse(reranked: true)
    }

    public func joinInvestigation(_ request: JoinInvestigationRequest) async throws -> JoinInvestigationResponse {
        guard var investigation = investigations.values.first(where: { $0.shareToken == request.shareToken }) else {
            throw OISINTError("調査が見つかりません")
        }
        let memberId = memberIdentity(displayName: request.displayName, userId: request.userId)
        if !investigation.members.contains(where: { $0.id == memberId }) {
            guard investigation.members.count < 20 else {
                throw OISINTError("参加人数の上限に達しています")
            }
            investigation.members.append(
                InvestigationMember(id: memberId, displayName: request.displayName, isOnline: true, role: .viewer)
            )
            investigation.updatedAt = Self.nowISO()
            investigations[investigation.id] = investigation
            notify(investigation)
        }
        return JoinInvestigationResponse(investigationId: investigation.id, title: investigation.title)
    }

    public func getInvestigation(id: String) async throws -> Investigation? {
        investigations[id]
    }

    public func subscribeInvestigation(id: String, listener: @escaping InvestigationListener) async -> UnsubscribeHandle {
        let token = UUID()
        listeners[id, default: [:]][token] = listener
        if let investigation = investigations[id] {
            listener(investigation)
        }
        return UnsubscribeHandle { [weak self] in
            Task { await self?.removeListener(id: id, token: token) }
        }
    }

    private func removeListener(id: String, token: UUID) {
        listeners[id]?[token] = nil
    }

    public func setVote(investigationId: String, candidateId: String, value: VoteValue) async throws {
        setVoteForUser(investigationId: investigationId, candidateId: candidateId, userId: mockUserId, value: value)
    }

    /// mock.ts setVoteForUser（テスト・複数ユーザー模擬用に公開）
    @discardableResult
    public func setVoteForUser(investigationId: String, candidateId: String, userId: String, value: VoteValue) -> Bool {
        guard var investigation = investigations[investigationId],
              let index = investigation.candidates.firstIndex(where: { $0.id == candidateId })
        else { return false }
        investigation.candidates[index].votes[userId] = value
        investigation.updatedAt = Self.nowISO()
        investigations[investigationId] = investigation
        notify(investigation)
        return true
    }

    public func addRequirement(investigationId: String, text: String) async throws {
        if !addRequirementForUser(investigationId: investigationId, text: text, userId: mockUserId) {
            throw OISINTError("条件を追加する権限がありません")
        }
    }

    /// mock.ts addRequirementForUser（owner/editor のみ許可）
    @discardableResult
    public func addRequirementForUser(investigationId: String, text: String, userId: String) -> Bool {
        guard var investigation = investigations[investigationId] else { return false }
        let member = investigation.members.first(where: { $0.id == userId })
        guard member?.role == .owner || member?.role == .editor else { return false }
        investigation.requirements.append(
            Requirement(
                id: "req-" + UUID().uuidString.lowercased(),
                text: text,
                normalizedText: text,
                kind: .other,
                priority: .should,
                weight: 0.5
            )
        )
        investigation.updatedAt = Self.nowISO()
        investigations[investigationId] = investigation
        notify(investigation)
        return true
    }

    public func getUserId() async throws -> String {
        mockUserId
    }

    /// mock.ts getInvestigationByShareTokenSync（JoinView の候補プレビュー用。web api.ts と同じく mock のみ有効）
    public func getInvestigationByShareToken(_ shareToken: String) async -> Investigation? {
        investigations.values.first(where: { $0.shareToken == shareToken })
    }

    /// mock 実装で owner として振る舞うためのユーザー ID（web mock と同じくローカル生成 'u-' + hex8）
    public var currentUserId: String { mockUserId }
}
#endif
