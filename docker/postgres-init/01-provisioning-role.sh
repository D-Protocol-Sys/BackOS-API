#!/bin/bash

# =============================================================================
# Shell Safety Options
# =============================================================================
# -e : Exit immediately if any command exits with a non-zero status.
# -u : Treat unset variables as an error when expanding them.
# -o pipefail : Return status of the last command in a pipeline that failed.
set -euo pipefail

# =============================================================================
# 1. Environment Variables Validation
# =============================================================================
# Ensure that essential secrets and configuration names are provided before 
# attempting any database administrative actions.

if [ -z "${POSTGRES_PROVISIONING_PASSWORD:-}" ]; then
    echo "ERROR: POSTGRES_PROVISIONING_PASSWORD is not set."
    exit 1
fi

if [ -z "${POSTGRES_PROVISIONING_ROLE:-}" ]; then
    echo "ERROR: POSTGRES_PROVISIONING_ROLE is not set."
    exit 1
fi

# =============================================================================
# 2. PostgreSQL Role Creation via psql CLI
# =============================================================================
# Executes a SQL script against PostgreSQL using psql variable binding.
#
# Key Options Used:
# --username          : Connects as the default admin user (from env).
# --dbname            : Targets the initial admin database (from env).
# --set=var=val       : Passes Bash variables safely into psql session variables.
#                       - :"provision_role" interpolates as a SQL Identifier.
#                       - :'provision_password' interpolates as a SQL String Literal.
# --set=ON_ERROR_STOP : Forces psql to abort execution instantly if SQL fails.
psql \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=provision_role="$POSTGRES_PROVISIONING_ROLE" \
    --set=provision_password="$POSTGRES_PROVISIONING_PASSWORD" \
    --set=ON_ERROR_STOP=1 \
    <<'SQL'

/*
 * Create the dedicated administrative role used by the BackOS ProvisioningService.
 *
 * Granted Capabilities:
 * - LOGIN      : Allows this role to establish active DB client connections.
 * - CREATEDB   : Grants permission to dynamically spin up tenant databases.
 * - CREATEROLE : Grants permission to dynamically spin up tenant-isolated roles.
 */
CREATE ROLE :"provision_role"
WITH
    LOGIN
    PASSWORD :'provision_password'
    CREATEDB
    CREATEROLE;

SQL

echo "============================================================"
echo " PostgreSQL provisioning role initialized"
echo " Role: ${POSTGRES_PROVISIONING_ROLE}"
echo "============================================================"