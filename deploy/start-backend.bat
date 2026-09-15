@echo off
REM Double-clique sur ce fichier (ou mets-en un raccourci sur le bureau)
REM pour demarrer le backend. Fenetre a garder ouverte ou fermer, le backend
REM continue de tourner en arriere-plan (mode "detached").

cd /d "%~dp0.."
echo Demarrage du backend (Postgres + Redis + orchestrateur)...
docker compose -f deploy\docker-compose.lan.yml --env-file .env.lan up -d --build

echo.
echo Backend demarre. Verifie l'etat avec status-backend.bat
echo Recupere le lien d'activation du compte owner (1er demarrage uniquement) avec logs-backend.bat
pause
