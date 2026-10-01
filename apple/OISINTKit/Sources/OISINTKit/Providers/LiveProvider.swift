import Foundation
import Supabase

private struct ServerEntitlementRow: Decodable, Sendable {
    let userId: String?
    let entitlementId: String?
    let offeringId: String?
    let productId: String?
    let appUserId: String?
    let store: String?
    let isActive: Bool?
    let lifecycleState: String?
    let expiresAt: String?
    let willRenew: Bool?
    let gracePeriodExpiresAt: String?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case entitlementId = "entitlement_id"
        case offeringId = "offering_id"
        case productId = "product_id"
        case appUserId = "app_user_id"
        case store
        case isActive = "is_active"
        case lifecycleState = "lifecycle_state"
        case expiresAt = "expires_at"
        case willRenew = "will_renew"
        case gracePeriodExpiresAt = "grace_period_expires_at"
    }
}

/// src/lib/providers/live.ts の移植（計画書 §1.6 / §2.6）。
/// 読み取り = PostgREST 直（並列 6 クエリ + shared evidence 2 段）、
/// 書き込み = Worker API（create/run/rerank/join）+ RLS 許可済みの votes upsert / requirements insert、
/// 進捗 = Realtime 7 購読（InvestigationSubscription）。
public actor LiveProvider: DataProvider {
    private let client: SupabaseClient
    private let auth: AuthService
    /// AppStore と共有する認証境界。client は AuthService と同じインスタンスを使う。
    public nonisolated let authService: AuthService
    private let api: WorkerAPIClient

    public init(configuration: ProviderFactory.LiveConfiguration) {
        let client = SupabaseClient(
            supabaseURL: configuration.supabaseURL,
            supabaseKey: configuration.supabaseAnonKey
        )
        self.client = client
        let auth = AuthService(
            client: client,
            supabaseURL: configuration.supabaseURL,
            supabaseAnonKey: configuration.supabaseAnonKey
        )
        self.auth = auth
        self.authService = auth
        #if DEBUG
        let allowLocalhost = true
        #else
        let allowLocalhost = false
        #endif
        self.api = WorkerAPIClient(baseURL: configuration.apiBaseURL, allowLocalhost: allowLocalhost) {
            try await auth.accessToken()
        }
    }

    // MARK: - Edge Functions（Worker api.oisint.com 経由。§1.4）

    public func createInvestigation(_ request: CreateInvestigationRequest) async throws -> CreateInvestigationResponse {
        try await api.createInvestigation(
            query: request.query,
            displayName: request.displayName,
            idempotencyKey: request.idempotencyKey,
            authSubject: request.authSubject
        )
    }

    public func runInvestigation(_ request: RunInvestigationRequest) async throws -> RunInvestigationResponse {
        // 投げっぱなし前提（§25.2）。呼び出し側は完了を待たず Realtime で進捗を受ける
        try await api.runInvestigation(investigationId: request.investigationId)
    }

    public func rerankInvestigation(_ request: RerankInvestigationRequest) async throws -> RerankInvestigationResponse {
        try await api.rerankInvestigation(investigationId: request.investigationId, trigger: request.trigger)
    }

    public func joinInvestigation(_ request: JoinInvestigationRequest) async throws -> JoinInvestigationResponse {
        try await api.joinInvestigation(shareToken: request.shareToken, displayName: request.displayName)
    }

    // MARK: - 読み取り（live.ts fetchInvestigation L214-323）

    public func getInvestigation(id: String) async throws -> Investigation? {
        _ = try await auth.ensureUserId()
        return try await fetchInvestigation(id)
    }

    struct MemberRPCParams: Encodable {
        let inv: String
    }

    struct OwnerRawQueryRPCParams: Encodable {
        let pInvestigation: String

        enum CodingKeys: String, CodingKey {
            case pInvestigation = "p_investigation"
        }
    }

    private func fetchInvestigation(_ id: String) async throws -> Investigation? {
        // 6 並列クエリ（live.ts Promise.all と同値）
        async let invRows: [InvestigationRow] = client.from("investigations")
            .select("id, title, status, share_token, created_at, updated_at")
            .eq("id", value: id).execute().value
        async let reqRows: [RequirementRow] = client.from("requirements")
            .select().eq("investigation_id", value: id).execute().value
        async let candRows: [CandidateRow] = client.from("candidates")
            .select("id, investigation_id, place_id, score, rank, summary, places (id, name, address, metadata)")
            .eq("investigation_id", value: id).execute().value
        async let evalRows: [EvaluationRow] = client.from("requirement_evaluations")
            .select().eq("investigation_id", value: id).execute().value
        async let voteRows: [VoteRow] = client.from("votes")
            .select("candidate_id, user_id, value").eq("investigation_id", value: id).execute().value
        async let memberRows: [MemberRow] = client.rpc("get_investigation_members", params: MemberRPCParams(inv: id))
            .execute().value
        async let ownerRawQueryRows: [OwnerRawQueryRow] = client.rpc(
            "get_investigation_owner_raw_query",
            params: OwnerRawQueryRPCParams(pInvestigation: id)
        ).execute().value

        guard let inv = try await invRows.first else { return nil }
        let candidateRows = try await candRows
        // owner RPC は JWT subject をサーバ側で判定する。member/public は空行で、
        // PostgREST の調査行safe-column selectからraw_queryを復元しない (#151)。
        let ownerRawQuery = try await ownerRawQueryRows.first?.rawQuery ?? ""

        // Evidence 2 段取得: shared は investigation_id = NULL のため place_id 集合で引く（live.ts コメント準拠。
        // investigation_id だけで絞ると every live candidate appear to have no sources になる罠）
        let placeIds = Array(Set(candidateRows.map(\.placeId)))
        async let scopedEvidence: [EvidenceRow] = client.from("evidence")
            .select().eq("investigation_id", value: id).execute().value
        let sharedEvidence: [EvidenceRow]
        if placeIds.isEmpty {
            sharedEvidence = []
        } else {
            sharedEvidence = try await client.from("evidence")
                .select().eq("scope", value: "shared").in("place_id", values: placeIds).execute().value
        }
        // id で重複排除（最初の出現を保持）して結合
        var seen = Set<String>()
        let evidence = (sharedEvidence + (try await scopedEvidence))
            .filter { seen.insert($0.id).inserted }
            .map { $0.toEvidence() }

        let requirements = try await reqRows.map { $0.toRequirement() }
        let evaluations = try await evalRows
        let votes = try await voteRows
        let members = try await memberRows.map { $0.toMember() }

        let candidates: [Candidate] = candidateRows.map { row in
            let candidateEvidence = evidence.filter { $0.placeId == row.placeId }
            let candidateEvaluations = evaluations
                .filter { $0.candidateId == row.id }
                .map { evaluation in
                    RequirementEvaluation(
                        requirementId: evaluation.requirementId,
                        state: MatchState(rawValue: evaluation.state) ?? .unknown,
                        confidence: evaluation.confidence ?? 0,
                        explanation: evaluation.explanation ?? "",
                        evidenceIds: evaluation.evidenceIds ?? []
                    )
                }
            var candidateVotes: [String: VoteValue] = [:]
            for vote in votes where vote.candidateId == row.id {
                candidateVotes[vote.userId] = VoteValue(rawValue: vote.value)
            }
            return Candidate(
                id: row.id,
                investigationId: row.investigationId,
                place: Place(
                    id: row.places?.id ?? row.placeId,
                    name: row.places?.name ?? "不明な店舗",
                    address: row.places?.address,
                    genre: Self.extractGenre(candidateEvidence),
                    access: row.places?.address
                ),
                score: row.score ?? 0,
                rank: row.rank ?? 0,
                evaluations: candidateEvaluations,
                evidence: candidateEvidence,
                contradictions: [],  // live は常に []（Web live.ts と同一挙動。計画書 §1.12-5）
                votes: candidateVotes
            )
        }
        .sorted { ($0.rank == 0 ? 99 : $0.rank) < ($1.rank == 0 ? 99 : $1.rank) }

        return Investigation(
            id: inv.id,
            title: inv.title,
            status: InvestigationStatus(rawValue: inv.status) ?? .draft,
            rawQuery: ownerRawQuery,
            requirements: requirements,
            candidates: candidates,
            members: members,
            shareToken: inv.shareToken,
            createdAt: inv.createdAt,
            updatedAt: inv.updatedAt
        )
    }

    /// live.ts extractGenre L204-212: structuredClaims の key === 'genre' の値配列先頭
    static func extractGenre(_ evidence: [Evidence]) -> String? {
        for item in evidence {
            if let claim = item.structuredClaims.first(where: { $0.key == "genre" }),
               let genre = claim.value.firstArrayElementAsString {
                return genre
            }
        }
        return nil
    }

    // MARK: - Realtime（§20）

    public func subscribeInvestigation(id: String, listener: @escaping InvestigationListener) async -> UnsubscribeHandle {
        let auth = self.auth
        let subscription = InvestigationSubscription(
            client: client,
            investigationId: id,
            ensureSession: { _ = try await auth.ensureUserId() },
            refetch: { [weak self] in
                guard let self else { return }
                // 一時的な取得失敗は次のイベントでリカバリ（live.ts と同値）
                if let investigation = try? await self.fetchInvestigation(id) {
                    listener(investigation)
                }
            }
        )
        return UnsubscribeHandle {
            subscription.cancel()
        }
    }

    // MARK: - RLS 許可済みのクライアント直書き（§23）

    struct VoteUpsert: Encodable {
        let investigationId: String
        let candidateId: String
        let userId: String
        let value: Int

        enum CodingKeys: String, CodingKey {
            case value
            case investigationId = "investigation_id"
            case candidateId = "candidate_id"
            case userId = "user_id"
        }
    }

    public func setVote(investigationId: String, candidateId: String, value: VoteValue) async throws {
        let userId = try await auth.ensureUserId()
        do {
            try await client.from("votes").upsert(
                VoteUpsert(investigationId: investigationId, candidateId: candidateId, userId: userId, value: value.rawValue),
                onConflict: "candidate_id,user_id"
            ).execute()
        } catch {
            throw OISINTError("投票に失敗しました: \(error.localizedDescription)")
        }
    }

    struct RequirementInsert: Encodable {
        let investigationId: String
        let createdBy: String
        let text: String
        let normalizedText: String

        enum CodingKeys: String, CodingKey {
            case text
            case investigationId = "investigation_id"
            case createdBy = "created_by"
            case normalizedText = "normalized_text"
        }
    }

    public func addRequirement(investigationId: String, text: String) async throws {
        let userId = try await auth.ensureUserId()
        do {
            try await client.from("requirements").insert(
                RequirementInsert(investigationId: investigationId, createdBy: userId, text: text, normalizedText: text)
            ).execute()
        } catch {
            throw OISINTError("条件の追加に失敗しました: \(error.localizedDescription)")
        }
    }

    public func getUserId() async throws -> String {
        try await auth.ensureUserId()
    }

    /// NativeのPlus表示もWebと同じ `get_my_entitlement` server正本を読む。
    /// anonymous/不正行/期限証明なしは行を削除せずFreeへ倒す。
    public func fetchServerEntitlement(for userId: String) async throws -> EntitlementStatus {
        let canonicalUserId = try await auth.ensureUserId()
        guard canonicalUserId.lowercased() == userId.lowercased(),
              UUID(uuidString: userId) != nil,
              !(await auth.isAnonymous()) else {
            return EntitlementStatus()
        }
        let rows: [ServerEntitlementRow] = try await client.rpc("get_my_entitlement").execute().value
        guard let row = rows.first,
              row.userId?.lowercased() == userId.lowercased(),
              row.appUserId?.lowercased() == userId.lowercased(),
              row.entitlementId == "plus",
              row.offeringId == "default",
              row.isActive == true,
              let productId = row.productId,
              ["oisint_plus_monthly", "oisint_plus_annual"].contains(productId),
              ["active", "canceled", "grace", "billing_issue"].contains(row.lifecycleState ?? "") else {
            return EntitlementStatus()
        }
        let expiration = row.expiresAt.flatMap(Self.parseServerDate)
        let grace = row.gracePeriodExpiresAt.flatMap(Self.parseServerDate)
        let now = Date()
        let futureExpiration = expiration.map { $0.timeIntervalSince1970.isFinite && $0 > now } == true
        let futureGrace = grace.map { $0.timeIntervalSince1970.isFinite && $0 > now } == true
        guard futureExpiration || futureGrace else { return EntitlementStatus() }
        return EntitlementStatus(
            isPlus: true,
            willRenew: row.willRenew,
            expiresAt: expiration,
            gracePeriodExpiresAt: grace,
            store: row.store,
            productIdentifier: productId,
            lifecycleState: row.lifecycleState
        )
    }

    private static func parseServerDate(_ value: String) -> Date? {
        ISO8601DateFormatter().date(from: value)
    }

    /// live では常に nil（web api.ts: mock のみプレビュー可）
    public func getInvestigationByShareToken(_ shareToken: String) async -> Investigation? {
        nil
    }
}
