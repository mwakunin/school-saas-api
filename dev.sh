#!/usr/bin/env bash
# Bring up local dev dependencies (Postgres dev + test, Redis).
set -euo pipefail

docker compose up -d

SERVICES=(school-postgres-dev school-postgres-test school-redis-dev)
TIMEOUT=60

health() {
  # Missing container reports "missing" rather than failing under `set -e`.
  docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null || echo missing
}

echo "Waiting for services to be healthy (timeout ${TIMEOUT}s)..."
deadline=$(( SECONDS + TIMEOUT ))

while true; do
  unhealthy=()
  for svc in "${SERVICES[@]}"; do
    [ "$(health "$svc")" = "healthy" ] || unhealthy+=("$svc")
  done

  [ ${#unhealthy[@]} -eq 0 ] && break

  # A container that never goes healthy — a port clash, a corrupt volume —
  # would otherwise hang this script forever with no explanation.
  if [ $SECONDS -ge $deadline ]; then
    echo
    echo "Timed out after ${TIMEOUT}s. These are not healthy:" >&2
    for svc in "${unhealthy[@]}"; do
      echo "  - $svc: $(health "$svc")" >&2
      docker logs --tail 20 "$svc" 2>&1 | sed "s/^/      /" >&2
    done
    exit 1
  fi

  sleep 1
done

echo "Dev services ready:"
echo "  Postgres (dev):  postgresql://school:school@localhost:5436/school_dev"
echo "  Postgres (test): postgresql://school:school@localhost:5435/school_test"
echo "  Redis:           redis://localhost:6381"
