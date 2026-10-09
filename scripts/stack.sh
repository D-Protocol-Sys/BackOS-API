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
#   ./scripts/stack.sh up prod         # Starts prod (+ edge dependency); "production" also accepted
#   ./scripts/stack.sh up local        # Starts the standalone LAN/internal stack (not part of "all")
#   ./scripts/stack.sh down            # Stops all stacks (retains volumes)
#   ./scripts/stack.sh down dev        # Stops dev stack
#   ./scripts/stack.sh ps              # Displays status for all stacks
#   ./scripts/stack.sh logs prod       # Streams logs for prod stack
#   ./scripts/stack.sh deploy prod 1.4.0   # Deploys a PUBLISHED image (pulled from the registry,
#                                          # no local build) - what the CD workflow runs
#   ./scripts/stack.sh rollback prod       # Returns prod to the previously deployed image
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

# "--build" builds the orchestrator image from the checked-out source (make up-prod, first
# install...). `deploy` / `rollback` switch it to "--no-build" so the stack runs a PUBLISHED image.
BUILD_FLAG="--build"

# ------------------------------------------------------------------------------
# HELPER FUNCTIONS
# ------------------------------------------------------------------------------

# Displays script usage guidelines extracted directly from header comments
usage() {
    echo "Usage: $0 {up|down|nuke|ps|logs} [all|edge|prod|demo|dev|local]"
    echo "       $0 deploy {prod|demo} <image-tag>"
    echo "       $0 rollback {prod|demo}"
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
    echo "==> [edge] Starting Traefik..."
    # --remove-orphans: an older edge stack also ran a shared docker-socket-proxy (now moved into
    # the prod/lan stacks, each with its own on a private network) - this cleans up that leftover.
    "${EDGE_COMPOSE[@]}" up -d --wait --remove-orphans
}

up_prod() {
    require_env_file .env.production
    up_edge # Enforces edge proxy startup before booting production application
    echo "==> [prod] Starting Production stack..."
    "${PROD_COMPOSE[@]}" up -d "$BUILD_FLAG" --wait
}

up_demo() {
    require_env_file .env.demo
    up_edge # Enforces edge proxy startup before booting demo environment
    echo "==> [demo] Starting Demo stack..."
    "${DEMO_COMPOSE[@]}" up -d "$BUILD_FLAG" --wait
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
# PUBLISHED-IMAGE DEPLOYMENT (used by the CD workflow, also usable by hand)
# ------------------------------------------------------------------------------
# The CD workflow builds, scans and SIGNS the orchestrator image and pushes it to the registry.
# `deploy` runs exactly that image (instead of rebuilding from source on the server), and keeps
# the tag of the version it replaces so `rollback` can put it back.
#
# State lives in the stack's env file (.env.production / .env.demo):
#   IMAGE_TAG            version currently deployed
#   IMAGE_TAG_PREVIOUS   version it replaced (what `rollback` restores)
#   ORCHESTRATOR_IMAGE   registry repository, e.g. ghcr.io/<owner>/<repo>

env_file_for() {
    case "$1" in
        prod) echo ".env.production" ;;
        demo) echo ".env.demo" ;;
        *) echo "❌ deploy/rollback only support 'prod' or 'demo' (got '$1')." >&2; exit 1 ;;
    esac
}

# env_get <file> <KEY>: last value of KEY in an env file (empty if absent).
env_get() {
    [ -f "$1" ] || return 0
    { grep -E "^$2=" "$1" | tail -n 1 | cut -d= -f2- | tr -d '\r'; } || true
}

# env_set <file> <KEY> <value>: replaces every line of KEY with a single fresh one. Rewrites the
# file IN PLACE (cat >) so its permissions are kept - secrets live in these files.
env_set() {
    local file="$1" key="$2" value="$3" tmp
    touch "$file"
    tmp="$(umask 077; mktemp "${file}.XXXXXX")"
    { grep -v "^${key}=" "$file" || true; echo "${key}=${value}"; } > "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
}

