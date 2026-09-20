# Déploiement : Production

## Ce que c'est

L'instance officielle, exposée publiquement, avec de vrais utilisateurs et de vraies données.
C'est la pile la plus durcie du projet.

## Ce que ça entraîne

- **Traefik** : routage explicite uniquement (`exposedbydefault=false`), TLS automatique Let's
  Encrypt, redirection HTTP→HTTPS forcée, dashboard désactivé.
- **`docker-socket-proxy`** : le socket Docker réel n'est jamais monté dans un conteneur
  applicatif. L'orchestrateur y accède via `DOCKER_HOST=tcp://<projet>-edge-docker-proxy:2375`,
  avec des droits volontairement bornés - `CONTAINERS/IMAGES/BUILD/NETWORKS/POST=1` (nécessaire
  pour créer/démarrer des conteneurs pour les plateformes générées), mais `EXEC=0`, `SECRETS=0`,
  `SYSTEM=0`, `VOLUMES=0`.
- **`cap_drop: ALL` + `no-new-privileges:true`** sur l'orchestrateur : même en cas de faille
  d'exécution de code, l'attaquant hérite d'un process avec le minimum de capacités noyau
  possible.
- **Postgres et Redis** sur un réseau `internal` **sans aucun port exposé** à l'extérieur du
  réseau Docker - invisibles même depuis un scan du serveur. Redis protégé par mot de passe en
  plus (défense en profondeur).
- Migrations Prisma et seed du compte owner appliqués automatiquement au premier démarrage
  (`deploy/entrypoint.sh`) - identifiants d'activation (lien + code OTP) imprimés une seule fois
  dans les logs.

## Étapes

1. **Prérequis** :
   - Nom de domaine réel pointant vers l'IP publique du serveur.
   - Ports 80/443 forwardés et réellement joignables.
   - Serveur avec Docker + Docker Compose, mis à jour (c'est un serveur public, il doit recevoir
     les correctifs de sécurité de l'OS comme n'importe quel serveur exposé).

2. **Configuration** :
   ```bash
   cp .env.production.example .env.production
   ```
   Remplis chaque `REPLACE_ME_...` : `PROJECT_NAME`, `PROD_DOMAIN`, tous les secrets
   (`ENCRYPTION_KEY` via `openssl rand -hex 32`, `JWT_SECRET` via `openssl rand -base64 48`),
   SMTP réel (pas Mailhog), `OWNER_*`.

3. **Démarrer** (`edge` puis `prod`, dans cet ordre - `edge` est une dépendance) :
   ```bash
   docker compose -f deploy/docker-compose.edge.yml --env-file .env.production up -d --wait
   docker compose -f deploy/docker-compose.prod.yml  --env-file .env.production up -d --build --wait
   ```
   Ou via l'outillage unifié :
   ```bash
   make up-prod
   ```

4. **Récupérer les identifiants owner** au tout premier démarrage :
   ```bash
   make logs-prod
   ```

5. **Vérifier l'état** :
   ```bash
   make ps
   ```

6. **CI/CD** (`.github/workflows/cd.yml`) : chaque merge sur `main` construit une image signée
   (cosign, OIDC GitHub) + SBOM + attestation de provenance, la pousse vers GHCR, et déploie
   automatiquement en **démo**. Le déploiement en **prod ne se déclenche que sur un tag
   `vX.Y.Z`** (ou manuellement), via un `environment: production` GitHub avec reviewers
   obligatoires à configurer dans *Settings > Environments* - personne ne pousse en prod sans
   validation humaine explicite, même pipeline vert.

### Secrets GitHub à configurer avant d'activer la CD

`Settings > Secrets and variables > Actions` : `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
`DEPLOY_PATH`, `CI_ENCRYPTION_KEY`, `CI_JWT_SECRET`.

### Réglages de dépôt recommandés (hors code)

- Protection de la branche `main` : CI obligatoire avant merge, pas de push direct.
- `environment: production` avec au moins un reviewer requis.

## Avantages

- Niveau de durcissement au-dessus de la moyenne pour ce type de projet (vérifié dans le code,
  pas seulement dans les intentions - voir les trois audits successifs).
- Déploiement reproductible et traçable (image signée, SBOM, attestation de provenance).
- Aucune régression de sécurité ne peut fuiter en prod sans validation humaine explicite (tag +
  reviewer GitHub).

## Inconvénients / points de vigilance avant d'y mettre de vraies données

- La couverture de tests reste faible (voir `TESTS_COVERAGE_AUDIT.md`) - un vrai risque de
  régression silencieuse à mesure que le produit évolue, indépendamment de la solidité de
  l'infrastructure elle-même.
- Exécute `pnpm install && pnpm exec prisma generate && pnpm run build && pnpm test` sur la
  machine de déploiement (ou en CI) avant tout premier `up-prod` réel - aucune vérification à
  distance ne remplace un build/test complet effectué sur l'environnement cible.

## Combinaisons possibles à partir de ce mode

- **+ Démo, même serveur** (`DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md`) : cas standard,
  déjà pris en charge par `scripts/stack.sh`/`make up`.
- **+ WireGuard pour l'accès admin** (`DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md`) : garder la
  prod publique pour les utilisateurs, mais restreindre l'accès à certaines routes
  d'administration/debug à un tunnel VPN.
