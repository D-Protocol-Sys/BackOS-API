# Combinaison : Démo + Production sur le même serveur

## Est-ce possible ?

Oui, et c'est même le cas d'usage pour lequel `scripts/stack.sh`/`Makefile` ont été conçus - les
deux piles sont déjà pensées pour cohabiter sur une seule machine sans collision.

## Ce que ça signifie concrètement

Deux instances **complètement indépendantes** (bases de données séparées, conteneurs séparés,
noms Docker distincts - `${PROJECT_NAME}-demo-*` vs `${PROJECT_NAME}-prod-*`), qui partagent
uniquement la couche `edge` (un seul Traefik, un seul `docker-socket-proxy`) et sont distinguées
par **nom de domaine**, pas par port :

```
                    Internet (ports 80/443)
                              │
                         ┌────▼────┐
                         │ Traefik  │  (un seul, partagé)
                         └────┬────┘
                 ┌────────────┴────────────┐
        demo.tondomaine.com          tondomaine.com
                 │                            │
          ┌──────▼──────┐            ┌────────▼────────┐
          │ Stack DÉMO   │            │  Stack PROD      │
          │ DB dédiée    │            │  DB dédiée       │
          │ compte demo  │            │  vrais comptes   │
          │ lecture seule│            │  écriture réelle │
          │ pas d'accès  │            │  accès Docker    │
          │ Docker       │            │  (génération)    │
          └──────────────┘            └──────────────────┘
```

## Fonctionnement exact

1. Traefik route selon le `Host` de la requête HTTP (règle de routage par domaine, pas par port -
   les deux stacks écoutent "derrière" le même 80/443).
2. Chaque backend ne voit jamais le trafic de l'autre : réseaux Docker internes distincts
   (`${PROJECT_NAME}-demo-internal` vs `${PROJECT_NAME}-prod-internal`), aucune règle Docker ne
   les relie entre eux.
3. Seule la stack `prod` a accès au `docker-socket-proxy` (`DOCKER_HOST` configuré) - la stack
   `demo` en a été délibérément privée (voir `docs/README.md` §4), donc même si l'une est
   compromise, l'isolation Docker native limite la casse, ET la démo n'a de toute façon aucun
   levier technique vers l'hôte.

## Étapes

```bash
cp .env.production.example .env.production   # domaine prod, secrets réels
cp .env.demo.example       .env.demo         # sous-domaine démo, secrets propres à la démo

# edge démarré automatiquement comme dépendance des deux commandes suivantes
make up-prod
make up-demo

# ou en une seule commande (edge + prod + demo + dev) :
make up

make ps          # vérifier l'état des 4 piles
```

Vérifie que les deux domaines (`tondomaine.com` et `demo.tondomaine.com`, ou équivalent) pointent
bien tous les deux vers l'IP publique du serveur avant de démarrer - Traefik/Let's Encrypt a
besoin des deux pour délivrer les deux certificats.

## Avantages

- Une seule machine, un seul Traefik à maintenir, un seul certificat TLS à renouveler par domaine
  (automatique).
- Isolation stricte entre données de démo et données réelles - aucun risque de mélange.
- Déjà entièrement outillé (`Makefile`/`stack.sh`) - pas de configuration manuelle supplémentaire
  au-delà des deux fichiers `.env.*`.

## Inconvénients

- Les deux piles partagent les ressources CPU/RAM/disque du même serveur - une démo qui reçoit un
  pic de trafic peut ralentir la prod à côté (pas de garde-fou de partage de charge entre les
  deux ; seules les limites CPU/mémoire par conteneur existent, pas de priorité relative).
- Panne du serveur = panne des deux instances en même temps (pas de redondance).
- Si tu veux un jour séparer les deux (ex. la démo devient trop demandeuse en ressources), c'est
  une vraie migration - prévoir de sortir la démo sur une machine séparée plutôt que de la faire
  cohabiter indéfiniment si son usage grandit.
