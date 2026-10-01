import Foundation
import Observation

/// 調査詳細画面の状態。useInvestigation.ts + app/investigations/[id].tsx のロジックを移植。
/// vote は 500ms debounce で rerank(trigger: vote)、requirement 追加は即 rerank（spec.md §25.3）。
@MainActor
@Observable
public final class InvestigationStore {
    public let investigationId: String
    public let shareToken: String?
    private let provider: any DataProvider
    private let mode: DataProviderMode

    public private(set) var investigation: Investigation?
    public private(set) var loading = true
    public private(set) var errorMessage: String?
    public var actionError = ""
    public var selectedCandidateId: String?
    public var adding = false
    public var newRequirement = ""
    public private(set) var shareCopied = false
    public private(set) var retrying = false

    private var subscription: UnsubscribeHandle?
    private var voteRerankTask: Task<Void, Never>?
    private var shareCopiedResetTask: Task<Void, Never>?
    /// 投票 rerank の debounce 間隔（§25.3 の 500ms。テストで短縮注入可能）
    let voteDebounce: Duration

    public init(
        investigationId: String,
        shareToken: String?,
        provider: any DataProvider,
        mode: DataProviderMode,
        voteDebounce: Duration = .milliseconds(500)
    ) {
        self.investigationId = investigationId
        self.shareToken = shareToken
        self.provider = provider
        self.mode = mode
        self.voteDebounce = voteDebounce
    }

    /// [id].tsx: shareToken があれば /i/<token>、無ければ /investigations/<id>
    public var shareUrl: String {
        if let shareToken {
            return "https://oisint.com/i/\(shareToken)"
        }
        return "https://oisint.com/investigations/\(investigationId)"
    }

    public var selectedCandidate: Candidate? {
        guard let investigation else { return nil }
        return investigation.candidates.first { $0.id == selectedCandidateId } ?? investigation.candidates.first
    }

    public func currentMember(userId: String?) -> InvestigationMember? {
        guard let userId else { return nil }
        return investigation?.members.first { $0.id == userId }
    }

    public func canEditRequirements(userId: String?) -> Bool {
        let role = currentMember(userId: userId)?.role
        return role == .owner || role == .editor
    }

    // MARK: - ロード + 購読（useInvestigation.ts の移植）

    public func load() async {
        investigation = nil
        errorMessage = nil
        loading = true

        do {
            if let initial = try await provider.getInvestigation(id: investigationId) {
                investigation = initial
                loading = false
                if selectedCandidateId == nil, let first = initial.candidates.first {
                    selectedCandidateId = first.id
                }
            } else {
                errorMessage = "調査が見つかりません"
                loading = false
            }
        } catch {
            errorMessage = "調査データを読み込めませんでした"
            loading = false
        }

        subscription?.cancel()
        subscription = await provider.subscribeInvestigation(id: investigationId) { [weak self] next in
            Task { @MainActor [weak self] in
                self?.apply(next)
            }
        }
    }

    private func apply(_ next: Investigation) {
        investigation = next
        errorMessage = nil
        loading = false
        // [id].tsx: 候補が来たら先頭を自動選択
        if selectedCandidateId == nil, let first = next.candidates.first {
            selectedCandidateId = first.id
        }
    }

    public func unsubscribe() {
        subscription?.cancel()
        subscription = nil
        voteRerankTask?.cancel()
        shareCopiedResetTask?.cancel()
    }

    public func retry() async {
        await load()
    }

    // MARK: - 操作（[id].tsx のハンドラ移植。エラー文言逐語）

    /// 投票: 即 upsert + 500ms debounce で rerank(trigger: vote)（§25.3）
    public func handleVote(candidateId: String, value: VoteValue, userId: String?) {
        guard investigation != nil, userId != nil else { return }

        Task {
            do {
                try await provider.setVote(investigationId: investigationId, candidateId: candidateId, value: value)
            } catch {
                actionError = "投票を保存できませんでした。通信状態を確認してください。"
            }
        }

        voteRerankTask?.cancel()
        voteRerankTask = Task { [voteDebounce] in
            try? await Task.sleep(for: voteDebounce)
            guard !Task.isCancelled else { return }
            do {
                _ = try await provider.rerankInvestigation(
                    RerankInvestigationRequest(investigationId: investigationId, trigger: .vote)
                )
            } catch {
                actionError = "投票を保存しましたが、順位の更新に失敗しました。"
            }
        }
    }

    /// 条件追加 → 即 rerank(trigger: requirement_added)（§25.3）
    public func handleAddRequirement(userId: String?) async {
        let text = newRequirement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, investigation != nil else { return }

        actionError = ""
        guard userId != nil else {
            actionError = "条件を追加する権限がありません。"
            return
        }
        do {
            try await provider.addRequirement(investigationId: investigationId, text: text)
            newRequirement = ""
            adding = false
            _ = try await provider.rerankInvestigation(
                RerankInvestigationRequest(investigationId: investigationId, trigger: .requirementAdded)
            )
        } catch {
            actionError = "条件の追加または候補の再評価に失敗しました。再試行してください。"
        }
    }

    /// failed 状態からの再実行
    public func handleRetryRun() async {
        guard investigation != nil else {
            await retry()
            return
        }
        actionError = ""
        retrying = true
        do {
            _ = try await provider.runInvestigation(RunInvestigationRequest(investigationId: investigationId))
        } catch {
            actionError = "調査を再試行できませんでした。時間を置いてもう一度お試しください。"
        }
        retrying = false
    }

    /// 共有 URL コピー（成功で 2200ms「コピーしました」表示 = [id].tsx と同値）
    public func handleShare(copyToPasteboard: (String) -> Bool) {
        actionError = ""
        if copyToPasteboard(shareUrl) {
            shareCopied = true
            shareCopiedResetTask?.cancel()
            shareCopiedResetTask = Task {
                try? await Task.sleep(for: .milliseconds(2200))
                guard !Task.isCancelled else { return }
                shareCopied = false
            }
        } else {
            shareCopied = false
            actionError = "共有URLをコピーできませんでした。URLを選択してコピーしてください。"
        }
    }
}
