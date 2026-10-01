import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// クリップボード（web navigator.clipboard.writeText 相当）
public enum Pasteboard {
    /// コピー成功なら true（web 実装の then/catch に対応）
    @MainActor
    public static func copy(_ text: String) -> Bool {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        return true
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(text, forType: .string)
        #else
        return false
        #endif
    }
}

/// URL を既定ブラウザで開く（web Linking.openURL 相当。§3.6-7: OS 慣習を優先）
public enum PlatformOpener {
    @MainActor
    public static func open(_ url: URL) {
        #if canImport(UIKit)
        UIApplication.shared.open(url)
        #elseif canImport(AppKit)
        NSWorkspace.shared.open(url)
        #endif
    }
}
