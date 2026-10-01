import Foundation

/// Releaseのlive設定不足をmockへ落とさず、利用者に設定エラーを返すfail-closed provider。
public actor UnavailableDataProvider: DataProvider {
    private let reason: String

    public init(reason: String) {
        self.reason = reason
    }

    private func unavailable() -> OISINTError {
        OISINTError(reason)
    }

    public func createInvestigation(_ request: CreateInvestigationRequest) async throws -> CreateInvestigationResponse {
        throw unavailable()
    }

    public func runInvestigation(_ request: RunInvestigationRequest) async throws -> RunInvestigationResponse {
        throw unavailable()
    }

    public func rerankInvestigation(_ request: RerankInvestigationRequest) async throws -> RerankInvestigationResponse {
        throw unavailable()
    }

    public func joinInvestigation(_ request: JoinInvestigationRequest) async throws -> JoinInvestigationResponse {
        throw unavailable()
    }

    public func getInvestigation(id: String) async throws -> Investigation? {
        throw unavailable()
    }

    public func subscribeInvestigation(id: String, listener: @escaping InvestigationListener) async -> UnsubscribeHandle {
        UnsubscribeHandle {}
    }

    public func setVote(investigationId: String, candidateId: String, value: VoteValue) async throws {
        throw unavailable()
    }

    public func addRequirement(investigationId: String, text: String) async throws {
        throw unavailable()
    }

    public func getUserId() async throws -> String {
        throw unavailable()
    }

    public func getInvestigationByShareToken(_ shareToken: String) async -> Investigation? {
        nil
    }
}
