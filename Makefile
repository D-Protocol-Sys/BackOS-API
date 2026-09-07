.PHONY: up up-dev up-demo up-prod down ps logs-dev logs-demo logs-prod nuke-dev nuke-demo

## Une seule commande pour lancer dev + demo + prod en même temps :
up:
	./scripts/stack.sh up all

up-dev:
	./scripts/stack.sh up dev

up-demo:
	./scripts/stack.sh up demo

up-prod:
	./scripts/stack.sh up prod

down:
	./scripts/stack.sh down all

ps:
	./scripts/stack.sh ps

logs-dev:
	./scripts/stack.sh logs dev

logs-demo:
	./scripts/stack.sh logs demo

logs-prod:
	./scripts/stack.sh logs prod

nuke-dev:
	./scripts/stack.sh nuke dev

nuke-demo:
	./scripts/stack.sh nuke demo
