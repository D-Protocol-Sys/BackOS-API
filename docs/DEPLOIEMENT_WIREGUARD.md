# Accès distant à BackOS via WireGuard pur — guide de mise en place

Option C retenue : zéro service tiers, tunnel chiffré configuré à la main, DNS dynamique
gratuit pour suivre les changements d'IP. Ce guide part du principe que WireGuard tourne sur
votre PC Windows actuel (le même qui héberge déjà la stack `local`) — voir la note en fin de
document si vous migrez vers un PC dédié sous Linux plus tard.

---

## Vue d'ensemble du réseau

```
Serveur (10.8.0.1)  ── tunnel WireGuard chiffré ──  Client (10.8.0.2, .3, ...)
  BackOS backend  :4803                                où que vous soyez
  BackOS frontend :3000
```

Un seul port est exposé publiquement sur votre box : le port WireGuard lui-même (UDP 51820) —
un simple point de rendez-vous chiffré, pas l'application. Une fois le tunnel établi, votre
navigateur atteint le serveur via son IP privée `10.8.0.1`, exactement comme s'il était sur
votre réseau local.

---

## 1. Créer un compte DNS dynamique (DuckDNS)

Votre IP publique Orange est stable en pratique, mais rien ne garantit qu'elle ne changera
jamais. DuckDNS lui donne un nom fixe qui se met à jour automatiquement.

1. Allez sur https://www.duckdns.org, connectez-vous (via GitHub/Google, gratuit).
2. Créez un sous-domaine, par exemple `backos-jarvis` → vous obtenez
   `backos-jarvis.duckdns.org`.
3. Notez votre **token** personnel, affiché en haut de la page — vous en aurez besoin à
   l'étape 4.

### Maintenir l'IP à jour automatiquement (Windows)

Créez un fichier `duckdns-update.ps1` :

```powershell
$token = "VOTRE_TOKEN_ICI"
$domain = "backos-jarvis"
Invoke-WebRequest -Uri "https://www.duckdns.org/update?domains=$domain&token=$token&ip=" -UseBasicParsing
```

Puis planifiez son exécution toutes les 5 minutes via le **Planificateur de tâches Windows**
(`taskschd.msc`) → Créer une tâche de base → Déclencheur : répéter toutes les 5 minutes →
Action : lancer `powershell.exe -File C:\chemin\vers\duckdns-update.ps1`.

---

## 2. Rediriger le port WireGuard sur votre Livebox

Dans l'interface Livebox (`192.168.1.1`, voir le guide précédent pour le mot de passe) :

1. Cherchez **"Réseau domestique"** → **"Configuration NAT/PAT"** ou **"Redirection de ports"**.
2. Ajoutez une règle : protocole **UDP**, port externe **51820**, port interne **51820**, adresse
   IP interne = l'IP locale de votre PC (visible via `ipconfig` dans un terminal Windows,
   généralement `192.168.1.xx`).
3. **Conseil** : réservez une IP locale fixe pour ce PC dans la Livebox (section DHCP →
   réservation d'adresse), pour que cette redirection reste valide même après un redémarrage du
   PC.

---

## 3. Installer WireGuard et générer les clés du serveur

1. Téléchargez et installez le client officiel : https://www.wireguard.com/install/
   (version Windows).
2. Ouvrez l'application → **"Ajouter un tunnel"** → **"Ajouter un tunnel vide"**. Elle génère
   automatiquement une paire de clés et ouvre un éditeur de configuration.
3. Notez la **clé publique** affichée en haut de la fenêtre — vous en aurez besoin pour chaque
   config client.
4. Remplacez le contenu de l'éditeur par (en gardant la `PrivateKey` déjà générée par l'app) :

```ini
[Interface]
PrivateKey = <déjà rempli automatiquement par l'app>
Address = 10.8.0.1/24
ListenPort = 51820

# Un bloc [Peer] par appareil client - ajoutez-en un par la suite pour chaque nouvel appareil.
[Peer]
# Nom : Laptop
PublicKey = <à remplir après l'étape 4 pour ce client>
AllowedIPs = 10.8.0.2/32

[Peer]
# Nom : Téléphone
PublicKey = <à remplir après l'étape 4 pour ce client>
AllowedIPs = 10.8.0.3/32
```

