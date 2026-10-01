import Foundation

/// Process-lifetime state for one logical create retry sequence.
final class CreateIdempotencyKeyState {
    private let keyFactory: () -> String
    private var fingerprint: String?
    private var key: String?

    init(keyFactory: @escaping () -> String = { UUID().uuidString.lowercased() }) {
        self.keyFactory = keyFactory
    }

    func keyFor(subject: String, input: String, displayName: String) -> String {
        let nextFingerprint = [subject, input, displayName].joined(separator: "\u{0}")
        if fingerprint == nextFingerprint, let key { return key }
        let nextKey = keyFactory()
        fingerprint = nextFingerprint
        key = nextKey
        return nextKey
    }

    func clear() {
        fingerprint = nil
        key = nil
    }
}
