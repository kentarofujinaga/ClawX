# Update Review Policy

This fork uses a manual-review-only update policy.

In-app updates are intentionally disabled. Do not ship or install upstream
releases automatically.

## Review flow

1. Fetch upstream changes.
   `git fetch upstream --tags`
2. Review the commit range you plan to merge.
   `git log --oneline main..upstream/main`
   `git diff --stat main..upstream/main`
3. Inspect security-sensitive files first.
   - `electron/main/updater.ts`
   - `electron-builder.yml`
   - `package.json`
   - lockfile changes
   - `scripts/`
   - installer / packaging hooks
   - auth / token / network code
4. Check for risky changes.
   - New postinstall / release scripts
   - New remote endpoints or update feeds
   - New credential handling paths
   - Auto-update / self-update behavior changes
   - Native dependency additions
5. Run verification before merge.
   - `pnpm typecheck`
   - `pnpm test`
   - App-specific smoke tests as needed
6. Merge into this fork only after review passes.

## Minimum security checklist

- Update source is expected and authentic
- No unexpected release channel or feed change
- No silent install / auto-run / launch agent change
- No credential exfiltration path introduced
- No dependency drift without clear reason
- No packaging/signing regression

## Branching recommendation

- Keep `main` aligned with `upstream/main`
- Carry local changes on feature branches
- Rebase feature branches onto refreshed `main`
