# Contributing to OISINT

Contributions are welcome when they improve the public application, its tests,
or its reproducible local demo.

By submitting a contribution, you confirm that you have the right to submit it
and agree that it may be distributed under the repository's
`AGPL-3.0-only` license. Do not submit secrets, personal data, production
credentials, private operations material, or code copied from a source whose
license does not permit redistribution.

Please run the relevant checks before opening a pull request:

```bash
npm test
npx tsc --noEmit
npm run lint
```
