import Foundation
import Testing
@testable import OISINTKit

@Suite struct AuthTransportTests {
    @Test func deleteResponseRequiresExactStrictSchemaAndUtf8() {
        #expect(AuthService.decodeDeleteResponse(Data(#"{"deleted":true}"#.utf8)))
        #expect(!AuthService.decodeDeleteResponse(Data(#"{"deleted":false}"#.utf8)))
        #expect(!AuthService.decodeDeleteResponse(Data(#"{"deleted":true,"unexpected":"x"}"#.utf8)))
        #expect(!AuthService.decodeDeleteResponse(Data(#"{"deleted":"true"}"#.utf8)))
        #expect(!AuthService.decodeDeleteResponse(Data(#"{"deleted":1}"#.utf8)))
        #expect(!AuthService.decodeDeleteResponse(Data(#"{"deleted":null}"#.utf8)))
        #expect(!AuthService.decodeDeleteResponse(Data([0x7b, 0xff, 0x7d])))
    }

    @Test func providerFactoryRejectsCredentialAndRedirectLikeSupabaseOrigins() {
        let invalid = [
            "http://project-ref.supabase.co",
            "https://user:secret@project-ref.supabase.co",
            "https://project-ref.supabase.co:8443",
            "https://project-ref.supabase.co/functions/v1",
            "https://project-ref.supabase.co?next=https://attacker.example",
            "https://attacker.example/project-ref.supabase.co",
        ]
        for value in invalid {
            let configuration = ProviderFactory.LiveConfiguration(
                supabaseURL: URL(string: value)!,
                supabaseAnonKey: "public-anon-key",
                apiBaseURL: URL(string: "https://api.oisint.com")!
            )
            #expect(throws: Error.self) {
                try ProviderFactory.make(mode: .live, liveConfiguration: configuration)
            }
        }
    }
}
