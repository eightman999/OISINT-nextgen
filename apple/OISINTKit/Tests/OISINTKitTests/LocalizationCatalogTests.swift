import Foundation
import Testing
@testable import OISINTKit

/// Localizable.xcstrings（OISINTKit の表示文言カタログ）の整合を機械検査する。
/// キーは日本語原文（開発言語 ja）。英語訳の欠落・書式指定子の不一致・日本語の混入を検出する。
@Suite struct LocalizationCatalogTests {
    private struct Catalog: Decodable {
        let sourceLanguage: String
        let strings: [String: Entry]
    }

    private struct Entry: Decodable {
        let localizations: [String: Localization]?
    }

    private struct Localization: Decodable {
        let stringUnit: StringUnit?
        let variations: Variations?
    }

    private struct Variations: Decodable {
        let plural: [String: PluralCase]?
    }

    private struct PluralCase: Decodable {
        let stringUnit: StringUnit
    }

    private struct StringUnit: Decodable {
        let state: String
        let value: String
    }

    private static let catalogURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Sources/OISINTKit/Resources/Localizable.xcstrings")

    private static func loadCatalog() throws -> Catalog {
        try JSONDecoder().decode(Catalog.self, from: Data(contentsOf: catalogURL))
    }

    private static func formatSpecifiers(_ text: String) -> [String] {
        let regex = /%(?:\d+\$)?(?:lld|ld|d|@|lf|f)/
        return text.matches(of: regex).map { String($0.output) }
    }

    private static func containsJapanese(_ text: String) -> Bool {
        text.unicodeScalars.contains { scalar in
            (0x3040...0x30FF).contains(scalar.value) || (0x3400...0x9FFF).contains(scalar.value)
        }
    }

    @Test func sourceLanguageIsJapanese() throws {
        #expect(try Self.loadCatalog().sourceLanguage == "ja")
    }

    @Test func everyEntryHasNaturalEnglishTranslation() throws {
        let catalog = try Self.loadCatalog()
        #expect(!catalog.strings.isEmpty)
        for (key, entry) in catalog.strings {
            guard let english = entry.localizations?["en"] else {
                Issue.record("英語訳がない: \(key)")
                continue
            }
            var values: [StringUnit] = []
            if let unit = english.stringUnit { values.append(unit) }
            if let plural = english.variations?.plural { values.append(contentsOf: plural.values.map(\.stringUnit)) }
            #expect(!values.isEmpty, "英語訳が空: \(key)")
            for unit in values {
                #expect(unit.state == "translated", "未翻訳状態: \(key)")
                #expect(!unit.value.trimmingCharacters(in: .whitespaces).isEmpty || key == "、", "英語訳が空文字: \(key)")
                #expect(!Self.containsJapanese(unit.value), "英語訳に日本語が残っている: \(key) -> \(unit.value)")
                #expect(Self.formatSpecifiers(unit.value).count == Self.formatSpecifiers(key).count,
                        "書式指定子の数が不一致: \(key) -> \(unit.value)")
            }
        }
    }

    @Test func dynamicFormatLabelsAreInCatalog() throws {
        // Format の表示ラベルは日本語正典（format.ts と突合）を動的キーとして引く。
        let keys = Set(try Self.loadCatalog().strings.keys)
        for status in [InvestigationStatus.draft, .parsing, .recalling, .searching, .collectingEvidence,
                       .evaluating, .ranking, .complete, .failed] {
            #expect(keys.contains(Format.statusLabel(status)), "statusLabel の訳がない: \(status.rawValue)")
        }
        for state in [MatchState.match, .partial, .mismatch, .unknown] {
            #expect(keys.contains(Format.matchStateAccessibilityLabel(state)), "matchState の訳がない: \(state.rawValue)")
        }
    }

    @Test func localizedFormatLabelsFallBackToJapaneseCanon() {
        // SwiftPM CLI ではカタログが未コンパイルのため、開発言語（日本語正典）へフォールバックする。
        // Xcode ビルドでは端末/アプリの言語で解決される。どちらでも空文字にはならない。
        #expect(!Format.localizedStatusLabel(.complete).isEmpty)
        #expect(!Format.localizedMatchStateAccessibilityLabel(.match).isEmpty)
    }
}
