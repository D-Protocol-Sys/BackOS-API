#!/usr/bin/env bash
# ==============================================================================
# UNIFIED INFRASTRUCTURE ORCHESTRATION CLI
# ==============================================================================
# File: scripts/stack.sh
# Purpose: Single CLI entrypoint to manage all persistent stack environments:
#          dev (local), demo (public sandbox), prod (production), and
#          edge (shared Traefik proxy).
#
# Usage:
#   ./scripts/stack.sh up              # Starts edge + prod + demo + dev
#   ./scripts/stack.sh up prod         # Starts prod (+ edge dependency)
#   ./scripts/stack.sh down            # Stops all stacks (retains volumes)
#   ./scripts/stack.sh down dev        # Stops dev stack
#   ./scripts/stack.sh ps              # Displays status for all stacks
#   ./scripts/stack.sh logs prod       # Streams logs for prod stack
#   ./scripts/stack.sh nuke dev        # Destroys dev stack AND volumes
# ==============================================================================

# Enforce strict Bash error handling mode:
# -e: Exit immediately if a command exits with a non-zero status.
# -u: Treat unset variables as an error.
# -o pipefail: Pipeline returns the status of the last command to exit with a non-zero status.
set -euo pipefail

# Determine script root directory dynamically, ensuring correct execution context regardless of call location
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Standardized Docker Compose invocation commands configured as Bash arrays
DEV_COMPOSE=(docker compose -p "${PROJECT_NAME:-monprojet}-dev" -f docker-compose.yml --env-file .env)
LOCAL_COMPOSE=(docker compose -p "${PROJECT_NAME:-monprojet}-local" -f deploy/docker-compose.local.yml --env-file .env.local)
EDGE_COMPOSE=(docker compose -p "${PROJECT_NAME:-monprojet}-edge" -f deploy/docker-compose.edge.yml --env-file .env.production)
PROD_COMPOSE=(docker compose -p "${PROJECT_NAME:-monprojet}-prod" -f deploy/docker-compose.prod.yml --env-file .env.production)
DEMO_COMPOSE=(docker compose -p "${PROJECT_NAME:-monprojet}-demo" -f deploy/docker-compose.demo.yml --env-file .env.demo)

# ------------------------------------------------------------------------------
# HELPER FUNCTIONS
# ------------------------------------------------------------------------------

# Displays script usage guidelines extracted directly from header comments
usage() {
    echo "Usage: $0 {up|down|nuke|ps|logs} [all|edge|prod|demo|dev]"
    echo ""
    grep '^#' "$0" | sed -e 's/^#!\/.*//' -e 's/^# \{0,1\}//' | head -n 20
    exit 1
}

# Verifies required environment variable files exist before booting services
require_env_file() {
    local env_file="$1"
    if [ ! -f "$env_file" ]; then
        echo "❌ Error: Required environment file '$env_file' is missing." >&2
        echo "   Please create it by copying '${env_file}.example' before proceeding." >&2
        exit 1
    fi
}

# Subroutines defining environment startup sequences with automatic dependency handling
up_edge() {
    require_env_file .env.production
    echo "==> [edge] Starting Traefik and Docker Socket Proxy..."
    "${EDGE_COMPOSE[@]}" up -d --wait
}

up_prod() {
    require_env_file .env.production
    up_edge # Enforces edge proxy startup before booting production application
    echo "==> [prod] Starting Production stack..."
    "${PROD_COMPOSE[@]}" up -d --build --wait
}

up_demo() {
    require_env_file .env.demo
    up_edge # Enforces edge proxy startup before booting demo environment
    echo "==> [demo] Starting Demo stack..."
    "${DEMO_COMPOSE[@]}" up -d --build --wait
}

up_dev() {
    require_env_file .env
    echo "==> [dev] Starting Local Development stack..."
    "${DEV_COMPOSE[@]}" up -d --build --wait
}

up_local() {
    require_env_file .env.local
    echo "==> [local] Starting LAN-only/internal stack (no domain, no TLS, no edge)..."
    "${LOCAL_COMPOSE[@]}" up -d --build --wait
}

