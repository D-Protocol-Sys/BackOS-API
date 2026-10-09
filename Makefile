.PHONY: up up-dev up-demo up-prod up-local down down-local ps logs-dev logs-demo logs-prod logs-local nuke-dev nuke-demo

## Une seule commande pour lancer dev + demo + prod en même temps :
up:
	./scripts/stack.sh up all

up-dev:
	./scripts/stack.sh up dev

up-demo:
	./scripts/stack.sh up demo

up-prod:
	./scripts/stack.sh up prod

## Pile LAN/interne autonome (deploy/docker-compose.local.yml) - hors de "make up".
up-local:
	./scripts/stack.sh up local

down:
	./scripts/stack.sh down all

down-local:
	./scripts/stack.sh down local

ps:
	./scripts/stack.sh ps

logs-dev:
	./scripts/stack.sh logs dev

logs-demo:
	./scripts/stack.sh logs demo

logs-prod:
	./scripts/stack.sh logs prod

logs-local:
	./scripts/stack.sh logs local

nuke-dev:
	./scripts/stack.sh nuke dev

nuke-demo:
	./scripts/stack.sh nuke demo
