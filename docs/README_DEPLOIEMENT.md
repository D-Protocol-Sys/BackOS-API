# Mise en production : CI/CD, Docker, tests

## 1. Vue d'ensemble

Quatre piles Docker Compose distinctes, données jamais mélangées entre elles :

| Pile | Fichier | Rôle | Exposition | Compte auto-créé |
|---|---|---|---|---|
| **edge** | `deploy/docker-compose.edge.yml` | Traefik + proxy Docker, partagé | 80/443 publics | — |
| **dev** | `docker-compose.yml` (racine) | Ton poste de travail, hot-reload | `127.0.0.1` uniquement | owner (`.env`) |
| **demo** | `deploy/docker-compose.demo.yml` | Démonstrations à des tiers | `https://${DEMO_DOMAIN}` via edge | owner + **demo (lecture seule)** |
| **prod** | `deploy/docker-compose.prod.yml` | Usage officiel réel | `https://${PROD_DOMAIN}` via edge | owner |

**Pourquoi "test" et "demo" sont deux choses différentes** : le repo utilisait déjà
`deploy/docker-compose.test.yml` pour l'infra **éphémère** des tests e2e automatisés
(`pnpm test:e2e` la démarre et la détruit à chaque run, voir `test/global-setup-e2e.ts`). Ce
n'est PAS l'environnement que tu veux garder allumé en permanence pour montrer le projet - j'ai
donc gardé `docker-compose.test.yml` intact dans son rôle (CI/tests) et créé
`docker-compose.demo.yml` séparément pour la présentation. C'est ce dernier qui tourne en
même temps que `prod`.

Les **trois piles persistantes (dev + demo + prod) tournent en même temps** sur la même machine
sans collision : dev est lié à `127.0.0.1` uniquement (jamais public), demo et prod partagent le
même Traefik mais sont distingués par nom de domaine, pas par port.

## 2. Renommer le projet

Une seule variable à changer, `PROJECT_NAME`, présente en haut de chaque `.env.*.example`. Elle
pilote : noms de conteneurs, réseaux Docker, volumes, labels Traefik, préfixe de verrou Redis
(`SERVER_NAME`, dérivé de `PROJECT_NAME`), et l'émetteur affiché dans l'app TOTP. Aucun fichier
Docker de ce livrable ne contient le mot "backos" en dur.

## 3. Premier démarrage

```bash
cp .env.development.example .env
cp .env.demo.example        .env.demo
cp .env.production.example  .env.production
cp .env.test.example        .env.test
# Remplir les REPLACE_ME / change-me (secrets, domaines, SMTP...) dans chaque fichier.

chmod +x scripts/stack.sh deploy/entrypoint.sh

make up          # démarre edge + prod + demo + dev, en une seule commande
make ps           # état des quatre piles
```

Au premier démarrage de chaque pile, `deploy/entrypoint.sh` applique les migrations Prisma et
lance `prisma db seed` automatiquement - **le compte owner est créé sans aucune étape
manuelle**, pour dev, demo et prod indépendamment (chacun sa propre base). Pour `demo`
uniquement, un second compte public en lecture seule est créé (`RUN_DEMO_SEED=1`) - voir
`.env.demo` pour les identifiants à publier sur une page de démo.

Les identifiants d'activation du compte owner (lien + code OTP) sont imprimés une seule fois
dans les logs du conteneur au tout premier démarrage (`prisma/seed.ts`) - `make logs-prod` /
`make logs-demo` / `make logs-dev` juste après le premier `up` pour les récupérer.

## 4. CI/CD (`.github/workflows/`)

- **`ci.yml`** (à chaque PR et push sur `main`) : lint, build/typecheck, tests unitaires avec
  rapport de couverture, tests e2e réels (Docker), `pnpm audit`, revue de dépendances sur PR,
  scan de secrets (gitleaks), scan de l'image Docker (Trivy) avec remontée dans l'onglet
  Security de GitHub.
- **`codeql.yml`** : analyse statique de sécurité (SAST), à chaque push + hebdomadaire.
- **`cd.yml`** : à chaque merge sur `main` -> build image signée (cosign, sans clé, via OIDC
  GitHub) + SBOM + attestation de provenance -> push vers GHCR -> **déploiement automatique en
  demo**. Le déploiement en **prod ne se déclenche que sur un tag `vX.Y.Z`** (ou manuellement),
  et passe par un `environment: production` GitHub avec reviewers obligatoires à configurer
  dans *Settings > Environments* - personne ne pousse en prod sans validation humaine explicite,
  même si le pipeline est vert.
- **`dependabot.yml`** : mises à jour hebdomadaires npm / Docker / GitHub Actions.

### Secrets GitHub à configurer (`Settings > Secrets and variables > Actions`)
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH`, `CI_ENCRYPTION_KEY`,
`CI_JWT_SECRET`. `GITHUB_TOKEN` est fourni automatiquement par GitHub.

### Recommandé côté réglages du repo (pas dans le code)
- Protection de la branche `main` : CI obligatoire avant merge, pas de push direct.
- Environment `production` avec au moins un reviewer requis.

## 5. Tests

Voir `docs/TESTS_COVERAGE_AUDIT.md` pour l'état détaillé module par module et le plan priorisé.
En résumé : la couverture réelle avant ce livrable était quasi nulle (2 tests unitaires + 1
scénario e2e sur ~183 fichiers) ; ce livrable ajoute 2 tests unitaires ciblés sur les zones les
plus sensibles (autorisation, chiffrement), met en place des seuils de couverture qui échouent
la CI s'ils régressent, et documente un plan pour combler le reste dans l'ordre de risque.

## 6. Ce qui n'a volontairement pas été touché

- Le code métier (`src/`) n'a pas été modifié, à l'exception des 2 nouveaux fichiers de test -
  la demande portait sur l'infra, pas sur une réécriture du produit.
- `docker-compose.test.yml` garde son comportement d'origine (éphémère, piloté par Jest) pour ne
  pas casser `test/global-setup-e2e.ts` / `test/global-teardown-e2e.ts` déjà écrits et corrects.
