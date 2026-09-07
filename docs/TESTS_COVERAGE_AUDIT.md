# Audit de couverture de tests

## État constaté (avant ce livrable)

| Module | Fichiers logique | Tests existants |
|---|---|---|
| `common/` | 29 | 1 (`role-hierarchy.service.spec.ts`) |
| `generator/` | 29 | 1 (`docker-runtime-manager.service.spec.ts`) |
| `auth/` | 4 | 0 |
| `permissions/` | 4 | 0 |
| `roles/` | 3 | 0 |
| `users/` | 3 | 0 |
| `platforms/` | 3 | 0 |
| `entities/` | 3 | 0 |
| `fields/` | 3 | 0 |
| `relations/` | 3 | 0 |
| `planning/` | 4 | 0 |
| `clients/` | 3 | 0 |
| `projects/` | 3 | 0 |
| `messages/` | 3 | 0 |
| `files/` | 5 | 0 |
| `backup/` | 3 | 0 |
| `cleanup/` | 2 | 0 |
| `audit/` | 3 | 0 |
| `gateway/` | 4 | 0 |
| `email/` | 4 | 0 |
| `prisma/` | 2 | 0 |
| E2E (parcours complets) | — | 1 (`platform-lifecycle.e2e-spec.ts`, un seul happy-path) |

**Constat honnête** : sur ~183 fichiers source, 2 avaient un test unitaire et 1 seul parcours e2e
existait avant ce livrable. C'est la définition d'un projet non couvert. Écrire l'intégralité des
tests manquants (des dizaines de services, guards, controllers, DTO/validators) dépasse ce qu'il
est raisonnable de produire d'un coup sans risquer des tests qui "passent" sans rien vérifier
d'utile - donc plutôt que de gonfler artificiellement un nombre de fichiers, ce livrable :

1. Ajoute 2 tests unitaires réels et significatifs sur les 2 zones les plus critiques niveau
   sécurité qui n'étaient pas couvertes (`PermissionsGuard`, `CryptoService`) - voir
   `src/common/guards/permissions.guard.spec.ts` et `src/common/services/crypto.service.spec.ts`.
2. Met en place l'infrastructure pour que la couverture progresse en continu et de façon
   mesurable (seuils Jest + rapport de couverture en CI, voir `.github/workflows/ci.yml`).
3. Donne un plan priorisé ci-dessous, module par module, pour combler le reste.

## Plan priorisé (à dérouler dans cet ordre)

**Priorité 1 - sécurité / auth (rien de tout ça n'est testé aujourd'hui)**
- `auth/auth.service.ts` : login, verrouillage après N échecs (`LOGIN_LOCKOUT_*`), refresh
  token, activation d'invitation, recovery codes.
- `auth/strategies/jwt.strategy.ts` : validation du payload JWT.
- `common/services/mfa.service.ts`, `common/utils/totp.service.ts` : génération/validation TOTP.
- `common/utils/recovery-code.service.ts`.
- `common/guards/jwt-auth.guard.ts`, `common/decorators/public.decorator.ts` (interaction avec
  le guard).
- `permissions/permissions-sync.service.ts` : c'est lui qui garantit que les permissions en base
  restent alignées avec `permissions.constant.ts` - une désynchronisation ici casse
  silencieusement toute autorisation.

**Priorité 2 - le générateur (le cœur métier du produit, 29 fichiers, 1 seul test)**
- `generator/provisioning.service.ts` : création de rôle/DB Postgres par plateforme - logique
  d'idempotence et de verrouillage (`lockKey`) critique à valider sans dépendre d'une vraie DB
  (mock Prisma + mock du client SQL).
- `generator/schema-builder.service.ts`, `generator/crud-generator.service.ts` : génération de
  code - les tests ici sont surtout des tests de "snapshot"/contrat (le code généré compile-t-il
  toujours, les noms de champs sont-ils bien échappés).
- `generator/port-allocator.service.ts` : allocation de ports sans collision - facile à tester
  unitairement (bornes de plage, ports déjà pris).
- `generator/generation.processor.ts` : machine à états DRAFT -> GENERATING -> ACTIVE/DRAFT.
- `common/utils/db-identifier.util.ts`, `sql-identifier.util.ts` : petites fonctions pures,
  rapides à couvrir à 100 %, avec un vrai risque (injection SQL si un identifiant mal échappé
  passe).

**Priorité 3 - CRUD "standards" (permissions/validations spécifiques à chaque ressource)**
- `platforms/`, `entities/`, `fields/`, `relations/`, `roles/`, `users/` : chaque `*.service.ts`
  mérite au moins des tests sur les règles métier propres (ex. `roles.service.ts` : peut-on
  supprimer un rôle `isSystem` ? `entities.service.ts` : unicité du nom dans une plateforme ?).

**Priorité 4 - le reste**
- `clients/`, `projects/`, `messages/`, `planning/`, `files/`, `backup/`, `cleanup/`, `audit/`,
  `email/`, `gateway/` : couverture standard service-par-service.

**E2E** : le seul scénario actuel est le "chemin heureux" complet. À ajouter en priorité :
un scénario d'échec de génération (revert en DRAFT), un scénario 403 (permissions
insuffisantes), un scénario de double-authentification/MFA complet, un scénario de
rotation de refresh token.

## Le dossier `test/` a-t-il besoin d'un compte dédié ?

Oui, et le repo en a déjà l'un des deux morceaux : `prisma/seed-demo.ts` (rôle `demo`, lecture
seule) existe déjà mais n'était utilisé nulle part dans l'infra fournie. Deux besoins distincts,
deux réponses différentes :

- **Tests e2e automatisés** (`pnpm test:e2e`) : n'ont PAS besoin du compte démo - ils utilisent
  déjà le compte owner généré à la volée par `prisma/seed.ts` et capturé par
  `test/global-setup-e2e.ts` (token + code OTP écrits dans `.e2e-owner-invitation.json`,
  supprimé au teardown). C'est la bonne approche : rien à changer ici.
- **Démonstrations humaines du projet** (le point 2 de la demande) : c'est là que le compte
  `demo` (lecture seule, secret TOTP publiable) a du sens - voir `deploy/docker-compose.demo.yml`
  et `RUN_DEMO_SEED=1`. Choix retenu : réutiliser tel quel `prisma/seed-demo.ts` plutôt que d'en
  écrire un autre, il correspond exactement au besoin et est déjà conçu pour être sûr (permissions
  strictement en lecture, pas de nouveau chemin d'authentification).

## Seuils de couverture (ajout recommandé dans `package.json`)

```json
"jest": {
  "coverageThreshold": {
    "global": { "branches": 40, "functions": 45, "lines": 50, "statements": 50 }
  }
}
```

Volontairement bas au démarrage (pour ne pas bloquer la CI immédiatement) - à faire monter
progressivement (ex. +5 points tous les mois) au fur et à mesure que le plan ci-dessus est
déroulé. `pnpm run test:cov` échoue déjà si la couverture réelle descend sous ces seuils.
