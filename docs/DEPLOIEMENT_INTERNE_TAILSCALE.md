# Déploiement interne via Tailscale — guide complet

> ⚠️ **Ce guide n'est pas celui retenu.** Après discussion sur l'autonomie souhaitée
> (dépendre le moins possible d'un service tiers), le choix final s'est porté sur du
> **WireGuard pur, sans aucun service géré** — voir `docs/DEPLOIEMENT_WIREGUARD.md`, le guide
> actif. Ce document est conservé pour référence si vous reconsidérez un jour l'option
> Tailscale/Headscale (plus simple d'usage, au prix d'une dépendance externe).

Ce guide couvre le scénario : backend + frontend tournent sur **une seule machine** (votre PC
actuel aujourd'hui, un PC dédié plus tard), sans nom de domaine public, accessibles depuis
n'importe quel appareil connecté à votre réseau Tailscale.

---

## 0. Vue d'ensemble

```
                     ┌─────────────────────────────┐
                     │   Votre machine serveur      │
                     │   (PC actuel → PC dédié)     │
                     │                               │
   Tailscale  ───────┼──▶ frontend (port 3000)       │
   (n'importe où)    │    backend  (port 4803)       │
                     │    postgres, redis (internes) │
                     └─────────────────────────────┘
```

Chaque appareil qui doit accéder à l'outil (votre laptop, votre téléphone, un futur collègue)
installe simplement le client Tailscale et rejoint votre réseau (« tailnet ») — aucune
redirection de port, aucun certificat à gérer manuellement, aucune exposition publique.

---

## 1. Installer Tailscale

1. Créez un compte sur https://tailscale.com (gratuit pour un usage personnel/petite équipe).
2. Sur votre machine serveur : installez le client Tailscale (https://tailscale.com/download),
   connectez-vous. La machine apparaît dans votre tailnet avec un nom d'hôte automatique (ex.
   `backos-server`) — visible dans la console admin https://login.tailscale.com/admin/machines.
3. Sur chaque appareil client (laptop, téléphone) : même installation, même compte.
4. Test rapide : depuis un appareil client, `ping backos-server` (ou le nom affiché dans la
   console admin) doit répondre — si oui, le réseau privé fonctionne.

**Conseil** : dans la console admin Tailscale, épinglez un nom stable à votre serveur (Settings
→ Machine → Edit machine name) plutôt que de dépendre du nom d'hôte système, qui peut changer.

---

## 2. Activer le HTTPS Tailscale (nécessaire pour l'installation PWA)

Les navigateurs exigent un contexte sécurisé (HTTPS, ou `localhost`) pour autoriser un service
worker — donc pour proposer « Installer l'application ». Tailscale fournit ça nativement, sans
certificat à gérer vous-même :

1. Dans la console admin Tailscale : **DNS** → activez **MagicDNS** (probablement déjà actif) et
   **HTTPS Certificates**.
2. Sur votre machine serveur, une fois le backend ET le frontend démarrés (voir §3-4) :
   ```
   tailscale serve --bg --https=443 http://localhost:3000
   ```
   Ceci expose votre frontend en HTTPS à l'adresse
   `https://backos-server.<nom-de-votre-tailnet>.ts.net` (le nom exact du tailnet est visible
   dans la console admin).
3. Pour le backend, montez-le sous le même nom d'hôte via un chemin dédié plutôt qu'un port
   séparé (plus propre, évite de gérer deux certificats) :
   ```
   tailscale serve --bg --set-path=/api https://localhost:443/api http://localhost:4803/api
   ```
   Les flags exacts évoluent selon la version de Tailscale — vérifiez `tailscale serve --help`
   ou https://tailscale.com/kb/1242/tailscale-serve si la commande ci-dessus ne correspond pas
   exactement à votre version installée.
4. Une fois ceci fait, mettez à jour `NEXT_PUBLIC_API_URL` dans le `.env.local` du **frontend**
   pour pointer vers cette adresse HTTPS unifiée, puis reconstruisez :
   ```
   NEXT_PUBLIC_API_URL=https://backos-server.<tailnet>.ts.net/api
   ```
   (`docker compose -f docker-compose.local.yml --env-file .env.local up -d --build` pour
   reconstruire avec la nouvelle valeur — rappel : elle est figée dans le bundle au build, pas
   lue au runtime.)

Sans cette étape, l'application reste parfaitement utilisable en HTTP simple via Tailscale —
vous perdez juste la proposition « Installer l'application » du navigateur.

---

## 3. Démarrer le backend

Dans le dépôt backend (`back-os-api`) :

```
cp .env.local.example .env.local
```

Remplissez chaque `REPLACE_ME` (voir les commentaires dans le fichier pour les commandes de
génération des secrets), puis :

```
./scripts/stack.sh up local
```

Vérifiez : `./scripts/stack.sh logs local` — au premier démarrage, le lien d'activation et le
code du compte propriétaire initial s'affichent dans les logs.

---

## 4. Démarrer le frontend

Dans le dépôt frontend :

```
cp .env.local.example .env.local
```

Remplissez `NEXT_PUBLIC_API_URL` avec l'adresse Tailscale du backend (§2, ou temporairement
`http://backos-server:4803/api` en HTTP simple si vous sautez l'étape HTTPS pour l'instant), puis :

```
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
```

---

## 5. Installer l'application (PWA)

Depuis n'importe quel appareil connecté à votre tailnet, ouvrez
`https://backos-server.<tailnet>.ts.net` (ou l'adresse HTTP simple) dans Chrome ou Edge. Une
icône d'installation apparaît dans la barre d'adresse (ou menu ⋮ → « Installer l'application »).
Une fois installée : icône sur le bureau/écran d'accueil, fenêtre dédiée sans onglets de
navigateur — exactement le comportement recherché.

---

## 6. Arrêter / relancer (libérer les ressources de votre PC)

Aucune perte de données tant que vous n'ajoutez pas `-v` :

```
# Arrêter (backend)
cd back-os-api && ./scripts/stack.sh down local

# Arrêter (frontend)
cd src-front && docker compose -f docker-compose.local.yml --env-file .env.local down
```

Pour relancer plus tard, exactement les mêmes commandes qu'aux §3-4 (`up local` / `up -d`) —
vos données Postgres restent intactes dans leurs volumes nommés.

---

## 7. Migration vers le futur PC dédié

Rien de spécifique à refaire : copiez (ou `git clone`) les deux dépôts sur la nouvelle machine,
copiez vos fichiers `.env.local` (ils contiennent vos secrets générés — ne les régénérez pas,
sous peine de perdre l'accès aux données déjà chiffrées), réinstallez le client Tailscale sur
cette machine avec le même compte, relancez les §3-4. Le nom d'hôte Tailscale changera
probablement (nouvelle machine) — mettez à jour `NEXT_PUBLIC_API_URL` en conséquence et
reconstruisez le frontend.

---

## Limites de ce guide

- Les commandes `tailscale serve` exactes (§2) peuvent varier selon votre version du client —
  vérifiez `tailscale serve --help` si elles échouent telles quelles.
- Ce guide n'a pas pu être testé de bout en bout dans mon environnement (pas d'accès à un vrai
  réseau Tailscale ni à Docker) — suivez-le étape par étape et signalez tout écart.
