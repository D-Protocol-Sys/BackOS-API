# Déploiement : Dev (poste de développement)

## Ce que c'est

Ton environnement de travail au quotidien. Seuls Postgres et Redis tournent en conteneur ; l'API
elle-même tourne **nativement** sur ta machine avec rechargement à chaud (`pnpm run start:dev`) -
pas de conteneur pour l'app, pour que chaque sauvegarde de fichier redémarre le serveur en une
fraction de seconde.

## Ce que ça entraîne

- Aucune exposition réseau au-delà de ta machine : Postgres/Redis liés à `127.0.0.1` uniquement.
- Swagger activé (`/api` ou équivalent selon `env.validation.ts`), aucune contrainte de sécurité
  particulière puisque rien n'est jamais joignable depuis l'extérieur.
- Les migrations Prisma doivent être appliquées manuellement (`prisma migrate dev`), pas
  automatiquement comme dans les piles Docker complètes (`deploy/entrypoint.sh`).

## Étapes

1. **Dépendances système** : Docker Desktop (pour Postgres/Redis uniquement), Node.js 22+, `pnpm`
   (`corepack enable`).

2. **Configuration** :
   ```bash
   cp .env.development.example .env
   ```
   Édite `.env` : change au minimum `ENCRYPTION_KEY` (`openssl rand -hex 32`) et `JWT_SECRET`
   (`openssl rand -base64 48`) - l'app refuse de démarrer avec les valeurs d'exemple.

3. **Démarrer les dépendances** (Postgres + Redis uniquement) :
   ```bash
   docker compose up -d
   ```
   `docker-compose.yml` (racine) démarre `postgres-dev` (port `5432`, loopback uniquement) et
   `redis-dev` (port `6379`, loopback uniquement), avec un volume nommé persistant - tes données
   de dev survivent à un redémarrage.

4. **Installer les dépendances et préparer la base** :
   ```bash
   pnpm install
   pnpm exec prisma generate
   pnpm exec prisma migrate deploy
   pnpm run seed          # si le script existe - crée le compte owner
   ```

5. **Démarrer l'API en mode watch** :
   ```bash
   pnpm run start:dev
   ```
   Accessible sur `http://localhost:4803` (ou la valeur de `PORT` dans `.env`).

6. **Arrêter proprement** :
   ```bash
   docker compose down          # conserve les données (volume nommé)
   docker compose down -v       # supprime aussi les données - repartir de zéro
   ```

## Avantages

- Rechargement à chaud quasi instantané.
- Isolation totale : aucun risque, aucune exposition, peu importe ce que tu testes.
- Coexiste sans conflit avec les autres piles (`demo`, `prod`, `lan`) sur la même machine - réseau
  Docker et ports dédiés (`${PROJECT_NAME}-dev`).

## Inconvénients

- Pas de TLS, pas de comportement "prod-like" - certains bugs liés au HTTPS/CORS strict
  n'apparaissent qu'en `demo`/`prod`.
- Migrations et seed manuels (contrairement aux autres piles qui les appliquent automatiquement
  au premier démarrage via `deploy/entrypoint.sh`).

## Commandes rapides (`Makefile`)

```bash
make up-dev        # ./scripts/stack.sh up dev - démarre postgres-dev + redis-dev
make logs-dev       # logs
./scripts/stack.sh down dev
```

Voir `docs/README.md` §6 pour le contexte : ce fichier `docker-compose.yml` a dû être recréé, il
était référencé par l'outillage mais absent de ce dépôt.
