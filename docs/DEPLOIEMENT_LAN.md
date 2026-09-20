# Déploiement : LAN (instance privée, réseau local)

## Ce que c'est

Une instance stable, construite avec la même image durcie que la démo/production (pas de
rechargement à chaud), mais **sans domaine public, sans TLS, sans Traefik** - accessible
uniquement depuis ton réseau local, via l'adresse IP de la machine qui l'héberge.

Le tray Windows (icône dans la barre système, `deploy/backend-tray.ps1`) **n'est pas un mode de
déploiement séparé** - c'est une interface graphique qui pilote exactement cette même pile
(`docker compose -f deploy/docker-compose.lan.yml`). Utiliser le tray ou taper la commande
toi-même revient strictement au même conteneur, avec le même niveau de sécurité.

> **Pourquoi ce fichier et pas `docker-compose.local.yml`** : les deux fichiers résolvent le même
> besoin (voir `docs/README.md` §6). `docker-compose.lan.yml` est celui documenté ici parce que
> c'est le seul relié à un outil réellement utilisé au quotidien (le tray). Si tu préfères
> `local.yml`/`make up-local`, la logique de ce guide s'applique de la même façon - seuls les noms
> de fichiers `.env` changent (`.env.local` au lieu de `.env.lan`).

## Ce que ça entraîne

- Le port de l'app (`4803` par défaut) est publié directement sur l'hôte -
  `http://<IP-LAN-de-la-machine>:4803` depuis n'importe quel appareil du même réseau.
- **Aucun chiffrement TLS par nature** (pas de nom de domaine, pas de certificat) - les identifiants
  et les JWT transitent en clair sur le réseau local. Acceptable sur un réseau domestique/bureau
  de confiance ; à ne jamais laisser glisser vers un Wi-Fi public sans un tunnel par-dessus (voir
  `DEPLOIEMENT_WIREGUARD.md`).
- Pas d'accès Docker pour la génération de backends via conteneurs
  (`DockerRuntimeManagerService` non activé dans cette pile) - les plateformes générées tournent
  en process natif.
- `generated_projects` est un volume Docker nommé (pas un bind-mount de chemin hôte), pour éviter
  les soucis de chemins Windows.

## Étapes

1. **Prérequis** : Docker Desktop installé et lancé sur la machine qui servira de serveur.

2. **Configuration** :
   ```powershell
   cd deploy
   copy ..\.env.lan.example ..\.env.lan
   ```
   Remplis chaque `REPLACE_ME_...` dans `.env.lan` : `PROJECT_NAME`, secrets
   (`ENCRYPTION_KEY`, `JWT_SECRET`), identifiants Postgres/Redis, `OWNER_*` (compte créé
   automatiquement au premier démarrage).

3. **Premier démarrage - via le tray** :
   ```powershell
   .\start-backend.bat
   ```
   Une icône apparaît dans la barre système. Clic droit pour : démarrer, arrêter, voir les logs
   (`logs-backend.bat`), voir le statut (`status-backend.bat`).

   **Ou directement en ligne de commande**, équivalent strict :
   ```powershell
   docker compose -f docker-compose.lan.yml --env-file ..\.env.lan up -d --build
   ```

4. **Récupérer les identifiants du compte owner** (imprimés une seule fois dans les logs au tout
   premier démarrage) :
   ```powershell
   .\logs-backend.bat
   ```

5. **Se connecter** : `http://<IP-LAN-de-la-machine>:4803` depuis n'importe quel appareil du même
   réseau (PC2, téléphone en wifi maison, etc.).

6. **Libérer les ressources de la machine à la demande** (ex. avant une session de travail
   gourmande en CPU/RAM sur autre chose) : arrêt via le tray, sans rien désinstaller ni perdre de
   données (volumes nommés persistants) :
   ```powershell
   .\stop-backend.bat
   ```

## Avantages

- Zéro dépendance à un service tiers, zéro configuration réseau complexe (pas de
  port-forwarding, pas de nom de domaine).
- Pilotable sans ligne de commande grâce au tray - accessible à quelqu'un qui ne connaît pas
  Docker.
- Même image durcie que production/démo (`cap_drop: ALL`, non-root, limites CPU/mémoire) - pas un
  environnement "au rabais".

## Inconvénients

- Pas de TLS - jamais accessible en toute sécurité hors du réseau local sans un tunnel (voir
  `DEPLOIEMENT_WIREGUARD.md`).
- Pas de génération de backends via Docker par défaut dans cette pile.
- Doublon avec `docker-compose.local.yml` (voir l'encart plus haut) - à surveiller si les deux
  fichiers commencent à diverger dans le temps.

## Combinaisons possibles à partir de ce mode

- **+ WireGuard** (`DEPLOIEMENT_WIREGUARD.md`) : accès distant chiffré sans jamais exposer le
  port 4803 directement à Internet.
- **+ Démo + WireGuard, sur une seule machine** (`DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md`) : le
  cas où tu n'as qu'un seul PC disponible pour à la fois ton instance privée et une démo
  publique.
