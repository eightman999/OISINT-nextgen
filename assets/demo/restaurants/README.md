# Restaurant illustration catalog

This directory preserves the generated illustration catalog and its provenance.
As of 2026-09-22, Web, iOS, and Android do not display these images, including
when a restaurant has no provider photo. Existing database keys and metadata
are retained for compatibility; the JPEGs are not imported by the candidate UI.

## Contract

- `catalog.json` is the audit manifest for the 20 bundled JPEGs.
- `items[].key` is immutable for a given byte sequence. Replace changed artwork
  with a new versioned key such as `-v2.jpg`; do not replace `-v1.jpg` in
  place.
- There is no separate `slug` or display `label`: the stable key already
  supplies machine identity, alias arrays supply matching terms, and the card
  displays the restaurant's own genre. Duplicating those values would create
  another drift-prone source of truth.
- `contentSha256` binds each key to the checked-in bytes.
- `fallbackSlot` follows `RESTAURANT_IMAGE_KEYS` order.
- `genrePriority`, `aliases`, and `exactAliases` follow
  `GENRE_IMAGE_RULES` order. Exact aliases preserve rules such as matching
  `パン` without treating `シャンパン` as a bakery. These fields mirror the
  bundled resolver for drift auditing; the current client does not fetch them.
- `active` controls whether a database-assigned manual
  `places.fallback_image_key` is exposed to the current client. These keys
  remain metadata only; neither manual keys nor genre/hash fallbacks are displayed.
- `provenance` contains public-safe origin metadata only. Prompts, credentials,
  provider payloads, and personal data do not belong here.

The corresponding database migration is
`supabase/migrations/20260816044234_restaurant_image_catalog.sql`. It adds
`places.fallback_image_key` as a nullable foreign key. Provider-owned
`places.metadata.photoUrl` remains separate. Only an HTTPS photo on the approved
host list can be displayed. The current host list is empty; missing or rejected
photos render the genre and rank on a color panel without generated artwork.

A generated illustration is presentation metadata, not OSINT Evidence.
Authenticated clients can select only `image_key` and `active` catalog
columns; aliases, hashes, and provenance remain service-side audit data.

## Verification

```bash
npm run test:migration:restaurant-images
```

The test checks the 20-key manifest against the resolver, alias priority,
on-disk JPEG dimensions and SHA-256 values, the SQL seed, FK behavior,
client/service-role grants, RLS filtering, and preservation of a manual
fallback key during a provider metadata upsert.

The SQL assertions run in an in-memory PGlite database with a temporary Deno
cache. They do not require or mutate a local/linked Supabase project. The Deno
test file is excluded from the Expo TypeScript project, just like the existing
personalization migration harness, and is type-checked independently by
`deno check` before execution.
