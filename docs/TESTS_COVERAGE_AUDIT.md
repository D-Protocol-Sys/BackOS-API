# Couverture de tests - état réel et plan d'action

## En une phrase

Ce projet a un très bon niveau de sécurité et d'infrastructure (voir les audits de sécurité),
mais un niveau de tests encore faible - c'est l'écart le plus net entre "ce backend a l'air
solide" et "ce backend est prouvé solide". Ce document dit exactement où on en est aujourd'hui,
module par module, et dans quel ordre combler le manque.

## État réel, vérifié en lançant `pnpm test` (pas une estimation)

| Module | Fichiers logique | Tests unitaires | Statut |
|---|---|---|---|
| `common/` | 30 | 4 | `role-hierarchy.service`, `permissions.guard`, `crypto.service`, `route-permission-audit` (garde-fou automatique, voir §3) |
| `generator/` | 31 | 1 | `docker-runtime-manager.service` - le cœur du produit, encore très peu couvert |
| `auth/` | 10 | 1 | `auth.service` couvert ; stratégies JWT, MFA, recovery codes non couverts |
| `users/` | 10 | 1 | `users.service` couvert |
| `backup/` | 3 | 1 | `backup.service` couvert |
| `config/` | 13 | 0 | |
| `planning/` | 24 | 0 | Le plus gros module non couvert - programmes récurrents, planning perso/plateforme |
| `permissions/` | 4 | 0 | |
| `roles/` | 6 | 0 | |
| `platforms/` | 8 | 0 | Cycle de vie complet (création, archivage, purge automatique à 30 jours) non testé |
| `entities/` | 5 | 0 | |
| `fields/` | 5 | 0 | |
| `relations/` | 4 | 0 | |
| `clients/` | 7 | 0 | |
| `projects/` | 5 | 0 | |
| `messages/` | 6 | 0 | |
| `files/` | 6 | 0 | Contient la validation de signature de fichier upload (magic bytes) - sensible, non testée |
| `cleanup/` | 2 | 0 | Contient la purge automatique des plateformes archivées - sensible, non testée |
| `audit/` | 4 | 0 | |
| `gateway/` | 4 | 0 | Route tout le trafic public `/generated/<slug>/...` - sensible, non testé |
| `email/` | 4 | 0 | |
| `prisma/` | 2 | 0 | |
| **Total** | **197** | **8** | **~4 % des fichiers ont un test dédié** |
| E2E (parcours complets) | — | 1 | `platform-lifecycle.e2e-spec.ts`, un seul chemin heureux |

**Constat honnête, sans enjoliver** : 4 % de fichiers avec un test dédié, c'est la définition
d'un projet non couvert. Écrire l'intégralité des tests manquants (des dizaines de services,
guards, controllers, DTO/validateurs) en un seul passage produirait des tests qui "passent" sans
vérifier grand-chose d'utile - donc plutôt que de gonfler artificiellement un chiffre, ce document
donne un plan concret, dans l'ordre où le dérouler.

## 1. Ce qui a le plus besoin d'un test, dans l'ordre de risque réel

### Priorité 1 - sécurité / auth (encore incomplet malgré `auth.service.spec.ts` existant)
- `auth/strategies/jwt.strategy.ts` : validation du payload JWT.
- `common/services/mfa.service.ts`, `common/utils/totp.service.ts` : génération/validation TOTP.
- `common/utils/recovery-code.service.ts`.
- `common/guards/jwt-auth.guard.ts` + interaction avec `@Public()`.
- `permissions/permissions-sync.service.ts` : garantit que les permissions en base restent
  alignées avec `permissions.constant.ts` - une désynchronisation ici casse silencieusement toute
  autorisation, sans qu'aucune erreur explicite n'apparaisse ailleurs.

### Priorité 2 - le générateur (29+ fichiers, le cœur métier du produit, 1 seul test)
- `generator/provisioning.service.ts` : création de rôle/DB Postgres par plateforme - logique
  d'idempotence et de verrouillage (`lockKey`) critique à valider sans dépendre d'une vraie DB
  (mock Prisma + mock du client SQL).
- `generator/crud-generator.service.ts` : c'est lui qui génère le vrai code exécuté par chaque
  backend produit - un bug ici se propage silencieusement dans toutes les plateformes générées.
  Tests de contrat (le code généré compile-t-il, les noms de champs sont-ils bien échappés).
- `generator/api-manifest.service.ts` : documente ce que le générateur produit réellement -
  quatre écarts entre ce fichier et le comportement réel de `crud-generator.service.ts` viennent
  d'être corrigés à la main (URL publique, champs de relation requis/optionnels, réponse du
  DELETE). Un test de contrat qui compare systématiquement les deux fichiers empêcherait ce
  genre d'écart de revenir silencieusement à la prochaine modification de l'un des deux.
- `generator/port-allocator.service.ts` : allocation de ports sans collision - facile à couvrir
  unitairement (bornes de plage, ports déjà pris).
- `generator/generation.processor.ts` : machine à états DRAFT → GENERATING → ACTIVE/DRAFT.
- `common/utils/db-identifier.util.ts`, `sql-identifier.util.ts` : petites fonctions pures,
  rapides à couvrir à 100 %, avec un vrai risque (injection SQL si un identifiant mal échappé
  passe).

