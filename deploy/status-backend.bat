@echo off
cd /d "%~dp0.."
docker compose -f deploy\docker-compose.lan.yml --env-file .env.lan ps
pause
