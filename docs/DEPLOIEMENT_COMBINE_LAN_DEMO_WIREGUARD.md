# Déploiement combiné : LAN + Démo publique + WireGuard sur un seul PC serveur

Topologie à deux machines : **PC1** héberge tout le backend (utilisable aussi pour d'autres
usages, ex. développement Unity, avec possibilité d'éteindre/rallumer la stack à la demande),
**PC2** ne fait tourner que le frontend, comme une application de bureau classique. Ce guide
documente comment faire cohabiter, sur PC1 uniquement, la stack privée (mode LAN + tray Windows)
et une démo publique, avec un accès distant chiffré vers la partie privée — sans jamais exposer
cette dernière directement à Internet.

Si tu n'as qu'une seule machine disponible pour le serveur, c'est le déploiement de référence.

---

## Vue d'ensemble

```
                                   Internet
                                      │
                     ┌────────────────┴────────────────┐
                     │                                  │
              Port 80/443                        Port 51820/UDP
        (forwardés par le routeur)          (forwardé par le routeur)
                     │                                  │
                     ▼                                  ▼
              ┌─────────────┐                    ┌─────────────┐
              │   Traefik    │                    │  WireGuard   │
              │ (TLS auto)   │                    │   serveur    │
              └──────┬───────┘                    └──────┬───────┘
                     │                                    │
                     ▼                                    ▼
          ┌────────────────────┐              tunnel chiffré, comme si
          │   Stack DÉMO (3)    │              le client était sur le LAN
          │  Postgres/Redis/    │                          │
          │  orchestrateur      │                          ▼
          │  dédiés, compte     │              ┌────────────────────────┐
          │  démo lecture seule │              │   Stack LAN (2), pilotée │
          │  PAS d'accès Docker │              │   via le tray Windows (7)│
          └─────────────────────┘              │   port 4803, JAMAIS      │
                                                │   exposé au routeur      │
                                                └────────────────────────┘
                          ▲
                          │             PC1 (serveur)
══════════════════════════╪══════════════════════════════════════════════
                          │             PC2 (poste de travail)
                          │
              PC2 se connecte à PC1 via :
              - son IP locale directement si les deux sont sur le même LAN
              - le tunnel WireGuard si PC2 est ailleurs
              Le frontend (icône sur le bureau de PC2) fait ses requêtes
              vers le backend de PC1 - aucune logique métier sur PC2.
```

**Règle d'or, celle qui protège tout le reste** : le routeur de PC1 ne forwarde jamais que deux
ports — **80/443** (Traefik, pour la démo uniquement) et **51820/UDP** (WireGuard). Le port de la
stack LAN (**4803** par défaut) n'est **jamais** forwardé. C'est cette seule règle qui fait que la
partie privée reste privée même si PC1 sert aussi de frontal public pour la démo.

---

## 1. Prérequis sur PC1

- Docker Desktop installé et lancé.
- Ce dépôt cloné (ou le zip livré, décompressé).
- Un nom de domaine pointant vers l'IP publique de PC1 (pour la démo, TLS Let's Encrypt) — un
  sous-domaine gratuit type DuckDNS convient très bien, voir `docs/DEPLOIEMENT_WIREGUARD.md`
  §1 pour la marche à suivre (le même mécanisme sert aux deux usages : suivre une IP publique qui
  change).
- Vérifie que ton FAI ne te place pas derrière un CGNAT (IP publique partagée entre plusieurs
  foyers) - dans ce cas le port-forwarding pour la démo est tout simplement impossible sans
  contacter ton FAI. Test rapide : configure temporairement le forward du port 80 et vérifie
  depuis l'extérieur avec https://canyouseeme.org.

## 2. Stack LAN + tray Windows (ta partie privée)

C'est ta seule vraie instance de travail - celle sur laquelle tu te connectes avec ton compte
pro. Le tray Windows n'est qu'une interface graphique par-dessus le `docker compose` du mode LAN
(mêmes conteneurs durcis, même isolation) : les scripts `.bat` livrés dans `deploy/` appellent
directement `docker compose -f deploy/docker-compose.lan.yml`.

```powershell
cd deploy
copy ..\.env.lan.example ..\.env.lan
# Remplis les REPLACE_ME_... dans .env.lan (secrets, PROJECT_NAME, etc.)

# Premier démarrage
.\start-backend.bat
```

Une icône apparaît dans la barre système Windows : clic droit pour démarrer/arrêter/voir les
logs/le statut, sans jamais taper de commande. C'est le bouton que tu utilises pour libérer les
ressources de PC1 quand tu passes sur un autre usage (ex. une session Unity) - couper la stack
LAN ne touche en rien à la stack Démo, elles sont indépendantes.

**Aucun port de cette stack n'est forwardé sur le routeur.** Elle n'est jamais directement
joignable depuis Internet - uniquement depuis le réseau local, ou via WireGuard (§4).

## 3. Stack Démo publique (durcie)

Une instance complètement séparée - sa propre base de données, ses propres conteneurs, un compte
`demo` en lecture seule créé automatiquement. Le conteneur de la démo **n'a volontairement aucun
accès à Docker** : le `docker-socket-proxy` (qui permet à ta vraie instance de créer des
conteneurs pour générer des backends) a été retiré de sa configuration - le compte démo ne peut
de toute façon jamais déclencher de génération (permissions en lecture seule uniquement), donc
cet accès n'avait aucune utilité et n'aurait fait qu'agrandir la surface d'attaque si le
conteneur démo était un jour compromis par une vraie faille d'exécution de code.

