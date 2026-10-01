# Third-party notices

The `AGPL-3.0-only` license in the repository root applies to original OISINT
code only. It does not replace the licenses of dependencies or separately
licensed assets.

The JavaScript dependency lockfiles record the license metadata for the npm
dependency trees. The native Swift package is pinned in
`apple/OISINTKit/Package.resolved`; the direct Supabase Swift and RevenueCat
Purchases SDKs are MIT-licensed upstream projects:

- [supabase-swift](https://github.com/supabase/supabase-swift)
- [purchases-ios](https://github.com/RevenueCat/purchases-ios)

When redistributing a build, retain the corresponding upstream copyright and
license notices. A dependency's permissive license does not make that
dependency OISINT code, and this repository does not claim to relicense it
under AGPL.
