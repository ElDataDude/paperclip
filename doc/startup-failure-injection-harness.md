# Startup Failure-Injection Harness (PAT-62)

This harness provides a deterministic, single-command QA check for startup failure-injection scenarios required by [PAT-57](/PAT/issues/PAT-57).

## One Command

```bash
pnpm qa:startup-failure-injection-harness
```

Optional custom artifact location:

```bash
pnpm qa:startup-failure-injection-harness -- --artifact artifacts/startup-failure-injection-report.json
```

## What It Verifies

1. Missing startup file/path failure classification:
1. `missing_file` when a startup file referenced by bundle load order is deleted.
1. `invalid_file_path` when a startup bundle entry path is non-absolute.
1. Long-memory pressure + deterministic truncation assertions:
1. fixed section order: `identity -> task -> safety -> persona -> instructions`
1. deterministic truncation point under constrained budget
1. deterministic dropped sections when budget is exceeded

## Output Contract

- Console emits one line per scenario:
  - `PASS <scenario-id>: <reason>`
  - `FAIL <scenario-id>: <reason>`
- JSON artifact is written to:
  - `artifacts/startup-failure-injection-report.json` (default)
- Artifact includes:
  - overall `summary.status` (`pass` | `fail`)
  - per-scenario `status` + `reason`
  - scenario details for machine checks (observed categories, token budget plan)

If any scenario fails, the command exits with code `1`.
