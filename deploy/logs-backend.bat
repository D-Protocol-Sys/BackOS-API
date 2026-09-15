@echo off
cd /d "%~dp0.."
echo Affichage des logs de l'orchestrateur (Ctrl+C pour quitter, le backend continue de tourner)...
docker compose -f deploy\docker-compose.lan.yml --env-file .env.lan logs -f orchestrator