# Verifies the cosign (keyless, GitHub OIDC) signature the CD workflow attaches to the image.
# Enforced when cosign is installed on the host; otherwise skipped with a warning.
verify_signature() {
    local image="$1" repo="${GITHUB_REPOSITORY:-}"
    if ! command -v cosign >/dev/null 2>&1; then
        echo "⚠️  cosign is not installed on this host: image signature NOT verified." >&2
        return 0
    fi
    if [ -z "$repo" ]; then
        echo "⚠️  GITHUB_REPOSITORY is not set: image signature NOT verified." >&2
        return 0
    fi
    echo "==> Verifying image signature (cosign)..."
    cosign verify "$image" \
        --certificate-identity-regexp "^https://github.com/${repo}/.github/workflows/cd.yml@" \
        --certificate-oidc-issuer "https://token.actions.githubusercontent.com" >/dev/null
}

deploy_stack() {
    local stack="$1" tag="${2:-}"
    if [ -z "$tag" ]; then
        echo "❌ Usage: $0 deploy {prod|demo} <image-tag>" >&2
        exit 1
    fi
    local env_file
    env_file="$(env_file_for "$stack")"
    require_env_file "$env_file"

    local registry_image="${ORCHESTRATOR_IMAGE:-$(env_get "$env_file" ORCHESTRATOR_IMAGE)}"
    local project
    project="$(env_get "$env_file" PROJECT_NAME)"
    project="${project:-${PROJECT_NAME:-monprojet}}"
    # Same name the compose files give the orchestrator image: ${PROJECT_NAME}-orchestrator:${IMAGE_TAG}
    local local_image="${project}-orchestrator:${tag}"

    if docker image inspect "$local_image" >/dev/null 2>&1; then
        echo "==> [$stack] Image $local_image is already on this host - no pull needed."
    else
        if [ -z "$registry_image" ]; then
            echo "❌ Image $local_image is not on this host and ORCHESTRATOR_IMAGE is not set (e.g. ghcr.io/<owner>/<repo>)." >&2
            exit 1
        fi
        echo "==> [$stack] Pulling ${registry_image}:${tag}..."
        docker pull "${registry_image}:${tag}"
        verify_signature "${registry_image}:${tag}"
        docker tag "${registry_image}:${tag}" "$local_image"
    fi

    local current
    current="$(env_get "$env_file" IMAGE_TAG)"
    if [ -n "$current" ] && [ "$current" != "$tag" ]; then
        env_set "$env_file" IMAGE_TAG_PREVIOUS "$current"
    fi
    env_set "$env_file" IMAGE_TAG "$tag"
    if [ -n "$registry_image" ]; then
        env_set "$env_file" ORCHESTRATOR_IMAGE "$registry_image"
    fi

    echo "==> [$stack] Starting version $tag (published image, no local build)..."
    BUILD_FLAG="--no-build"
    case "$stack" in
        prod) up_prod ;;
        demo) up_demo ;;
    esac
}

rollback_stack() {
    local stack="$1"
    local env_file previous
    env_file="$(env_file_for "$stack")"
    require_env_file "$env_file"
    previous="$(env_get "$env_file" IMAGE_TAG_PREVIOUS)"
    if [ -z "$previous" ]; then
        echo "❌ [$stack] No previous version recorded in $env_file - nothing to roll back to." >&2
        echo "   (This is normal right after the very first deployment.)" >&2
        exit 1
    fi
    echo "==> [$stack] Rolling back to version $previous..."
    # Reuses deploy: the local image is normally still on the host; otherwise it is pulled again.
    # The version being replaced becomes the new "previous", so running rollback twice toggles.
    deploy_stack "$stack" "$previous"
}

# ------------------------------------------------------------------------------
# COMMAND DISPATCHER
# ------------------------------------------------------------------------------

cmd="${1:-}"
target="${2:-all}"

# The CD workflow passes the GitHub Environment name ("production"); the stack itself is "prod".
case "$target" in production) target="prod" ;; esac

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

    deploy)
        deploy_stack "$target" "${3:-}"
        echo "✅ Deployed. Run './scripts/stack.sh ps' to verify status."
        ;;

    rollback)
        rollback_stack "$target"
        echo "✅ Rolled back. Run './scripts/stack.sh ps' to verify status."
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