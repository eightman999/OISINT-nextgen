import Foundation
import Testing
import OISINTKit
import OISINTKitDebugFixtures

@Suite struct AppProviderFactoryTests {
    @Test func debugAppSupportInjectsFixtureAndLiveStillUsesCoreFactory() throws {
        #if DEBUG
        let provider = try ProviderFactory.make(mode: .mock, liveConfiguration: nil)
        #expect((provider as? MockProvider) != nil)
        #else
        #expect(throws: Error.self) {
            try ProviderFactory.make(mode: .mock, liveConfiguration: nil)
        }
        #endif

        let liveConfiguration = ProviderFactory.LiveConfiguration(
            supabaseURL: URL(string: "https://project-ref.supabase.co")!,
            supabaseAnonKey: "public-anon-key",
            apiBaseURL: URL(string: "https://api.oisint.com")!
        )
        let live = try ProviderFactory.make(mode: .live, liveConfiguration: liveConfiguration)
        #expect(live is LiveProvider)
    }
}
