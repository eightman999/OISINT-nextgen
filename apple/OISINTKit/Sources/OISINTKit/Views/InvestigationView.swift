import SwiftUI

/// app/investigations/[id].tsx の移植。
/// セクション順序（§1.8 実測）: actionError / failedState → header → Progress → Requirements →
/// 条件追加フォーム → 候補カード×N → bottomGrid → CandidateDetail → Footer
public struct InvestigationView: View {
    @Environment(AppStore.self) private var app
    @State private var store: InvestigationStore
    @Environment(\.horizontalSizeClass) private var sizeClass

    public init(investigationId: String, shareToken: String?, provider: any DataProvider, mode: DataProviderMode) {
        _store = State(initialValue: InvestigationStore(
            investigationId: investigationId,
            shareToken: shareToken,
            provider: provider,
            mode: mode
        ))
    }

    public var body: some View {
        Group {
            if store.loading {
                loadingState
            } else if let investigation = store.investigation {
                content(investigation)
            } else {
                notFoundState
            }
        }
        .background(DesignTokens.Colors.bg.color)
        .task {
            await store.load()
        }
        .onDisappear {
            store.unsubscribe()
        }
    }

    // MARK: - 状態表示

    private var loadingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("調査を読み込んでいます…", bundle: .module)
                .oisintFont(14)
                .foregroundStyle(DesignTokens.Colors.textSecondary.color)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel(Text("読み込み中", bundle: .module))
    }

    private var notFoundState: some View {
        VStack(spacing: 12) {
            Text(store.errorMessage ?? String(localized: "調査を読み込めませんでした", bundle: .module))
                .oisintFont(13)
                .foregroundStyle(DesignTokens.Colors.danger.color)
                .multilineTextAlignment(.center)
            Button {
                Task { await store.retry() }
            } label: {
                Text("再読み込み", bundle: .module)
                    .oisintFont(13, .bold)
                    .foregroundStyle(DesignTokens.Colors.surface.color)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 38)
                    .background(DesignTokens.Colors.orange.color)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("調査を再読み込み", bundle: .module))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - 本体

    @ViewBuilder
    private func content(_ investigation: Investigation) -> some View {
        if sizeClass == .regular {
            regularLayout(investigation)
        } else {
            compactLayout(investigation)
        }
    }

    /// iPhone（compact）: 単一カラム（§28 Mobile / Web isWide=false と同じ縦積み）
    private func compactLayout(_ investigation: Investigation) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if !store.actionError.isEmpty {
                        Text(store.actionError)
                            .oisintFont(13)
                            .foregroundStyle(DesignTokens.Colors.danger.color)
                    }
                    if investigation.status == .failed {
                        failedState
                    }
                    header(investigation)
                    progressBlock(investigation)
                    requirementsBlock(investigation)
                    if store.adding {
                        addRequirementForm
                    }
                    candidatesSection(investigation)
                    if !investigation.candidates.isEmpty {
                        bottomGrid(investigation)
                    }
                    if let selected = store.selectedCandidate {
                        detailSection(investigation, candidate: selected)
                    }
                    Spacer(minLength: 24)
                }
                .frame(maxWidth: 1100)
                .padding(20)
                .frame(maxWidth: .infinity)
            }
            FooterView()
        }
    }

    /// iPad / Mac（regular）: NavigationSplitView 3 ペイン（§3.5 / §28 Desktop）。
    /// sidebar = 調査コンテキスト（header/Progress/Requirements/Members/共有）、
    /// content = 候補一覧、detail = 比較・投票・Evidence + CandidateDetail
    private func regularLayout(_ investigation: Investigation) -> some View {
        VStack(spacing: 0) {
            NavigationSplitView(columnVisibility: .constant(.all)) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if !store.actionError.isEmpty {
                            Text(store.actionError)
                                .oisintFont(13)
                                .foregroundStyle(DesignTokens.Colors.danger.color)
                        }
                        if investigation.status == .failed {
                            failedState
                        }
                        header(investigation)
                        progressBlock(investigation)
                        requirementsBlock(investigation)
                        if store.adding {
                            addRequirementForm
                        }
                    }
                    .padding(16)
                }
                .background(DesignTokens.Colors.sidebarBg.color)
                .navigationSplitViewColumnWidth(min: 260, ideal: 300)
            } content: {
                ScrollView {
                    candidatesSection(investigation)
                        .padding(16)
                }
                .background(DesignTokens.Colors.bg.color)
                .navigationSplitViewColumnWidth(min: 300, ideal: 340)
            } detail: {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        if !investigation.candidates.isEmpty {
                            bottomGrid(investigation)
                        }
                        if let selected = store.selectedCandidate {
                            detailSection(investigation, candidate: selected)
                        }
                    }
                    .padding(16)
                }
                .background(DesignTokens.Colors.bg.color)
            }
            .navigationSplitViewStyle(.balanced)
            FooterView()
        }
    }

    private func progressBlock(_ investigation: Investigation) -> some View {
        // Web と同構造: 外側 inv-progress、内側 progress-steps（identifier の上書きを避けるためラップ）
        VStack(spacing: 0) {
            ProgressIndicatorView(status: investigation.status)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inv-progress")
    }

    private func requirementsBlock(_ investigation: Investigation) -> some View {
        RequirementListView(
            requirements: investigation.requirements,
            onAddPress: store.canEditRequirements(userId: app.userId) && store.investigation != nil
                ? { store.adding = true }
                : nil
        )
    }

    private var failedState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("調査の実行に失敗しました。", bundle: .module)
                .oisintFont(14, .bold)
                .foregroundStyle(DesignTokens.Colors.danger.color)
            Button {
                Task { await store.handleRetryRun() }
            } label: {
                Text("再試行", bundle: .module)
                    .oisintFont(13, .bold)
                    .foregroundStyle(DesignTokens.Colors.surface.color)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 38)
                    .background(DesignTokens.Colors.orange.color)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
            }
            .buttonStyle(.plain)
            .disabled(store.retrying)
            .accessibilityLabel(Text("調査を再試行", bundle: .module))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Colors.surface.color)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                .stroke(DesignTokens.Colors.danger.color, lineWidth: 1)
        )
    }

    private func header(_ investigation: Investigation) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(investigation.title)
                    .oisintFont(24, .bold)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                    .accessibilityIdentifier("inv-context")
                Spacer()
                Button {
                    store.handleShare(copyToPasteboard: Pasteboard.copy)
                } label: {
                    Text(store.shareCopied ? String(localized: "コピーしました", bundle: .module) : String(localized: "共有する", bundle: .module))
                        .oisintFont(13, .semibold)
                        .foregroundStyle(DesignTokens.Colors.text.color)
                        .padding(.vertical, 8)
                        .padding(.horizontal, 14)
                        .background(DesignTokens.Colors.surface.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.xs)
                                .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(store.shareCopied ? String(localized: "共有URLをコピーしました", bundle: .module) : String(localized: "共有URLをコピー", bundle: .module))
                .accessibilityIdentifier("inv-share")
            }
            Text(store.shareUrl)
                .oisintFont(12)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                .textSelection(.enabled)
                .accessibilityIdentifier("inv-share-url")
            MemberListView(members: investigation.members)
        }
    }

    private var addRequirementForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(String(localized: "追加する条件", bundle: .module), text: Bindable(store).newRequirement)
                .textFieldStyle(.plain)
                .oisintFont(14)
                .foregroundStyle(DesignTokens.Colors.text.color)
                .accessibilityIdentifier("inv-add-input")
                .padding(12)
                .background(DesignTokens.Colors.surface.color)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                        .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
                )
            HStack(spacing: 8) {
                Button {
                    store.adding = false
                } label: {
                    Text("キャンセル", bundle: .module)
                        .oisintFont(13, .bold)
                        .foregroundStyle(DesignTokens.Colors.textSecondary.color)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(DesignTokens.Colors.surfaceSoft.color)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                                .stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("条件追加をキャンセル", bundle: .module))
                .accessibilityIdentifier("inv-add-cancel")
                Button {
                    Task { await store.handleAddRequirement(userId: app.userId) }
                } label: {
                    Text("追加", bundle: .module)
                        .oisintFont(13, .bold)
                        .foregroundStyle(DesignTokens.Colors.surface.color)
                        .frame(maxWidth: .infinity, minHeight: 40)
                        .background(
                            store.newRequirement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                ? DesignTokens.Colors.border.color
                                : DesignTokens.Colors.black.color
                        )
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                }
                .buttonStyle(.plain)
                .disabled(store.newRequirement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel(Text("条件を追加", bundle: .module))
                .accessibilityIdentifier("inv-add-submit")
            }
        }
    }

    private func candidatesSection(_ investigation: Investigation) -> some View {
        let topCandidate = investigation.candidates.min(by: { $0.rank < $1.rank })
        let topCandidateHasUnresolvedMust = topCandidate.map { candidate in
            investigation.requirements
                .filter { $0.priority == .must }
                .contains { requirement in
                    guard let evaluation = candidate.evaluations.first(where: { $0.requirementId == requirement.id }) else {
                        return true
                    }
                    return evaluation.state == .unknown
                }
        } ?? false

        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(topCandidateHasUnresolvedMust ? String(localized: "候補の比較結果", bundle: .module) : String(localized: "おすすめのレストラン", bundle: .module))
                    .oisintFont(16, .bold)
                    .foregroundStyle(DesignTokens.Colors.text.color)
                    .accessibilityIdentifier("inv-candidates-heading")
                Text("\(investigation.candidates.count)件の候補が見つかりました", bundle: .module)
                    .oisintFont(10)
                    .foregroundStyle(DesignTokens.Colors.textSecondary.color)
            }
            .padding(.bottom, 4)

            if investigation.candidates.isEmpty {
                if investigation.status == .complete {
                    Text("条件に合う候補店が見つかりませんでした。条件を追加して再検索してください。", bundle: .module)
                        .oisintFont(14)
                        .foregroundStyle(DesignTokens.Colors.textTertiary.color)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                } else if investigation.status != .failed {
                    loadingCandidates
                }
            } else {
                candidateList(investigation)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inv-candidates")
    }

    @ViewBuilder
    private func candidateList(_ investigation: Investigation) -> some View {
        let cards = ForEach(investigation.candidates) { candidate in
            CandidateCardView(
                candidate: candidate,
                members: investigation.members,
                requirements: investigation.requirements,
                isSelected: candidate.id == store.selectedCandidate?.id,
                onPress: { store.selectedCandidateId = candidate.id }
            )
        }
        VStack(spacing: 10) { cards }
    }

    private var loadingCandidates: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("候補店を探索中です…", bundle: .module)
                .oisintFont(14)
                .foregroundStyle(DesignTokens.Colors.textTertiary.color)
            VStack(spacing: 10) {
                ForEach(0..<3, id: \.self) { index in
                    skeletonCard
                        .accessibilityIdentifier("candidate-skeleton-\(index)")
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }

    private var skeletonCard: some View {
        HStack(spacing: 0) {
            DesignTokens.Colors.borderSoft.color
                .frame(width: 92)
                .frame(minHeight: 78)
            VStack(alignment: .leading, spacing: 8) {
                Capsule().fill(DesignTokens.Colors.border.color)
                    .frame(width: 140, height: 11)
                Capsule().fill(DesignTokens.Colors.borderSoft.color)
                    .frame(maxWidth: .infinity)
                    .frame(height: 8)
                Capsule().fill(DesignTokens.Colors.borderSoft.color)
                    .frame(width: 100, height: 8)
            }
            .padding(12)
        }
        .background(DesignTokens.Colors.surface.color)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                .stroke(DesignTokens.Colors.borderSoft.color, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func bottomGrid(_ investigation: Investigation) -> some View {
        let panels = Group {
            ComparisonPanelView(candidates: investigation.candidates, requirements: investigation.requirements)
            VotePanelView(candidates: investigation.candidates) {
                if let first = investigation.candidates.first {
                    store.selectedCandidateId = first.id
                }
            }
            EvidencePanelView(evidence: store.selectedCandidate?.evidence ?? [])
        }
        // Web の bottomGrid 3 カラムは regular では detail 列内のセクションとして縦に維持（§3.5）
        VStack(spacing: 10) { panels }
    }

    private func detailSection(_ investigation: Investigation, candidate: Candidate) -> some View {
        CandidateDetailView(
            candidate: candidate,
            investigation: investigation,
            requirements: investigation.requirements,
            userVote: app.userId.flatMap { candidate.votes[$0] } ?? .neutral,
            onVoteChange: { value in
                store.handleVote(candidateId: candidate.id, value: value, userId: app.userId)
            },
            openURL: PlatformOpener.open,
            copyText: Pasteboard.copy
        )
        .padding(16)
        .background(DesignTokens.Colors.surface.color)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                .stroke(DesignTokens.Colors.border.color, lineWidth: 1)
        )
    }
}
