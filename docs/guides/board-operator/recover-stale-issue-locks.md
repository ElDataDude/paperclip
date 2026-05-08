# Recover Stale Issue Execution Locks

Use this runbook when issues are not `in_progress` but checkout returns `Issue checkout conflict` due to lingering `executionRunId`.

## What the Repair Does

- finds issues with non-null `executionRunId` that should no longer hold execution locks
- clears `executionRunId` and `executionLockedAt`
- clears `checkoutRunId` for non-`in_progress` issues
- runs as dry-run by default

## Prerequisites

- terminal access to the Paperclip repo
- `DATABASE_URL` or `PAPERCLIP_DATABASE_URL` set

## Dry Run

```bash
pnpm issues:repair-execution-locks
```

Optional scope by company:

```bash
pnpm issues:repair-execution-locks --company-id=<company-id>
```

## Apply Changes

```bash
pnpm issues:repair-execution-locks --apply
```

## Optional In-Progress Cleanup

By default the script does not touch `in_progress` issues. To also clear stale/missing run locks for `in_progress` issues:

```bash
pnpm issues:repair-execution-locks --include-in-progress-stale-run --apply
```

Use this only when you have confirmed the linked run is terminal or missing.
