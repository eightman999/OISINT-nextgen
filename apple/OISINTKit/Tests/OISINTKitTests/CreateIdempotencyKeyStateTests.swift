import Testing
@testable import OISINTKit

@Suite struct CreateIdempotencyKeyStateTests {
    @Test func timeoutRetryReusesKeyForSameAuthAndInput() {
        var issued = 0
        let state = CreateIdempotencyKeyState {
            issued += 1
            return "key-\(issued)"
        }

        let first = state.keyFor(subject: "user-a", input: "池袋", displayName: "利用者")
        let retry = state.keyFor(subject: "user-a", input: "池袋", displayName: "利用者")

        #expect(first == retry)
        #expect(issued == 1)
    }

    @Test func inputAuthAndSuccessRotateKey() {
        var issued = 0
        let state = CreateIdempotencyKeyState {
            issued += 1
            return "key-\(issued)"
        }

        let first = state.keyFor(subject: "user-a", input: "池袋", displayName: "利用者")
        let changedInput = state.keyFor(subject: "user-a", input: "新宿", displayName: "利用者")
        let changedAuth = state.keyFor(subject: "user-b", input: "新宿", displayName: "利用者")
        state.clear()
        let afterSuccess = state.keyFor(subject: "user-b", input: "新宿", displayName: "利用者")

        #expect(first != changedInput)
        #expect(changedInput != changedAuth)
        #expect(changedAuth != afterSuccess)
        #expect(issued == 4)
    }
}
