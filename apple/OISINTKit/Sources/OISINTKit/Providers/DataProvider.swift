import Foundation

/// Investigation 更新の購読リスナー（src/types InvestigationListener）
public typealias InvestigationListener = @Sendable (Investigation) -> Void

/// src/lib/providers/types.ts DataProvider の 1:1 移植（計画書 §1.6 / §2.3）。
/// Views / Stores はこの protocol のみを知り、mock/live の分岐は ProviderFactory 1 箇所に閉じる（spec.md §26）。
public protocol DataProvider: Sendable {
    // Edge Functions（書き込みは必ずこの4本を経由 §25）
    func createInvestigation(_ request: CreateInvestigationRequest) async throws -> CreateInvestigationResponse
    func runInvestigation(_ request: RunInvestigationRequest) async throws -> RunInvestigationResponse
    func rerankInvestigation(_ request: RerankInvestigationRequest) async throws -> RerankInvestigationResponse
    func joinInvestigation(_ request: JoinInvestigationRequest) async throws -> JoinInvestigationResponse

    // 読み取り（live は PostgREST SELECT + Realtime §20, §23）
    func getInvestigation(id: String) async throws -> Investigation?
    func subscribeInvestigation(id: String, listener: @escaping InvestigationListener) async -> UnsubscribeHandle

    // RLS が直接許可している書き込み（votes upsert / requirements insert §23）
    func setVote(investigationId: String, candidateId: String, value: VoteValue) async throws
    func addRequirement(investigationId: String, text: String) async throws

    // 認証済みユーザー ID（live は Supabase 匿名認証、mock はローカル生成）
    func getUserId() async throws -> String

    /// 共有トークンからのプレビュー（web api.ts getInvestigationByShareToken 相当。
    /// mock のみ値を返し、live は nil = Web と同一挙動）
    func getInvestigationByShareToken(_ shareToken: String) async -> Investigation?
}

/// 購読解除ハンドル（web の unsubscribe クロージャ相当）
public final class UnsubscribeHandle: Sendable {
    private let onCancel: @Sendable () -> Void

    public init(_ onCancel: @escaping @Sendable () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() {
        onCancel()
    }
}