```powershell
cd deploy
copy ..\.env.demo.example ..\.env.demo
# Remplis les REPLACE_ME_... (domaine public, secrets, PROJECT_NAME identique à .env.lan)

docker compose -f docker-compose.edge.yml  --env-file ..\.env.demo up -d
docker compose -f docker-compose.demo.yml  --env-file ..\.env.demo up -d --build
```

Vérifie que le certificat TLS a bien été délivré avant de partager le lien :
```powershell
docker compose -f docker-compose.edge.yml logs traefik --tail 50
```

Les identifiants du compte démo (à donner à la personne à qui tu montres le projet) sont dans
`.env.demo` - `RUN_DEMO_SEED=1` les recrée à chaque démarrage avec des données réalistes déjà
présentes, pour qu'il y ait quelque chose de concret à montrer dès la connexion.

Tu peux couper cette stack quand tu n'as pas de démo prévue :
```powershell
docker compose -f docker-compose.demo.yml --env-file ..\.env.demo down
```
(Laisse `docker-compose.edge.yml` tourner si tu comptes redémarrer la démo plus tard - c'est
Traefik, léger, et son certificat TLS reste valide.)

## 4. WireGuard - ton accès distant à la stack LAN

Suis `docs/DEPLOIEMENT_WIREGUARD.md` pour la mise en place complète (DuckDNS, génération des
clés, configuration du serveur et du client). Un seul point à retenir spécifiquement pour ce
déploiement combiné : **génère une paire de clés WireGuard uniquement pour toi** (et une par
appareil que tu utilises, jamais une clé partagée) - c'est le seul autre point d'entrée vers PC1
en dehors de la démo, autant qu'il reste strictement personnel.

Une fois le tunnel actif sur PC2 (ou ton téléphone, etc.), tu atteins la stack LAN de PC1 via son
IP privée WireGuard (ex. `10.8.0.1:4803`) exactement comme si tu étais physiquement sur le même
réseau.

## 5. Pare-feu du routeur - la seule étape qui protège tout le reste

Dans l'interface d'administration de ton routeur, configure le port-forwarding pour ne rediriger
**que** :

| Port externe | Protocole | Vers | Pourquoi |
|---|---|---|---|
| 80 | TCP | PC1 | Redirection HTTP→HTTPS (Traefik, démo) |
| 443 | TCP | PC1 | TLS (Traefik, démo) |
| 51820 | UDP | PC1 | WireGuard |

**Ne forwarde jamais le port 4803** (ou celui configuré dans `.env.lan`) - c'est le port de la
stack privée, elle ne doit être atteignable que depuis le LAN local ou via le tunnel WireGuard.

Désactive l'UPnP sur le routeur si l'option existe - certains logiciels s'en servent pour
s'auto-forwarder un port sans que tu le voies, ce qui pourrait exposer 4803 par accident sans
action explicite de ta part.

## 6. PC2 - le frontend

PC2 ne fait tourner que l'application frontend (icône sur le bureau, comme une appli native).
Configure son URL d'API vers PC1 :
- Adresse LAN locale de PC1 (ex. `http://192.168.1.x:4803`) quand PC2 est sur le même réseau.
- Adresse WireGuard de PC1 (ex. `http://10.8.0.1:4803`) quand PC2 est ailleurs, une fois le
  tunnel du §4 actif sur PC2.

Le mode (démo ou pro) dépend uniquement du compte utilisé pour se connecter depuis ce frontend -
identifiants du compte `demo` (§3) pour une navigation en lecture seule sans risque, identifiants
du compte pro pour l'instance réelle. Aucune configuration supplémentaire nécessaire côté PC2
pour ce changement de mode : c'est le rôle attaché au compte qui détermine les permissions,
côté backend.

---

## Modèle de sécurité en un coup d'œil

| Composant | Exposé à Internet ? | Si compromis, impact réel |
|---|---|---|
| Stack Démo (conteneurs) | Oui, via Traefik | Données de démo uniquement (déjà publiques par design) - **aucun accès Docker**, donc pas de chemin technique vers le reste de PC1 |
| Traefik / edge | Oui (80/443) | Reverse proxy seul, ne détient aucun secret de la stack LAN |
| WireGuard | Oui (51820/UDP), mais juste un point de rendez-vous chiffré | Rien sans la clé privée du client |
| Stack LAN (ta partie privée) | Non, jamais directement | Atteignable uniquement via LAN local ou tunnel WireGuard valide |
| PC2 (frontend) | Non | Aucune donnée persistante, aucun secret serveur |

---

## Checklist avant de montrer la démo à quelqu'un

- [ ] `docker compose -f docker-compose.edge.yml logs traefik` confirme un certificat TLS valide.
- [ ] Connexion test avec le compte `demo` réussie, données visibles.
- [ ] Vérifié sur le routeur : seuls 80, 443 et 51820/UDP sont forwardés vers PC1.
- [ ] UPnP désactivé sur le routeur.
- [ ] Stack LAN toujours accessible uniquement en local/WireGuard (pas de port 4803 ouvert).

Voir aussi `docs/README_DEPLOIEMENT.md` (vue d'ensemble générale des piles Docker) et
`docs/DEPLOIEMENT_WIREGUARD.md` (détail complet du tunnel).