# ------------------------------------------------------------------------------
# COMMAND DISPATCHER
# ------------------------------------------------------------------------------

cmd="${1:-}"
target="${2:-all}"

# Prompt usage message if no CLI command is provided
[ -z "$cmd" ] && usage

case "$cmd" in
    up)
        case "$target" in
            all)   up_edge; up_prod; up_demo; up_dev ;;
            edge)  up_edge ;;
            prod)  up_prod ;;
            demo)  up_demo ;;
            dev)   up_dev ;;
            local) up_local ;;
            *) echo "❌ Unknown target: $target" >&2; exit 1 ;;
        esac
        echo "✅ Operation completed successfully. Run './scripts/stack.sh ps' to verify status."
        ;;

    down)
        case "$target" in
            all)
                echo "==> Stopping all stacks..."
                "${DEV_COMPOSE[@]}" down
                "${DEMO_COMPOSE[@]}" down
                "${PROD_COMPOSE[@]}" down
                "${EDGE_COMPOSE[@]}" down
                # "local" is intentionally NOT part of "all" - it is a standalone/internal
                # stack (no edge dependency) most people running dev+demo+prod together will
                # never have started in the first place; stop it explicitly with
                # `./scripts/stack.sh down local` instead.
                ;;
            edge)  "${EDGE_COMPOSE[@]}" down ;;
            prod)  "${PROD_COMPOSE[@]}" down ;;
            demo)  "${DEMO_COMPOSE[@]}" down ;;
            dev)   "${DEV_COMPOSE[@]}" down ;;
            local) "${LOCAL_COMPOSE[@]}" down ;;
            *) echo "❌ Unknown target: $target" >&2; exit 1 ;;
        esac
        ;;

    nuke)
        # Safety Guard 1: Prevent accidental destruction of all stacks at once
        if [ "$target" = "all" ]; then
            echo "❌ Safety restriction: 'nuke all' is forbidden. Specify a target environment (dev|demo|prod|edge)." >&2
            exit 1
        fi

        # Safety Guard 2: Require manual confirmation before deleting production volumes
        if [ "$target" = "prod" ]; then
            echo "⚠️  WARNING: You are about to DESTROY ALL PRODUCTION DATA (named volumes)!"
            read -r -p "Type 'oui' to confirm deletion: " confirm
            if [ "$confirm" != "oui" ]; then
                echo "Operation cancelled."
                exit 1
            fi
        fi

        case "$target" in
            prod)  "${PROD_COMPOSE[@]}" down -v ;;
            demo)  "${DEMO_COMPOSE[@]}" down -v ;;
            dev)   "${DEV_COMPOSE[@]}" down -v ;;
            edge)  "${EDGE_COMPOSE[@]}" down -v ;;
            local) "${LOCAL_COMPOSE[@]}" down -v ;;
            *) echo "❌ Unknown target: $target" >&2; exit 1 ;;
        esac
        ;;

    ps)
        # Display runtime status for all stacks, muting output if stack is offline
        echo "=== [ EDGE  ] ==="; "${EDGE_COMPOSE[@]}" ps 2>/dev/null || true
        echo "=== [ PROD  ] ==="; "${PROD_COMPOSE[@]}" ps 2>/dev/null || true
        echo "=== [ DEMO  ] ==="; "${DEMO_COMPOSE[@]}" ps 2>/dev/null || true
        echo "=== [ DEV   ] ==="; "${DEV_COMPOSE[@]}" ps 2>/dev/null || true
        echo "=== [ LOCAL ] ==="; "${LOCAL_COMPOSE[@]}" ps 2>/dev/null || true
        ;;

    logs)
        case "$target" in
            prod)  "${PROD_COMPOSE[@]}" logs -f ;;
            demo)  "${DEMO_COMPOSE[@]}" logs -f ;;
            dev)   "${DEV_COMPOSE[@]}" logs -f ;;
            edge)  "${EDGE_COMPOSE[@]}" logs -f ;;
            local) "${LOCAL_COMPOSE[@]}" logs -f ;;
            *) echo "❌ Unknown target: $target" >&2; exit 1 ;;
        esac
        ;;

    *)
        usage
        ;;
esac