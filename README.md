# OISINT

> 根拠つきの調査で、みんなの店選びを支える。

OISINT is a collaborative restaurant research app. It turns a natural-language
request into candidate places, gathers public evidence, shows source URLs and
uncertainty, and lets a group compare and vote on the result.

This repository is a sanitized public snapshot prepared for the RevenueCat
Shipaton Next Gen Award. It contains the application, public demo assets,
local mock providers, Supabase migrations/functions, API code, and tests. It
does not contain production credentials, deployment workflows, private
operations material, or store-signing assets.

## Demo

- Web demo: <https://oisint.com/DEMO>
- Product video: <https://youtu.be/i-6UBDHzch8>

The Next Gen submission is evaluated from the demo video and this public code
repository. External provider credentials are optional for the deterministic
mock path.

## Local web demo

Requirements: Node.js 22 or newer.

```bash
npm ci
cp .env.example .env
npm run web
```

Open the URL printed by Expo. The default mock mode is designed for local and
CI runs without provider keys.

Useful checks:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run export
bash scripts/check-secret-leak.sh
```

The Supabase functions and migrations are included for architecture review and
local testing. To use live providers, configure their secrets in a local
Supabase secret store; do not add them to `.env` or source files.

## Project shape

- `app/`, `src/`: Expo Router UI and application logic
- `supabase/`: migrations, Edge Functions, seed data, and tests
- `apps/api/`: Cloudflare Worker API and tests
- `android/`, `apple/`: native clients and shared Swift package sources
- `assets/`, `public/`: demo and branding assets

The core flow is:

```text
request → discover candidates → investigate public evidence →
evaluate requirements → show sources and uncertainty → collaborate and vote
```

## RevenueCat integration

OISINT Plus is an auto-renewable subscription (monthly / annual) sold through
RevenueCat on both native clients. The permanent account UUID is the RevenueCat
App User ID. Email addresses and investigation text are never used as billing
identifiers.

| Layer | What it does | Where |
|---|---|---|
| iOS | Offerings, purchase, restore, log in/out, `plus` entitlement mapping | [`RevenueCatEntitlementProvider.swift`](apple/OISINTKit/Sources/OISINTKit/Entitlements/RevenueCatEntitlementProvider.swift), [`PlusPaywallView.swift`](apple/OISINTKit/Sources/OISINTKit/Views/PlusPaywallView.swift) |
| Android | Same contract with Google Play base plans and package selection | [`RevenueCatEntitlementProvider.kt`](android/app/src/main/kotlin/com/oisint/android/entitlement/RevenueCatEntitlementProvider.kt), [`RevenueCatPackageSelectionTest.kt`](android/app/src/test/kotlin/com/oisint/android/entitlement/RevenueCatPackageSelectionTest.kt) |
| Server | Webhook with Bearer + HMAC verification that syncs entitlements into Postgres | [`revenuecat-webhook`](supabase/functions/revenuecat-webhook/index.ts), [`_shared/revenuecat*.ts`](supabase/functions/_shared/) |
| Database | Entitlement table, plus lifecycle reconciliation for out-of-order events (cancellation, billing issue, product change, pause) | [`202608240002_revenuecat_entitlements.sql`](supabase/migrations/202608240002_revenuecat_entitlements.sql), [`202608240005_revenuecat_lifecycle_reconciliation.sql`](supabase/migrations/202608240005_revenuecat_lifecycle_reconciliation.sql) |

Design choices:

- **Fail-closed entitlement.** The clients confirm Plus by asking the server for
  its verified status. The local SDK cache alone does not unlock Plus. Events
  without a signed expiry or grace period never grant access.
- **One contract, two platforms.** iOS and Android implement the same
  `EntitlementProvider` interface, so the UI and tests do not depend on the
  store.
- **Account deletion** starts a RevenueCat customer deletion request. It does
  not silently cancel store subscriptions; the paywall and account screen say
  so.

## License and third-party code

Original OISINT application code in this snapshot is licensed under
`AGPL-3.0-only`; see [`LICENSE`](./LICENSE). Contributors have authorized this
public snapshot. Third-party libraries, SDKs, fonts, images, and other
components remain under their respective licenses. Their notices and license
metadata must be preserved when redistributing this project.

This repository is not a relicensing of third-party dependencies. See the
package manifests and lockfiles for the dependency boundary.

## Security

Never commit provider keys, service-role keys, signing credentials, private
URLs, or user data. Use the mock provider for reproducible local testing and
report suspected issues privately to the project owner.
