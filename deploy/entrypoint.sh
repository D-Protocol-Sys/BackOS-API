#!/bin/sh
# ==============================================================================
# CONTAINER ENTRYPOINT SCRIPT
# ==============================================================================
# Execution Context: Runs as the initial container startup script across all 
#                    environments (development, demo, production).
# Key Responsibilities:
#   1. Enforce strict failure handling (`set -e`).
#   2. Execute Prisma database schema migrations idempotently.
#   3. Populate core system seeding (roles, permissions, default owner).
#   4. Provision demo datasets conditionally (`RUN_DEMO_SEED=1`).
#   5. Hand off process execution to the main container command (`exec "$@"`).
# ==============================================================================

# Exit immediately if a command exits with a non-zero status
set -e

echo "[entrypoint] Starting application entrypoint sequence..."

# ------------------------------------------------------------------------------
# 1. Database Migrations
# ------------------------------------------------------------------------------
# Applies all pending Prisma database schema migrations in production mode.
# Safe for repeated executions (idempotent operation).
echo "[entrypoint] Applying database migrations..."
pnpm exec prisma migrate deploy

# ------------------------------------------------------------------------------
# 2. Base Database Seeding
# ------------------------------------------------------------------------------
# Populates mandatory operational data (roles, permissions, system accounts).
# Should be designed to be idempotent (no-op on subsequent container restarts).
echo "[entrypoint] Executing base database seed (roles, permissions, owner)..."
pnpm exec prisma db seed

# ------------------------------------------------------------------------------
# 3. Optional Demo Environment Seeding
# ------------------------------------------------------------------------------
# Conditionally triggers demo dataset provisioning when explicitly requested.
if [ "${RUN_DEMO_SEED:-0}" = "1" ]; then
    echo "[entrypoint] RUN_DEMO_SEED=1 detected. Provisioning read-only demo account..."
    
    # Environment variable verification to prevent silent configuration failures
    if [ -z "${DEMO_WORKEMAIL}" ] || [ -z "${DEMO_TOTP_SECRET}" ] || [ -z "${ENCRYPTION_KEY}" ]; then
        echo "[entrypoint] ERROR: Missing required demo seed variables (DEMO_WORKEMAIL, DEMO_TOTP_SECRET, ENCRYPTION_KEY)." >&2
        exit 1
    fi

    # Executes demo seed script via ts-node
    pnpm exec ts-node prisma/seed-demo.ts
fi

# ------------------------------------------------------------------------------
# 4. Process Handoff (PID 1 Preservation)
# ------------------------------------------------------------------------------
# Replaces the entrypoint Shell process with the primary container command (CMD).
# Ensures signals like SIGTERM are sent directly to the Node.js application.
echo "[entrypoint] Initialization complete. Launching main process: $*"
exec "$@"