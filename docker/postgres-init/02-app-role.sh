#!/bin/bash
# =============================================================================
# SECURITY FIX (DB-005 / least privilege): dedicated, NON-superuser application role.
#
# The orchestrator used to connect with POSTGRES_USER - the cluster's bootstrap SUPERUSER - for
# both its own database and provisioning. Any SQL injection or leaked DATABASE_URL was therefore
# a full cluster compromise (every tenant database, COPY ... PROGRAM, ...).
#
#   - POSTGRES_APP_USER owns POSTGRES_DB and its `public` schema (so `prisma migrate deploy`
#     works) but has no cluster-wide privilege.
#   - Provisioning keeps using POSTGRES_PROVISIONING_ROLE (CREATEDB/CREATEROLE, no superuser),
#     created by 01-provisioning-role.sh.
#   - CONNECT on POSTGRES_DB and on the `postgres` maintenance database is revoked from PUBLIC:
#     tenant roles created for generated platforms can no longer even open a session there.
#
# This script only runs on an EMPTY data volume (standard postgres image behaviour). For an
# existing volume, run docker/upgrade/2026-09-30-least-privilege.sql once (see CORRECTIONS.md).
# =============================================================================
set -euo pipefail

if [ -z "${POSTGRES_APP_USER:-}" ] || [ -z "${POSTGRES_APP_PASSWORD:-}" ]; then
    echo "ERROR: POSTGRES_APP_USER and POSTGRES_APP_PASSWORD must be set."
    exit 1
fi

psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=app_role="$POSTGRES_APP_USER" \
    --set=app_password="$POSTGRES_APP_PASSWORD" \
    --set=provision_role="$POSTGRES_PROVISIONING_ROLE" \
    --set=app_db="$POSTGRES_DB" \
    --set=ON_ERROR_STOP=1 \
    <<'SQL'

CREATE ROLE :"app_role" WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;

ALTER DATABASE :"app_db" OWNER TO :"app_role";
ALTER SCHEMA public OWNER TO :"app_role";

REVOKE CONNECT, TEMPORARY ON DATABASE :"app_db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"app_db" TO :"app_role";

REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
GRANT CONNECT ON DATABASE postgres TO :"provision_role";

SQL

echo "============================================================"
echo " PostgreSQL application role initialized"
echo " Role: ${POSTGRES_APP_USER}"
echo "============================================================"
