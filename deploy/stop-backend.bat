@echo off
REM Double-clique sur ce fichier pour arreter le backend et liberer les
REM ressources (CPU/RAM) le temps de faire autre chose sur PC1.
REM Les donnees (base de donnees, utilisateurs...) sont conservees : le
REM prochain demarrage retrouvera tout comme avant.

cd /d "%~dp0.."
echo Arret du backend...
docker compose -f deploy\docker-compose.lan.yml --env-file .env.lan stop

echo.
echo Backend arrete. Relance-le avec start-backend.bat
pause
