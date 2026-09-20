# Combinaison : Production publique + WireGuard pour l'accès administrateur

## Est-ce possible ?

Oui. **Important à comprendre avant de commencer** : cette combinaison n'ajoute aucune
restriction au niveau de l'application NestJS elle-même (il n'existe pas aujourd'hui de mécanisme
intégré du type "cette route API n'est autorisée que depuis le VPN"). C'est un patron
**d'infrastructure**, pas une fonctionnalité du produit : l'app reste normalement publique pour
tes utilisateurs, et WireGuard sert uniquement à protéger les outils d'administration du
**serveur** qui n'ont eux-mêmes aucune raison d'être exposés publiquement (accès SSH, `psql`
direct sur la base, tableau de bord Traefik, `docker exec`/logs bruts, outils de monitoring).

## Ce que ça signifie concrètement

```
                            Internet
                               │
                 ┌──────────────┴──────────────┐
          Port 80/443                   Port 51820/UDP
        (tout le monde,              (toi uniquement, avec
         c'est le produit)            ta clé WireGuard)
                 │                               │
                 ▼                               ▼
         ┌──────────────┐              ┌──────────────────┐
         │   Traefik     │              │   WireGuard        │
         │  → Stack PROD │              │   serveur           │
         │  (normal, tel │              │                     │
         │  que documenté│              └─────────┬───────────┘
         │  dans          │                        │
         │  DEPLOIEMENT_  │              une fois dans le tunnel,
         │  PRODUCTION.md)│              accès direct au serveur :
         └───────────────┘              - SSH (port 22, jamais forwardé
                                           publiquement autrement)
                                         - psql direct sur Postgres, pour
                                           du debug sans passer par l'API
                                         - Tableau de bord Traefik, activé
                                           uniquement sur l'interface
                                           WireGuard
                                         - docker compose logs / exec
```

## Fonctionnement exact

1. La stack `prod` (`deploy/docker-compose.prod.yml`) tourne exactement comme décrit dans
   `DEPLOIEMENT_PRODUCTION.md` - rien n'y change.
2. WireGuard tourne en plus, en suivant `DEPLOIEMENT_WIREGUARD.md` pour la mise en place
   (DuckDNS si IP dynamique, génération des clés).
3. Le pare-feu du serveur n'ouvre **que** 80/443 (Traefik, public) et 51820/UDP (WireGuard) -
   **jamais** le port SSH (22) directement, **jamais** le port Postgres (5432) directement, même
   si `docker-compose.prod.yml` ne les expose déjà pas publiquement par lui-même (défense en
   profondeur : pare-feu du serveur + isolation Docker, pas l'un ou l'autre).
4. Une fois dans le tunnel (`10.8.0.x`), tu atteins le serveur comme si tu étais physiquement
   devant : SSH normal, `psql` en te connectant à `localhost:5432` depuis le serveur (ou en
   tunnelant le port toi-même par-dessus WireGuard), etc.

## Étapes

1. Déploie la stack `prod` en suivant `DEPLOIEMENT_PRODUCTION.md` intégralement - aucune étape
   n'y change.
2. Mets en place WireGuard sur le même serveur en suivant `DEPLOIEMENT_WIREGUARD.md`
   intégralement.
3. Vérifie le pare-feu du serveur (`ufw`, `iptables`, ou le pare-feu du fournisseur cloud) :
   ```bash
   # Exemple avec ufw
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw allow 51820/udp
   sudo ufw deny 22/tcp        # SSH fermé au public...
   # ... et autorisé uniquement depuis l'interface WireGuard :
   sudo ufw allow in on wg0 to any port 22
   sudo ufw enable
   ```
4. (Optionnel, si tu veux debugger Traefik) Active son tableau de bord uniquement sur
   l'interface WireGuard dans `deploy/docker-compose.edge.yml` (`--api.dashboard=true` +
   `ports: - "10.8.0.1:8080:8080"` au lieu d'une exposition publique).
5. Génère une clé WireGuard **par administrateur/appareil**, jamais une clé partagée entre
   plusieurs personnes - si quelqu'un quitte l'équipe, révoque juste sa clé sans toucher aux
   autres.

## Avantages

- L'app reste pleinement publique pour tes utilisateurs - aucun compromis sur l'expérience
  produit.
- Les outils qui donneraient un accès total au serveur en cas de fuite d'identifiants (SSH,
  base de données brute) ne sont jamais exposés à un scan/brute-force depuis Internet.
- Zéro dépendance à un service VPN tiers managé - cohérent avec le choix déjà fait de WireGuard
  plutôt que Tailscale (voir `DEPLOIEMENT_INTERNE_TAILSCALE.md`).

## Inconvénients

- Ne protège **que** l'infrastructure, pas l'application elle-même - une faille dans l'API reste
  exploitable publiquement comme sur n'importe quel déploiement de prod classique. Ne pas
  confondre "accès admin protégé" avec "surface d'attaque de l'app réduite".
- Une couche de plus à maintenir et surveiller (clés WireGuard à gérer, renouvellement, révocation
  en cas de départ d'un administrateur).
- Si le serveur qui héberge WireGuard tombe, l'accès admin distant tombe avec lui en même temps
  que la prod - pas de redondance sur ce point précis (mais SSH en direct depuis la console du
  fournisseur cloud reste généralement une voie de secours indépendante).
