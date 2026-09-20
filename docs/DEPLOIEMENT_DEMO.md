# Déploiement : Démo publique

## Ce que c'est

Une instance exposée publiquement via Traefik (TLS automatique Let's Encrypt), avec un compte
`demo` **en lecture seule** créé automatiquement, base de données séparée de la production. Faite
pour montrer le projet à un tiers (client, investisseur, recruteur) sans jamais risquer de vraies
données.

## Ce que ça entraîne

- Traefik ne route que les conteneurs explicitement labellisés `traefik.enable=true`
  (`exposedbydefault=false`) - pas de routage accidentel. Dashboard Traefik désactivé.
- Le compte `demo` (`prisma/seed-demo.ts`) n'a **que** des permissions `*_READ` - il ne peut
  jamais créer, modifier, supprimer, ni déclencher de génération de backend.
- Base de données seedée avec des données réalistes à chaque démarrage
  (`RUN_DEMO_SEED=1`) - il y a toujours quelque chose de concret à montrer, sans jamais dépendre
  d'un usage antérieur.
- **Le conteneur de la démo n'a aucun accès au `docker-socket-proxy`** (retiré
  délibérément de `deploy/docker-compose.demo.yml`, voir `docs/README.md` §4) : même en cas de
  faille d'exécution de code dans ce conteneur, aucun chemin technique ne mène vers le reste de
  l'hôte.
- Requiert obligatoirement un nom de domaine pointant vers l'IP publique du serveur, et les ports
  80/443 réellement joignables depuis Internet (défi ACME HTTP-01 de Let's Encrypt).

## Étapes

1. **Prérequis** :
   - Un nom de domaine (ou sous-domaine) pointant vers l'IP publique du serveur - un sous-domaine
     gratuit type DuckDNS convient, voir `DEPLOIEMENT_WIREGUARD.md` §1 pour la marche à suivre
     (même mécanisme, suivre une IP publique qui change).
   - Ports 80 et 443 forwardés vers le serveur si celui-ci est derrière un routeur domestique.
   - Docker + Docker Compose installés.

2. **Configuration** :
   ```bash
   cp .env.demo.example .env.demo
   ```
   Remplis chaque `REPLACE_ME_...` : `PROJECT_NAME`, `DEMO_DOMAIN`, secrets, adresse email pour
   Let's Encrypt.

3. **Démarrer la pile partagée `edge`** (Traefik + docker-socket-proxy - un seul `edge` pour
   démo et prod si les deux coexistent) :
   ```bash
   docker compose -f deploy/docker-compose.edge.yml --env-file .env.demo up -d
   ```
   Ou via l'outillage unifié : `make up-demo` (démarre `edge` puis `demo` automatiquement, voir
   `scripts/stack.sh`).

4. **Démarrer la pile démo** :
   ```bash
   docker compose -f deploy/docker-compose.demo.yml --env-file .env.demo up -d --build
   ```

5. **Vérifier le certificat TLS** avant de partager le lien :
   ```bash
   docker compose -f deploy/docker-compose.edge.yml logs traefik --tail 50
   ```

6. **Récupérer les identifiants du compte démo** (dans `.env.demo`, réutilisables à volonté -
   c'est un compte public par design).

7. **Couper la démo quand elle n'est pas utilisée** (libère les ressources, réduit la surface
   d'attaque exposée) :
   ```bash
   docker compose -f deploy/docker-compose.demo.yml --env-file .env.demo down
   ```
   (Laisse `edge` tourner si tu comptes la redémarrer plus tard - Traefik est léger et son
   certificat reste valide.)

## Avantages

- Setup propre : rien à craindre même si quelqu'un abuse du compte démo (lecture seule) ou
  regarde des données réelles (base séparée).
- Conteneur démo sans accès Docker - même une faille applicative n'ouvre aucun chemin vers le
  reste du serveur.
- TLS automatique, pas de gestion manuelle de certificats.

## Inconvénients

- Requiert un vrai nom de domaine et des ports 80/443 réellement joignables - impossible derrière
  un CGNAT sans contourner (voir `DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md` pour ce cas précis).
- Lecture seule uniquement : ne permet pas de prouver en live des actions d'écriture (création,
  génération) - pour ça, utilise ton propre compte pro en pilotant l'écran toi-même pendant la
  démo, ou crée un compte jetable dédié (voir la discussion sur ce sujet dans l'historique du
  projet, ou demande la création d'un `seed-sandbox.ts` sur le même modèle que `seed-demo.ts`).

## Combinaisons possibles à partir de ce mode

- **+ Production, même serveur** (`DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md`) : faire cohabiter la
  démo et la vraie instance sur un seul serveur, derrière le même Traefik.
- **+ LAN + WireGuard, un seul PC** (`DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md`) : le cas où le
  serveur n'a pas d'autre rôle que d'héberger la démo *et* ton instance privée.
