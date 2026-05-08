#!/usr/bin/env bash
set -euo pipefail

APPLY=false
COMPANY_ID=""
INCLUDE_IN_PROGRESS_STALE_RUN=false

for arg in "$@"; do
  case "$arg" in
    --apply)
      APPLY=true
      ;;
    --include-in-progress-stale-run)
      INCLUDE_IN_PROGRESS_STALE_RUN=true
      ;;
    --company-id=*)
      COMPANY_ID="${arg#*=}"
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

DATABASE_URL="${DATABASE_URL:-${PAPERCLIP_DATABASE_URL:-}}"
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL or PAPERCLIP_DATABASE_URL is required" >&2
  exit 1
fi

if [ "$INCLUDE_IN_PROGRESS_STALE_RUN" = true ]; then
  CANDIDATE_WHERE="
    i.execution_run_id IS NOT NULL
    AND (
      i.status <> 'in_progress'
      OR r.id IS NULL
      OR r.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
    )
  "
else
  CANDIDATE_WHERE="
    i.execution_run_id IS NOT NULL
    AND i.status <> 'in_progress'
  "
fi

if [ -n "$COMPANY_ID" ]; then
  CANDIDATE_WHERE="$CANDIDATE_WHERE
    AND i.company_id = '$COMPANY_ID'"
fi

read -r -d '' PREVIEW_SQL <<SQL || true
WITH candidates AS (
  SELECT
    i.id,
    i.identifier,
    i.status,
    i.checkout_run_id,
    i.execution_run_id,
    r.status AS run_status
  FROM issues i
  LEFT JOIN heartbeat_runs r ON r.id = i.execution_run_id
  WHERE $CANDIDATE_WHERE
)
SELECT
  id,
  identifier,
  status,
  COALESCE(checkout_run_id::text, 'null') AS checkout_run_id,
  COALESCE(execution_run_id::text, 'null') AS execution_run_id,
  COALESCE(run_status, 'missing') AS run_status
FROM candidates
ORDER BY identifier;
SQL

CANDIDATES=()
PREVIEW_ROWS="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -A -F '|' -t -c "$PREVIEW_SQL")"
while IFS= read -r line; do
  [ -n "$line" ] || continue
  CANDIDATES+=("$line")
done <<< "$PREVIEW_ROWS"

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "No stale issue execution locks detected."
  exit 0
fi

echo "Found ${#CANDIDATES[@]} stale issue execution lock(s):"
for row in "${CANDIDATES[@]}"; do
  IFS='|' read -r id identifier status checkout_run_id execution_run_id run_status <<< "$row"
  echo "- $identifier ($id) status=$status checkoutRunId=$checkout_run_id executionRunId=$execution_run_id runStatus=$run_status"
done

if [ "$APPLY" != true ]; then
  echo "Dry run only. Re-run with --apply to clear stale execution locks."
  exit 0
fi

read -r -d '' APPLY_SQL <<SQL || true
WITH candidates AS (
  SELECT i.id, i.status
  FROM issues i
  LEFT JOIN heartbeat_runs r ON r.id = i.execution_run_id
  WHERE $CANDIDATE_WHERE
),
updated AS (
  UPDATE issues i
  SET
    execution_run_id = NULL,
    execution_locked_at = NULL,
    checkout_run_id = CASE WHEN c.status = 'in_progress' THEN i.checkout_run_id ELSE NULL END,
    updated_at = NOW()
  FROM candidates c
  WHERE i.id = c.id
  RETURNING i.id
)
SELECT COUNT(*)::int FROM updated;
SQL

UPDATED_COUNT="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -A -t -c "$APPLY_SQL" | tr -d '[:space:]')"
echo "Cleared stale execution locks for ${UPDATED_COUNT:-0} issue(s)."
