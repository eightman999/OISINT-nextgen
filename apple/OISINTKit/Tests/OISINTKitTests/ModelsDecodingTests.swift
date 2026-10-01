import Foundation
import Testing
@testable import OISINTKit
import OISINTKitDebugFixtures

/// DB 行（snake_case）と API レスポンスの decode を §1.3-1.5 の逐語 JSON fixture で検証
@Suite struct ModelsDecodingTests {
    let decoder = JSONDecoder()

    @Test func decodeInvestigationRow() throws {
        let json = """
        {
          "id": "3f2b8a10-0000-4000-8000-000000000001",
          "title": "8/23 池袋 夜飯",
          "raw_query": "池袋 / 3人 / 3000円 / 肉 / 静かめ",
          "status": "complete",
          "share_token": "0123456789abcdef0123456789abcdef",
          "created_at": "2026-08-14T10:00:00Z",
          "updated_at": "2026-08-14T10:05:00Z"
        }
        """
        let row = try decoder.decode(InvestigationRow.self, from: Data(json.utf8))
        #expect(row.title == "8/23 池袋 夜飯")
        #expect(row.rawQuery == "池袋 / 3人 / 3000円 / 肉 / 静かめ")
        #expect(row.shareToken == "0123456789abcdef0123456789abcdef")
        #expect(InvestigationStatus(rawValue: row.status) == .complete)
    }

    @Test func decodeSafeInvestigationRowWithoutRawQuery() throws {
        // #151: native live provider の investigations select は safe columns のみ。
        let json = """
        {
          "id": "3f2b8a10-0000-4000-8000-000000000002",
          "title": "共有調査",
          "status": "complete",
          "share_token": "0123456789abcdef0123456789abcdef",
          "created_at": "2026-08-14T10:00:00Z",
          "updated_at": "2026-08-14T10:05:00Z"
        }
        """
        let row = try decoder.decode(InvestigationRow.self, from: Data(json.utf8))
        #expect(row.rawQuery == nil)
    }

    @Test func decodeCandidateRowWithJoinedPlace() throws {
        // §1.5: candidates は places (id, name, address, metadata) を結合して取得
        let json = """
        {
          "id": "c-live-1",
          "investigation_id": "inv-live-1",
          "place_id": "p-live-1",
          "score": 0.91,
          "rank": 1,
          "summary": null,
          "places": {
            "id": "p-live-1",
            "name": "店A",
            "address": "東京都豊島区池袋1-2-3",
            "metadata": {"provider": "geoapify", "capacity": 40}
          }
        }
        """
        let row = try decoder.decode(CandidateRow.self, from: Data(json.utf8))
        #expect(row.places?.name == "店A")
        #expect(row.places?.metadata?["provider"] == .string("geoapify"))
        #expect(row.rank == 1)
        #expect(row.score == 0.91)
    }

    @Test func decodeEvidenceRowAndMap() throws {
        // shared Evidence は investigation_id = NULL（§1.5 の罠）
        let json = """
        {
          "id": "e-live-1",
          "place_id": "p-live-1",
          "investigation_id": null,
          "scope": "shared",
          "source_type": "Official Website",
          "source_url": "https://example.com/shop-a",
          "source_title": null,
          "excerpt": null,
          "structured_claims": [
            {"key": "genre", "value": ["焼肉"], "rawText": "焼肉専門店"},
            {"key": "budget_dinner", "value": {"min": 2500, "max": 3500}}
          ],
          "observed_at": "2026-08-14",
          "source_quality": null,
          "freshness_score": 0.8
        }
        """
        let row = try decoder.decode(EvidenceRow.self, from: Data(json.utf8))
        let evidence = row.toEvidence()
        #expect(evidence.investigationId == nil)
        #expect(evidence.scope == .shared)
        #expect(evidence.excerpt == "")           // null → ''（mapEvidence）
        #expect(evidence.sourceQuality == 0)      // null → 0
        #expect(evidence.structuredClaims.count == 2)
        #expect(evidence.structuredClaims[1].rawText == "")  // validation.ts default('')
        // extractGenre 相当: genre claim の value 配列先頭
        #expect(evidence.structuredClaims[0].value.firstArrayElementAsString == "焼肉")
    }

