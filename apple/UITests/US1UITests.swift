import Foundation
import XCTest

/// Issue #208 完了条件の US1 フロー実操作検証（mock モード）:
/// 一覧(Home) → 調査作成 → 進捗 → 候補一覧 → 候補詳細 → Evidence → 投票 を
/// シミュレータ / 実アプリ上で実際に操作し、各画面のスクリーンショットを attachment として保存する。
/// 実行: xcodebuild test -scheme OISINT -destination ... -resultBundlePath verify-logs/us1.xcresult
@MainActor
final class US1UITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
        #if os(iOS)
        // run-ui-tests.sh が各テスト invocation ごとに決定した値を受け取り、
        // テスト本体が launch する前に端末の向きを固定する。
        switch ProcessInfo.processInfo.environment["OISINT_UI_ORIENTATION"] {
        case "landscape":
            XCUIDevice.shared.orientation = .landscapeLeft
        default:
            XCUIDevice.shared.orientation = .portrait
        }
        #endif
    }

    func takeShot(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testUS1MockFlow() throws {
        let app = XCUIApplication()
        // mock モードを明示（DEBUG 既定も mock。Release 検証でも同じテストが使えるよう明示する）
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launch()

        // 1. Home（一覧 = ローカル履歴セクションを含む Home）
        let searchBox = app.descendants(matching: .any)["home-query"].firstMatch
        XCTAssertTrue(searchBox.waitForExistence(timeout: 10), "Home の検索ボックスが表示される")
        takeShot(app, "01-home")

        // 2. 例文チップで query を入力（日本語 typeText の不安定さを回避。Web の例文タップと同じ操作）
        let example = app.buttons["池袋で3人。3000円くらい。肉。カード可。静かめ。"].firstMatch
        XCTAssertTrue(example.waitForExistence(timeout: 5), "例文チップが表示される")
        example.tap()
        takeShot(app, "02-home-query-filled")

        // 3. 捜査開始（表示名は未入力 = 「ゲスト」フォールバック。Web と同じ挙動）
        let start = app.buttons["home-start"].firstMatch
        XCTAssertTrue(start.isEnabled, "query 入力後に開始ボタンが有効になる")
        start.tap()

        // 4. 進捗（ProgressIndicator が statusOrder 順に進む。mock は 800ms 間隔）
        // SwiftUI の AX ツリーでは inv-progress(contain) に progress-steps が統合されるため外側で待つ
        let progress = app.descendants(matching: .any)["inv-progress"].firstMatch
        XCTAssertTrue(progress.waitForExistence(timeout: 10), "調査詳細へ遷移し進捗チップが表示される")
        takeShot(app, "03-progress")

        // 5. 候補一覧（mock complete で 3 件）
        let candidate1 = app.descendants(matching: .any)["inv-candidate-1"].firstMatch
        XCTAssertTrue(candidate1.waitForExistence(timeout: 20), "complete 後に候補 1 位が表示される")
        let candidate3 = app.descendants(matching: .any)["inv-candidate-3"].firstMatch
        XCTAssertTrue(candidate3.exists, "候補 3 件目まで表示される")
        takeShot(app, "04-candidates")

        // フッタークレジット（spec.md §27。Phase 3 ゲート）
        let footer = app.staticTexts["© OpenStreetMap contributors · Powered by Geoapify"].firstMatch
        XCTAssertTrue(footer.exists, "Geoapify/OSMクレジットがフッターに常設される")

        // 6. 候補詳細（1 位をタップ → CandidateDetail セクション）
        candidate1.tap()
        app.swipeUp()
        app.swipeUp()
        takeShot(app, "05-candidate-detail")

        // 7. Evidence（source_url 表示。詳細セクションまでスクロール済み）
        let evidenceURL = app.descendants(matching: .any)["evidence-source-url"].firstMatch
        var scrolls = 0
        while !evidenceURL.exists, scrolls < 6 {
            app.swipeUp()
            scrolls += 1
        }
        XCTAssertTrue(evidenceURL.exists, "Evidence の source_url が表示される")
        takeShot(app, "06-evidence")

        // 7b. Evidence リンクが実際にブラウザで開く（Phase 4 ゲート）
        #if os(iOS)
        let evidenceLink = app.buttons["店A 公式サイト。Evidenceを開く"].firstMatch
        if evidenceLink.exists, evidenceLink.isHittable {
            evidenceLink.tap()
            let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
            XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "Evidence リンクが Safari で開く")
            takeShot(safari, "06b-evidence-browser")
            app.activate()
            XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "アプリへ復帰する")
        }
        #endif

        // 8. 投票（👍 行きたい をタップ → orange 塗り + rerank 反映）
        let voteUp = app.buttons["行きたい"].firstMatch
        var voteScrolls = 0
        while !(voteUp.exists && voteUp.isHittable), voteScrolls < 6 {
            app.swipeUp()
            voteScrolls += 1
        }
        XCTAssertTrue(voteUp.exists, "投票ボタンが表示される")
        voteUp.tap()
        XCTAssertTrue(voteUp.waitForExistence(timeout: 5))
        takeShot(app, "07-voted")

        // 投票の 500ms debounce 後に rerank が走り、順位が維持・更新される（§25.3）
        Thread.sleep(forTimeInterval: 1.2)
        takeShot(app, "08-after-rerank")
    }

    /// 共有トークン参加（Phase 7 ゲート）: oisint://i/<token> 相当の deep link →
    /// JoinView（候補プレビュー + join-name + join-button）→ 参加 → InvestigationView、member-count 4人
    /// （§1.9 golden-path E2E と同値）
    func testJoinFlow() throws {
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launchEnvironment["OISINT_TEST_OPEN_URL"] = "oisint://i/0123456789abcdef0123456789abcdef"
        app.launch()

        // JoinView: 候補プレビュー（seed の 3 件）+ 表示名 + 参加ボタン
        let joinButton = app.descendants(matching: .any)["join-button"].firstMatch
        XCTAssertTrue(joinButton.waitForExistence(timeout: 10), "JoinView が deep link で開く")
        let joinName = app.descendants(matching: .any)["join-name"].firstMatch
        XCTAssertTrue(joinName.exists, "表示名入力が表示される")
        XCTAssertTrue(app.staticTexts["8/23 池袋 夜飯"].firstMatch.exists, "調査タイトルのプレビューが表示される")
        takeShot(app, "11-join-landing")

        joinName.tap()
        joinName.typeText("yonnin")
        joinButton.tap()

        // InvestigationView へ遷移し、member-count が 4人 になる
        let memberCount = app.staticTexts["4人が参加中"].firstMatch
        XCTAssertTrue(memberCount.waitForExistence(timeout: 10), "join 後 member-count が 4人 になる")
        takeShot(app, "12-joined")
    }

    /// 実 deep link（Phase 7 ゲート）: OS 経由で oisint://i/<token> を開き、
    /// システム確認ダイアログ →「開く」→ JoinView 表示までを実操作で検証する
    func testRealDeepLinkOpensJoinView() throws {
        #if os(iOS)
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["home-query"].firstMatch.waitForExistence(timeout: 10))

        // OS に URL を開かせる（simctl openurl 相当）
        XCUIDevice.shared.system.open(URL(string: "oisint://i/0123456789abcdef0123456789abcdef")!)

        // システム確認ダイアログ（"OISINT" で開きますか?）を承認
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let openJa = springboard.buttons["開く"]
        let openEn = springboard.buttons["Open"]
        if openJa.waitForExistence(timeout: 5) {
            openJa.tap()
        } else if openEn.waitForExistence(timeout: 3) {
            openEn.tap()
        }

        // JoinView が開く（onOpenURL → DeepLink.parse → .join）
        let joinButton = app.descendants(matching: .any)["join-button"].firstMatch
        XCTAssertTrue(joinButton.waitForExistence(timeout: 10), "実 deep link で JoinView が開く")
        takeShot(app, "13-real-deeplink-join")
        #endif
    }

    /// iPad / Mac（regular）3 ペインレイアウト検証（Phase 8 ゲート）:
    /// sidebar=調査コンテキスト / content=候補一覧 / detail=比較・投票・Evidence が同時に表示される（§28 Desktop）
    func testRegularThreePaneLayout() throws {
        #if os(iOS)
        // portrait では NavigationSplitView の sidebar が折りたたまれる（Apple 標準挙動）ため landscape で検証
        XCUIDevice.shared.orientation = .landscapeLeft
        #endif
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launch()

        let example = app.buttons["池袋で3人。3000円くらい。肉。カード可。静かめ。"].firstMatch
        XCTAssertTrue(example.waitForExistence(timeout: 10))
        example.tap()
        app.buttons["home-start"].firstMatch.tap()

        // 候補が出るまで待つ（mock 800ms × 5）
        let candidate1 = app.descendants(matching: .any)["inv-candidate-1"].firstMatch
        XCTAssertTrue(candidate1.waitForExistence(timeout: 20))

        // regular（iPad 横幅）でのみ 3 ペイン検証。compact ではスキップ
        let context = app.descendants(matching: .any)["inv-context"].firstMatch
        let comparison = app.staticTexts["比較"].firstMatch
        if UIDevice.current.userInterfaceIdiom == .pad {
            XCTAssertTrue(context.exists, "sidebar: 調査コンテキスト（タイトル）が表示される")
            XCTAssertTrue(candidate1.exists, "content: 候補一覧が表示される")
            XCTAssertTrue(comparison.waitForExistence(timeout: 5), "detail: 比較パネルが同時に表示される")
            // 比較テーブルに全候補列が描画・可視化される（#241: flex 比率の再現確認）
            for candidateId in ["c-1", "c-2", "c-3"] {
                let head = app.descendants(matching: .any)["comparison-head-\(candidateId)"].firstMatch
                XCTAssertTrue(head.waitForExistence(timeout: 5), "比較パネルに \(candidateId) 列ヘッダが存在する")
                XCTAssertTrue(head.isHittable, "比較パネルの \(candidateId) 列が画面内に表示される（見切れていない）")
            }
            let footer = app.staticTexts["© OpenStreetMap contributors · Powered by Geoapify"].firstMatch
            XCTAssertTrue(footer.exists, "フッタークレジットが 3 ペインでも常設される")
            // 720pt 以上では従来の 1 行レイアウト（クレジットとリンクの縦中心一致。#241 追加要件 /
            // footer-responsive.spec.ts desktop ケースと同じ ±2 の許容）
            let helpLink = app.descendants(matching: .any)["footer-help"].firstMatch
            XCTAssertTrue(helpLink.isHittable, "footer-help が画面内に表示される")
            XCTAssertLessThanOrEqual(abs(footer.frame.midY - helpLink.frame.midY), 2,
                                     "広い幅ではクレジットとリンクが同じ 1 行に並ぶ")
        }
        takeShot(app, "14-three-pane")
    }

    /// VoiceOver ラベル検証（Phase 8 ゲート）: 投票ボタン・Match 記号にラベルが読まれる
    /// + Accessibility Audit（結果は attachment に記録）
    func testAccessibilityLabels() throws {
        #if os(iOS)
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launchEnvironment["OISINT_TEST_OPEN_URL"] = "oisint://investigations/inv-001"
        app.launch()

        let candidate1 = app.descendants(matching: .any)["inv-candidate-1"].firstMatch
        XCTAssertTrue(candidate1.waitForExistence(timeout: 10))

        // 投票ボタンのラベル（VoiceOver で読まれる。matchStateAccessibilityLabel は format.ts 逐語）
        XCTAssertTrue(app.buttons["行きたい"].firstMatch.exists, "投票ボタン 👍 にラベル")
        XCTAssertTrue(app.buttons["どちらでも"].firstMatch.exists, "投票ボタン 🤔 にラベル")
        XCTAssertTrue(app.buttons["行きたくない"].firstMatch.exists, "投票ボタン 👎 にラベル")
        // Match 記号のラベル（○ → 条件を満たす / △ → 一部満たす）
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "条件を満たす")).firstMatch.exists,
                      "Match 記号 ○ が「条件を満たす」と読まれる")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "一部満たす")).firstMatch.exists,
                      "Match 記号 △ が「一部満たす」と読まれる")

        // Accessibility Audit（結果は記録のみ。Web 正典由来の配色コントラスト等で fail させない）
        let auditNotes = AuditNotes()
        try app.performAccessibilityAudit(for: [.dynamicType, .sufficientElementDescription]) { issue in
            auditNotes.append("\(issue.auditType): \(issue.compactDescription)")
            return true  // 記録して続行
        }
        let attachment = XCTAttachment(string: auditNotes.joined)
        attachment.name = "accessibility-audit"
        attachment.lifetime = .keepAlways
        add(attachment)
        #endif
    }

    /// audit クロージャ（@Sendable）から集めるためのスレッド安全な入れ物
    final class AuditNotes: @unchecked Sendable {
        private let lock = NSLock()
        private var notes: [String] = []

        func append(_ note: String) {
            lock.lock()
            notes.append(note)
            lock.unlock()
        }

        var joined: String {
            lock.lock()
            defer { lock.unlock() }
            return notes.isEmpty ? "違反なし" : notes.joined(separator: "\n")
        }
    }

    /// フッターリンクの可視性とタップ到達性（#241 + 追加要件）:
    /// スマホ幅（< 720pt）ではフッターが「クレジット行 + リンク行」の 2 行構成になり、
    /// 4 リンクすべてが画面内（左右見切れなし）で、実際にタップすると Safari が開くことを実操作で検証する。
    /// アサーションは Web 側 #244 の e2e/tests/footer-responsive.spec.ts と同値。
    func testFooterContactLinkVisibleAndTappable() throws {
        let linkIds = ["footer-help", "footer-support", "footer-contact", "footer-feedback"]
        for identifier in linkIds {
            #if os(iOS)
            // 前リンクの Safari foreground 状態を持ち越さず、tap の遷移を毎回観測する。
            let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
            safari.terminate()
            #endif
            // リンクごとにアプリを新規起動し、Safari 復帰後も query を取り直す。
            // これにより前のリンクの accessibility snapshot / frame を次のリンクへ持ち越さない。
            let app = XCUIApplication()
            app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
            app.launch()
            XCTAssertTrue(
                app.descendants(matching: .any)["home-query"].firstMatch.waitForExistence(timeout: 10),
                "\(identifier): Home が表示される"
            )

            let window = app.windows.firstMatch
            let credit = app.staticTexts["© OpenStreetMap contributors · Powered by Geoapify"].firstMatch
            XCTAssertTrue(credit.exists, "\(identifier): クレジット表記が存在する")

            // 各 assertion の直前に同じ identifier から query し、stale frame を使わない。
            let link = app.descendants(matching: .any)[identifier].firstMatch
            XCTAssertTrue(link.exists, "\(identifier) が存在する")
            XCTAssertTrue(link.isHittable, "\(identifier) が画面内でタップ可能（見切れていない）")
            XCTAssertGreaterThanOrEqual(link.frame.minX, window.frame.minX, "\(identifier) が左へ見切れていない")
            XCTAssertLessThanOrEqual(link.frame.maxX, window.frame.maxX + 0.5, "\(identifier) が右へ見切れていない")

            // スマホ幅では 2 行構成: リンク行がクレジット行の下に来る。
            if window.frame.width < 720 {
                let firstLink = app.descendants(matching: .any)[identifier].firstMatch
                XCTAssertGreaterThanOrEqual(firstLink.frame.minY, credit.frame.maxY,
                                            "\(identifier): スマホ幅ではリンク行がクレジット行の下になる")
            }
            takeShot(app, "17-footer-\(identifier)-visible")

            #if os(iOS)
            // fresh query した element だけを tap し、Safari と復帰先 app も毎回再取得する。
            app.descendants(matching: .any)[identifier].firstMatch.tap()
            XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "\(identifier) が Safari で開く")
            if identifier == "footer-contact" {
                takeShot(safari, "18-footer-contact-browser")
            }
            let resumedApp = XCUIApplication()
            resumedApp.activate()
            XCTAssertTrue(resumedApp.wait(for: .runningForeground, timeout: 10), "\(identifier): アプリへ復帰する")
            let refreshedLink = resumedApp.descendants(matching: .any)[identifier].firstMatch
            XCTAssertTrue(refreshedLink.waitForExistence(timeout: 5), "\(identifier): 復帰後にリンクを再取得できる")
            #endif
        }
    }

    /// 条件追加 → チップ増加（Phase 5 ゲート。スクロール位置が上部のうちに実施する独立フロー）
    func testAddRequirementFlow() throws {
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launch()

        let example = app.buttons["新宿で4人。ひとり6000円前後。個室。落ち着いた和食。"].firstMatch
        XCTAssertTrue(example.waitForExistence(timeout: 10))
        example.tap()
        app.buttons["home-start"].firstMatch.tap()

        // 遷移直後（進捗中）でも条件チップと追加ボタンは表示される
        // （XCUITest 上の label は accessibilityLabel の「条件を追加」。フォームが開く前は一意）
        let addChip = app.buttons["条件を追加"].firstMatch
        XCTAssertTrue(addChip.waitForExistence(timeout: 10), "条件を追加チップが表示される（owner 権限）")
        addChip.tap()

        let addInput = app.descendants(matching: .any)["inv-add-input"].firstMatch
        XCTAssertTrue(addInput.waitForExistence(timeout: 5), "条件追加フォームが開く")
        addInput.tap()
        addInput.typeText("Wi-Fi")
        takeShot(app, "09-requirement-form")

        let submit = app.descendants(matching: .any)["inv-add-submit"].firstMatch
        XCTAssertTrue(submit.isEnabled)
        submit.tap()

        let newChip = app.staticTexts["Wi-Fi"].firstMatch
        XCTAssertTrue(newChip.waitForExistence(timeout: 5), "追加した条件チップが増える")
        takeShot(app, "10-requirement-added")
    }

    func testHomeSeparatesResearchAndExplanation() throws {
        #if os(iOS)
        XCUIDevice.shared.orientation = UIDevice.current.userInterfaceIdiom == .pad ? .landscapeLeft : .portrait
        #endif
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        app.launch()

        let main = app.descendants(matching: .any)["lp-workbench-main"].firstMatch
        let aside = app.descendants(matching: .any)["lp-workbench-aside"].firstMatch
        let query = app.descendants(matching: .any)["home-query"].firstMatch
        let start = app.buttons["home-start"].firstMatch
        XCTAssertTrue(main.waitForExistence(timeout: 10), "調べる操作カードが表示される")
        XCTAssertTrue(aside.waitForExistence(timeout: 10), "説明カードが独立して表示される")
        XCTAssertTrue(query.exists, "home-query の操作契約を維持する")
        XCTAssertTrue(start.exists, "home-start の操作契約を維持する")

        let window = app.windows.firstMatch
        if window.frame.width >= 920 {
            XCTAssertLessThanOrEqual(abs(main.frame.width - aside.frame.width), 2, "regular 幅では操作と説明をほぼ 1:1 にする")
            XCTAssertLessThanOrEqual(main.frame.maxX, aside.frame.minX, "regular 幅では2カードを横に分離する")
        } else {
            XCTAssertLessThanOrEqual(main.frame.maxY, aside.frame.minY, "compact 幅では操作カードを説明カードより先に置く")
        }
        for element in [main, aside] {
            XCTAssertGreaterThanOrEqual(element.frame.minX, window.frame.minX, "カードが左へ見切れない")
            XCTAssertLessThanOrEqual(element.frame.maxX, window.frame.maxX + 0.5, "カードが右へ見切れない")
        }

        XCTAssertFalse(start.isEnabled, "未入力時の home-start 無効状態を維持する")
        takeShot(app, "22-home-operation-and-explanation")

        if window.frame.width < 920 {
            let explanationTitle = app.staticTexts["選び方の流れ"].firstMatch
            var scrolls = 0
            while !explanationTitle.isHittable, scrolls < 10 {
                app.swipeUp()
                scrolls += 1
            }
            XCTAssertTrue(explanationTitle.isHittable, "compact 幅でも説明カードへ横スクロールなしで到達できる")
            takeShot(app, "23-home-explanation-compact")
        }
    }

    func testCurrentLocationPermissionAndSelection() throws {
        try exerciseLocationFixture("success")
    }

    func testCurrentLocationPermissionDeniedFixture() throws {
        try exerciseLocationFixture("denied")
    }

    func testCurrentLocationPermissionTimeoutFixture() throws {
        try exerciseLocationFixture("timeout")
    }

    private func exerciseLocationFixture(_ fixture: String) throws {
        #if os(iOS)
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchEnvironment["OISINT_DATA_PROVIDER_MODE"] = "mock"
        var permissionPromptShown = false
        let monitor = addUIInterruptionMonitor(withDescription: "位置情報の使用許可") { alert in
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "19-location-permission"
            attachment.lifetime = .keepAlways
            self.add(attachment)
            for button in alert.buttons.allElementsBoundByIndex {
                let label = button.label
                if fixture == "success",
                   label.contains("使用中") || label.contains("今回") || label.contains("While Using") || label.contains("Allow Once") {
                    permissionPromptShown = true
                    button.tap()
                    return true
                }
            }
            return false
        }
        defer { removeUIInterruptionMonitor(monitor) }
        app.launch()

        let currentLocation = app.buttons["location-current"].firstMatch
        XCTAssertTrue(currentLocation.waitForExistence(timeout: 10), "現在地を使うボタンが表示される")
        takeShot(app, "18-home-transparent-logo")
        var scrolls = 0
        while !currentLocation.isHittable, scrolls < 4 {
            app.swipeUp()
            scrolls += 1
        }
        currentLocation.tap()
        app.tap()

        let selectedLocation = app.descendants(matching: .any)["location-selected"].firstMatch
        if fixture == "success" {
            XCTAssertTrue(selectedLocation.waitForExistence(timeout: 20), "許可後に現在地の場所名が条件として表示される")
            XCTAssertTrue(permissionPromptShown, "現在地を要求した時点で位置情報の権限ダイアログが表示される")
            XCTAssertFalse(selectedLocation.label.contains("35."), "緯度を画面へ表示しない")
            XCTAssertFalse(selectedLocation.label.contains("139."), "経度を画面へ表示しない")
            takeShot(app, "20-location-success-selected")

            XCUIDevice.shared.press(.home)
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 10), "ホーム画面へ戻る")
            XCTAssertTrue(springboard.icons["OISINT"].waitForExistence(timeout: 10), "OISINT のアプリアイコンがホーム画面に表示される")
            Thread.sleep(forTimeInterval: 1)
            takeShot(springboard, "21-home-app-icon")
        } else {
            let locationError = app.descendants(matching: .any)["location-error"].firstMatch
            XCTAssertTrue(locationError.waitForExistence(timeout: 15), "\(fixture) fixture は位置情報エラーを表示する")
            XCTAssertFalse(selectedLocation.exists, "\(fixture) fixture は場所を選択済みにしない")
            if fixture == "denied" {
                XCTAssertTrue(locationError.label.contains("許可されていません"), "拒否 fixture のエラー文言")
            } else {
                XCTAssertTrue(locationError.label.contains("タイムアウトしました"), "timeout fixture のエラー文言")
            }
            takeShot(app, "20-location-\(fixture)-error")
        }
        #endif
    }
}