5. Enregistrez, activez le tunnel (bouton bascule dans l'app). Windows demandera d'autoriser le
   pare-feu — acceptez.

---

## 4. Générer la config de chaque appareil client

Sur **chaque appareil** qui doit se connecter (laptop, téléphone) :

1. Installez le client WireGuard officiel (Windows/Mac : https://www.wireguard.com/install/ ;
   iOS/Android : l'app "WireGuard" sur l'App Store / Play Store).
2. Créez un nouveau tunnel vide de la même façon — l'app génère sa propre paire de clés.
3. Remplacez le contenu par :

```ini
[Interface]
PrivateKey = <déjà rempli automatiquement par l'app de CET appareil>
Address = 10.8.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <la clé PUBLIQUE du SERVEUR, notée à l'étape 3.3>
Endpoint = backos-jarvis.duckdns.org:51820
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
```

   (Pour le 2ᵉ appareil, utilisez `Address = 10.8.0.3/32`, pour le 3ᵉ `10.8.0.4/32`, etc. — un
   numéro différent par appareil, jamais deux fois le même.)

4. Copiez la **clé publique** de CET appareil (affichée dans l'app) et allez la coller dans le
   bloc `[Peer]` correspondant du fichier serveur (étape 3.4) — remplacez le placeholder
   `<à remplir...>`. Réactivez le tunnel côté serveur pour appliquer.

`AllowedIPs = 10.8.0.0/24` côté client signifie que **seul** le trafic vers votre serveur passe
par le tunnel — votre navigation normale (autres sites) n'est pas affectée. C'est voulu : ce
n'est pas un VPN "tout passer par la maison", juste un accès privé à BackOS.

---

## 5. Pointer BackOS vers l'adresse du tunnel

Dans le **backend** (`.env.local`), rien à changer — `CORS_ORIGIN=*` fonctionne déjà pour
n'importe quelle origine, y compris via le tunnel.

Dans le **frontend** (`.env.local`), mettez à jour puis reconstruisez :

```
NEXT_PUBLIC_API_URL=http://10.8.0.1:4803/api
```

```
docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
```

Depuis un appareil connecté au tunnel, ouvrez `http://10.8.0.1:3000` — vous devriez atteindre
votre frontend, qui communique avec le backend via le tunnel.

---

## 6. Tester

1. Activez le tunnel WireGuard sur un appareil client (hors de votre wifi, en 4G par exemple,
   pour un vrai test).
2. `ping 10.8.0.1` doit répondre.
3. Ouvrez `http://10.8.0.1:3000` dans le navigateur — la page de connexion BackOS doit
   apparaître.

---

## 7. (Optionnel) HTTPS pour débloquer l'installation PWA

Comme expliqué précédemment, l'icône bureau (PWA) exige un contexte sécurisé (HTTPS). Un
certificat public classique ne peut pas être délivré pour une IP privée comme `10.8.0.1` —
mais c'est possible pour votre nom `backos-jarvis.duckdns.org` via la **validation DNS**
(DNS-01), qui ne nécessite pas que le serveur soit publiquement joignable sur le port 80/443 —
seulement que vous prouviez le contrôle du nom de domaine, ce que DuckDNS permet nativement.

C'est une mise en place plus avancée (certbot + plugin DuckDNS, ou `acme.sh`, puis servir le
certificat obtenu depuis Next.js/votre reverse proxy). Sans cette étape, BackOS reste
**entièrement fonctionnel** en HTTP simple via le tunnel — vous perdez uniquement l'icône
bureau installable. Dites-le-moi si vous voulez qu'on la mette en place, c'est une session à
part entière.

---

## 8. Ajouter un nouvel appareil plus tard

Répétez l'étape 4 avec le numéro d'IP suivant disponible (`10.8.0.4`, puis `.5`...), ajoutez le
bloc `[Peer]` correspondant côté serveur (étape 3.4), réactivez le tunnel serveur.

---

## 9. Migration vers le futur PC dédié

Le format de configuration WireGuard est identique sur toutes les plateformes (Windows, Linux,
Mac). Sur Linux, le rôle serveur se fait généralement via `wg-quick` en ligne de commande plutôt
que l'app graphique, mais le fichier `.conf` du serveur (étape 3.4) se réutilise tel quel. Seule
l'IP interne du serveur dans la redirection de port Livebox (étape 2) devra être mise à jour
pour pointer vers la nouvelle machine.

---

## Limites de ce guide

Je n'ai pas pu tester cette configuration de bout en bout (pas d'accès à votre Livebox, ni à un
vrai environnement Windows avec WireGuard dans mon environnement). Suivez chaque étape et
signalez-moi le message d'erreur exact si quelque chose coince — comme pour `pg_dump`
précédemment, il est probable qu'un détail demande un ajustement une fois confronté à votre
environnement réel.