    @Test func decodeEvaluationRowNullFallbacks() throws {
        let json = """
        {
          "candidate_id": "c-live-1",
          "requirement_id": "r-live-1",
          "state": "match",
          "confidence": null,
          "explanation": null,
          "evidence_ids": null
        }
        """
        let row = try decoder.decode(EvaluationRow.self, from: Data(json.utf8))
        // live.ts のマッピング: null → 0 / '' / []
        #expect(row.confidence == nil)
        #expect(MatchState(rawValue: row.state) == .match)
    }

    @Test func decodeMemberRowAndMap() throws {
        let json = """
        {"user_id": "u-live-1", "display_name": "まさくん", "role": "owner", "joined_at": "2026-08-14T10:00:00Z"}
        """
        let member = try decoder.decode(MemberRow.self, from: Data(json.utf8)).toMember()
        #expect(member.id == "u-live-1")
        #expect(member.displayName == "まさくん")
        #expect(member.role == .owner)
        #expect(member.isOnline == true)  // live.ts: isOnline: true 固定
    }

    @Test func decodeAPIResponses() throws {
        // §1.3 成功レスポンス逐語
        let create = try decoder.decode(
            CreateInvestigationResponse.self,
            from: Data(#"{"investigationId": "3F2B8A10-0000-4000-8000-000000000001", "shareToken": "0123456789abcdef0123456789abcdef"}"#.utf8)
        )
        try ResponseValidation.validate(create)

        let run = try decoder.decode(RunInvestigationResponse.self, from: Data(#"{"status": "recalling"}"#.utf8))
        #expect(run.status == .recalling)

        let rerank = try decoder.decode(RerankInvestigationResponse.self, from: Data(#"{"reranked": true}"#.utf8))
        #expect(rerank.reranked)

        let join = try decoder.decode(JoinInvestigationResponse.self, from: Data(#"{"investigationId": "inv-001", "title": "8/23 池袋 夜飯"}"#.utf8))
        try ResponseValidation.validate(join)
        #expect(join.title == "8/23 池袋 夜飯")
    }

    @Test func responseValidationRejectsInvalid() throws {
        // validation.ts: shareToken は ^[0-9a-f]{32}$、investigationId は uuid
        let badToken = CreateInvestigationResponse(investigationId: UUID().uuidString, shareToken: "XYZ")
        #expect(throws: OISINTError.self) { try ResponseValidation.validate(badToken) }

        let badId = CreateInvestigationResponse(investigationId: "not-a-uuid", shareToken: String(repeating: "a", count: 32))
        #expect(throws: OISINTError.self) { try ResponseValidation.validate(badId) }

        let emptyJoin = JoinInvestigationResponse(investigationId: "", title: "x")
        #expect(throws: OISINTError.self) { try ResponseValidation.validate(emptyJoin) }

        // 不正 status は decode 自体が失敗する（Zod enum 相当）
        #expect(throws: Error.self) {
            _ = try decoder.decode(RunInvestigationResponse.self, from: Data(#"{"status": "bogus"}"#.utf8))
        }
    }

    @Test func mockSeedCounts() {
        // §1.9: 候補 3 / requirements 5 / members 3 / 店A evidence 2 / 矛盾 1
        let seed = MockSeed.investigation
        #expect(seed.id == "inv-001")
        #expect(seed.title == "8/23 池袋 夜飯")
        #expect(seed.status == .complete)
        #expect(seed.candidates.count == 3)
        #expect(seed.requirements.count == 5)
        #expect(seed.members.count == 3)
        #expect(seed.candidates[0].evidence.count == 2)
        #expect(seed.candidates[0].contradictions.count == 1)
        #expect(seed.candidates.map(\.place.name) == ["店A", "店B", "店C"])
        #expect(seed.candidates.map(\.rank) == [1, 2, 3])
        // mock.ts の votes 逐語
        #expect(seed.candidates[0].votes == ["u-1": .up, "u-2": .up, "u-3": .neutral])
        #expect(seed.candidates[1].votes == ["u-1": .neutral, "u-2": .down, "u-3": .neutral])
        #expect(seed.candidates[2].votes == ["u-1": .down, "u-2": .up, "u-3": .up])
    }
}