### Priorité 3 - `platforms/` (cycle de vie complet, 8 fichiers, 0 test)
Module particulièrement important à couvrir maintenant : `PlatformsService.archive()`/
`restore()`/`purge()`/`purgeExpiredArchives()` viennent d'être ajoutés (archivage → suppression
définitive automatique après 30 jours consécutifs). C'est une logique destructive et irréversible
une fois la fenêtre de rétention passée - exactement le genre de code qui mérite un test avant
qu'un bug n'y détruise silencieusement des plateformes qui n'auraient pas dû l'être. À couvrir en
particulier :
- Le compte à rebours repart bien de zéro si on restaure puis ré-archive avant l'échéance.
- `purge()` refuse bien une plateforme qui n'est pas encore archivée.
- `purgeExpiredArchives()` continue bien sur les autres plateformes si une seule échoue (le
  `try/catch` par plateforme, pas un seul `try/catch` global).

### Priorité 4 - CRUD "standards" (permissions/validations propres à chaque ressource)
`entities/`, `fields/`, `relations/`, `roles/`, `users/` (partiellement fait) : chaque
`*.service.ts` mérite au moins un test sur ses règles métier propres (ex. `roles.service.ts` :
peut-on supprimer un rôle `isSystem` ? `entities.service.ts` : unicité du nom dans une
plateforme ?).

### Priorité 5 - le reste
`clients/`, `projects/`, `messages/`, `planning/` (le plus gros module non couvert, 24 fichiers),
`files/`, `backup/` (partiellement fait), `cleanup/`, `audit/`, `email/`, `gateway/` - couverture
standard, service par service.

### E2E
Le seul scénario actuel est le chemin heureux complet. À ajouter en priorité : un scénario
d'échec de génération (retour en DRAFT), un scénario 403 (permissions insuffisantes), un
scénario MFA complet, un scénario de rotation de refresh token, et un scénario couvrant le cycle
archive → restore → purge de `platforms/`.

## 2. Comptes de test - comment ça marche déjà (rien à changer ici)

Deux besoins distincts, déjà bien séparés dans le repo :

- **Tests e2e automatisés** (`pnpm test:e2e`) : utilisent le compte owner généré à la volée par
  `prisma/seed.ts` et capturé par `test/global-setup-e2e.ts` (token + code OTP écrits dans
  `.e2e-owner-invitation.json`, supprimé au teardown). Rien à changer.
- **Démonstrations humaines** : le compte `demo` (lecture seule, `prisma/seed-demo.ts`) sert à
  ça - voir `docs/DEPLOIEMENT_DEMO.md`. Ne pas réutiliser ce compte pour des tests e2e
  automatisés : il n'a pas les droits d'écriture nécessaires par design.

## 3. Le garde-fou automatique à connaître : `route-permission-audit.spec.ts`

Ce test échoue la CI si une route est ajoutée sans déclarer explicitement sa permission
(`@RequirePermissions`, `@Public()`, ou une entrée justifiée dans `MANUALLY_CHECKED_ROUTES` pour
les routes dont l'autorisation est vérifiée à l'intérieur du service plutôt que par décorateur).
**Lance ce test après tout ajout de route** - c'est le meilleur filet de sécurité automatique de
ce projet, et il vient de rattraper un vrai trou : `planning/platform-planning-program.controller.ts`
et `planning/personal-planning-program.controller.ts` (24 routes à eux deux) n'avaient aucune
entrée, alors que leurs permissions réelles (`PlanningProgramService.assertCanViewProgram()` /
`assertCanEditProgram()` / `assertCanViewPlanning()` / `assertCanEditPlanning()`) existaient bel
et bien dans le code - elles n'étaient simplement pas documentées pour ce test. Corrigé ; les 23
tests de ce fichier passent maintenant. Si ce test échoue à nouveau un jour, c'est le signal
qu'une route vient d'être ajoutée sans que personne n'ait vérifié/documenté son autorisation -
à traiter avant de merger, jamais en le contournant.

## 4. Seuils de couverture (déjà en place, `package.json`)

```json
"jest": {
  "coverageThreshold": {
    "global": { "branches": 40, "functions": 45, "lines": 50, "statements": 50 }
  }
}
```

Volontairement bas au démarrage (pour ne pas bloquer la CI immédiatement) - à faire monter
progressivement (ex. +5 points tous les mois) au fur et à mesure que le plan ci-dessus est
déroulé. `pnpm run test:cov` échoue déjà si la couverture réelle descend sous ces seuils - donc
au minimum, la couverture ne peut plus régresser silencieusement à partir de maintenant, même si
elle ne progresse pas encore vite.

## 5. Ce qu'il faut faire, concrètement, à partir d'aujourd'hui

1. Avant tout déploiement en production réelle (voir `docs/DEPLOIEMENT_PRODUCTION.md`), lancer
   `pnpm install && pnpm exec prisma generate && pnpm run build && pnpm test` sur la machine
   cible - aucune vérification à distance ne remplace un build/test réel sur l'environnement de
   déploiement.
2. Dérouler les priorités 1 à 3 ci-dessus avant d'ouvrir le produit à de vrais utilisateurs en
   écriture (au-delà de toi-même) - ce sont les zones où un bug non détecté aurait le plus
   d'impact (sécurité, génération, suppression irréversible de données).
3. Relancer `pnpm exec jest src/common/route-permission-audit.spec.ts` après chaque nouvelle
   route ajoutée, systématiquement.
4. Remonter les seuils de couverture de `package.json` (§4) par palier, au fur et à mesure que le
   plan avance - ne pas les laisser statiques indéfiniment, ils ne servent que s'ils progressent.
