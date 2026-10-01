import Testing
@testable import OISINTKit

@Suite struct SmokeTests {
    @Test func kitLoads() {
        #expect(OISINTKitInfo.name == "OISINTKit")
    }
}
