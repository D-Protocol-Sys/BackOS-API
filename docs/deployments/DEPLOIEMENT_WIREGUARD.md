# WireGuard: remote access to a private instance

[← All deployment guides](README.md)

Reach your private BackOS from anywhere, through an **encrypted tunnel**, without exposing the application to the Internet. No third-party service: you configure WireGuard yourself, and a free dynamic DNS name follows your public IP if it changes.

| At a glance               |                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| **Best for**              | Remote access to a [LAN](DEPLOIEMENT_LAN.md) or [Local](DEPLOIEMENT_LOCAL.md) instance, with no public exposure |
| **Reachable from**        | Only devices that hold a WireGuard key                                                              |
| **You will need**         | A router where you can forward one **UDP** port, and WireGuard on the server and on each device     |
| **Only one port exposed** | UDP `51820`: a simple encrypted meeting point, not the application                                  |

**On this page:** [How it works](#how-it-works) · [Choose your server system](#choose-your-server-system) · [1. Dynamic DNS](#1-create-a-dynamic-dns-account-duckdns) · [2. Router](#2-forward-the-wireguard-port-on-your-router) · [3. Server](#3-install-wireguard-and-configure-the-server) · [4. Devices](#4-configure-each-device) · [5. Front end](#5-optional-point-the-front-end-to-the-tunnel-address) · [6. Test](#6-test-the-tunnel) · [Add a device](#add-a-new-device-later) · [Troubleshooting](#troubleshooting)

---

## How it works

```
Server (10.8.0.1)  ── encrypted WireGuard tunnel ──  Devices (10.8.0.2, .3, …)
  BackOS API        :4803  (LAN) or :<LOCAL_PORT> (Local)       wherever you are
  BackOS front end  :3000  (only if you run it on the server)
```

Once the tunnel is up, your device reaches the server through its **private tunnel address `10.8.0.1`**, exactly as if you were on your local network. Only the WireGuard port (UDP `51820`) is opened on your router.

| Stack you reach through the tunnel | Address of its API                                |
| ---------------------------------- | ------------------------------------------------- |
| [LAN](DEPLOIEMENT_LAN.md)          | `http://10.8.0.1:4803`                            |
| [Local](DEPLOIEMENT_LOCAL.md)      | `http://10.8.0.1:<LOCAL_PORT>`                    |

(Both stacks publish their port on every network interface of the server, the tunnel included. For a public production, see [Production + WireGuard](combines/DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md): there, WireGuard protects the administration tools, not the application.)

**Rules to remember**

- **One key pair per device.** Never share a key between devices or people: if a device is lost, you revoke only its key.
- **A private key never leaves its device.** You exchange **public** keys only.
- Tunnel addresses must be **unique**: `10.8.0.1` for the server, then `10.8.0.2`, `10.8.0.3`… one per device.

---

## Choose your server system

The server is the machine that runs your BackOS stack. The configuration file is **identical** on every system; only the tool that starts it differs.

|                        | **Windows server**                              | **Linux server**                                    |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------- |
| WireGuard tool         | The official app (graphical)                    | `wg-quick` (command line)                           |
| Keep the IP up to date | A scheduled PowerShell script                   | A `cron` job                                        |
| Where to read          | Steps marked **Windows**                        | Steps marked **Linux**                              |

---

## 1. Create a dynamic DNS account (DuckDNS)

Your public IP may be stable in practice, but nothing guarantees it will never change. DuckDNS gives it a fixed name that updates itself.

1. Go to <https://www.duckdns.org> and sign in (free, with GitHub or Google).
2. Create a sub-domain, for example `my-backos` → you get `my-backos.duckdns.org`.
3. Note your personal **token**, shown at the top of the page. You need it below. Keep it private.

### Keep the IP up to date

**Windows.** Create a file `duckdns-update.ps1`:

```powershell
$token  = "YOUR_TOKEN_HERE"
$domain = "my-backos"
Invoke-WebRequest -Uri "https://www.duckdns.org/update?domains=$domain&token=$token&ip=" -UseBasicParsing
```

Then schedule it every 5 minutes with the **Windows Task Scheduler** (`taskschd.msc`): *Create Basic Task* → trigger: repeat every 5 minutes → action: start a program `powershell.exe` with the argument `-File C:\path\to\duckdns-update.ps1`.

**Linux.** Add one line to your crontab (`crontab -e`):

```cron
*/5 * * * * curl -s "https://www.duckdns.org/update?domains=my-backos&token=YOUR_TOKEN_HERE&ip=" >/dev/null
```

---

## 2. Forward the WireGuard port on your router

In your router's administration page (often `192.168.1.1`; the menu names vary by brand):

1. Find **Port forwarding**, sometimes called *NAT/PAT* or *Home network*.
2. Add a rule: protocol **UDP**, external port **51820**, internal port **51820**, internal IP = the **local IP of your server**.
   To find that IP: `ipconfig` on Windows, `hostname -I` on Linux. It looks like `192.168.1.xx`.
3. **Tip:** reserve a fixed local IP for the server in the router (*DHCP reservation*), so that the rule stays valid after a reboot.

> [!NOTE]
> Behind CGNAT (your provider shares one public IP between several homes), forwarding is impossible without your provider's help.

> [!WARNING]
> Forward **only** UDP `51820`. Never forward the BackOS port (`4803` or your `LOCAL_PORT`): the whole point is that the application stays invisible to the Internet.

---

## 3. Install WireGuard and configure the server

The server's configuration file looks the same everywhere:

```ini
[Interface]
PrivateKey = <the server's private key>
Address = 10.8.0.1/24
ListenPort = 51820

# One [Peer] block per device. Add one for each new device.
[Peer]
# Name: Laptop
PublicKey = <public key of the laptop, filled in at step 4>
AllowedIPs = 10.8.0.2/32

[Peer]
# Name: Phone
PublicKey = <public key of the phone, filled in at step 4>
AllowedIPs = 10.8.0.3/32
```

### Windows

1. Install the official client: <https://www.wireguard.com/install/>.
2. Open the app → **Add Tunnel** → **Add empty tunnel**. It generates a key pair and opens an editor.
3. Note the **public key** shown at the top of the window. You need it for each device.
4. Replace the editor's content with the file above, **keeping the `PrivateKey` that the app already generated**.
5. Save and switch the tunnel **on**. Windows asks to allow the firewall: accept.

### Linux

```bash
sudo apt install wireguard                      # Debian/Ubuntu; use your package manager otherwise
wg genkey | sudo tee /etc/wireguard/server.key | wg pubkey | sudo tee /etc/wireguard/server.pub
sudo chmod 600 /etc/wireguard/server.key
sudo cat /etc/wireguard/server.pub              # this is the public key to give to each device
```

Save the file above as `/etc/wireguard/wg0.conf`, with the content of `server.key` as `PrivateKey`. Then start it, and make it start at boot:

```bash
sudo systemctl enable --now wg-quick@wg0
```

Your firewall must let UDP `51820` in.

---

## 4. Configure each device

Do this on **every device** that must connect (laptop, phone…).

1. Install the official WireGuard client: <https://www.wireguard.com/install/> for Windows/macOS/Linux, or the **WireGuard** app on the App Store / Google Play.
2. Create an **empty tunnel**: the app generates the device's own key pair.
3. Replace the content with:

   ```ini
   [Interface]
   PrivateKey = <already filled by THIS device's app>
   Address = 10.8.0.2/32

   [Peer]
   PublicKey = <the SERVER's PUBLIC key, noted at step 3>
   Endpoint = my-backos.duckdns.org:51820
   AllowedIPs = 10.8.0.0/24
   PersistentKeepalive = 25
   ```

   For the second device use `Address = 10.8.0.3/32`, for the third `10.8.0.4/32`, and so on: **a different number per device, never twice the same**.

4. Copy **this device's public key** (shown in the app) and paste it into the matching `[Peer]` block of the **server** file, in place of the placeholder. Then **reload the tunnel on the server** to apply it:
   - Windows: switch the tunnel off and on in the app.
   - Linux: `sudo systemctl restart wg-quick@wg0`.

`AllowedIPs = 10.8.0.0/24` means that **only** the traffic to your server goes through the tunnel. Your normal browsing is not affected. This is intentional: it is not an "everything through home" VPN, just a private access to BackOS. For the same reason there is **no `DNS` line**: you reach the server by its IP address, and your device keeps its usual DNS.

---

## 5. (Optional) Point the front end to the tunnel address

Skip this step if you only use the API. If you also run the BackOS **web interface** (the front end, a separate project with its own repository), tell it to use the tunnel address of the API.

- **Back end:** if `CORS_ORIGIN=*` (accepts any origin) in your settings file (`.env.lan` or `.env.local`), nothing to change: it already works through the tunnel. If you restricted `CORS_ORIGIN`, add the address from which you open the front end.
- **Front end:** in the **front-end project**, set the API address in its settings file (`.env.local` there), for the [LAN](DEPLOIEMENT_LAN.md) stack:

  ```ini
  NEXT_PUBLIC_API_URL=http://10.8.0.1:4803/api
  ```

  This value is **baked into the build**, so rebuild the front end after changing it. In the front-end project:

  ```bash
  docker compose -f docker-compose.local.yml --env-file .env.local up -d --build
  ```

  (This command belongs to the front-end project, not to this repository. Follow its own README if it differs.)

If the front end runs on the server, open `http://10.8.0.1:3000` from a device connected to the tunnel.

---

## 6. Test the tunnel

1. Switch the WireGuard tunnel **on** on a device. For a real test, be **outside your Wi-Fi** (4G, for example).
2. `ping 10.8.0.1` should answer.
3. Open `http://10.8.0.1:4803/api/health` (the API of the [LAN](DEPLOIEMENT_LAN.md) stack; use your `LOCAL_PORT` for [Local](DEPLOIEMENT_LOCAL.md)). It must answer `200`.
4. If you run the front end, open it (for example `http://10.8.0.1:3000`): the BackOS sign-in page should appear.

✅ If it does, your private instance is now reachable from anywhere, and still invisible to the Internet.

---

## Add a new device later

Repeat [step 4](#4-configure-each-device) with the next free address (`10.8.0.4`, then `.5`…), add the matching `[Peer]` block to the server file, and reload the server tunnel.

## Move the server to another machine

The configuration format is identical on Windows, Linux and macOS: the server file can be reused as is. Only one thing changes: in the router's forwarding rule ([step 2](#2-forward-the-wireguard-port-on-your-router)), point to the **new machine's local IP**.

---

## Troubleshooting

| Symptom                                                    | Cause and fix                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tunnel switches on but nothing answers                 | The device's public key is missing from the server file, or the tunnel was not reloaded on the server (step 4.4). Also check the **`Endpoint`** name and the router's UDP forwarding. |
| `ping 10.8.0.1` fails, but the app shows a recent handshake | A server firewall may block ping. Try opening the BackOS address directly.                                                                                      |
| The ping works but `http://10.8.0.1:4803` does not         | On a Windows server, the firewall may block incoming connections on port `4803` for the WireGuard network. Allow that port for this network, and only for it.   |
| It worked, and now your device cannot connect              | Your public IP changed and the DNS name was not updated. Check the DuckDNS update script or cron job (step 1).                                                  |
| Two devices disturb each other                             | They use the **same tunnel address**. Give each device its own (`10.8.0.2`, `10.8.0.3`…).                                                                       |
| Nothing works from outside, while it works at home         | UDP `51820` is not forwarded, the rule points to the wrong local IP, or you are behind CGNAT.                                                                   |

---

## Optional: HTTPS, to be able to install the web app (PWA)

Browsers require a secure context (HTTPS) to offer *Install the app*. A public certificate cannot be issued for a private IP like `10.8.0.1`, but it can be for your DuckDNS name through **DNS validation** (DNS-01), which does not require the server to be reachable on ports 80/443: you only prove control of the domain name, which DuckDNS supports natively.

This is a more advanced setup (certbot with a DuckDNS plugin, or `acme.sh`, then serving the certificate from your front end or reverse proxy), and it is **not covered here**. Without it, BackOS stays **fully functional** in plain HTTP through the tunnel: you only lose the installable desktop icon.

---

## Next steps

- Combine it with a public demo on one machine: [LAN + Demo + WireGuard](combines/DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md).
- Protect the admin access of a public production: [Production + WireGuard](combines/DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md).
- Considered Tailscale instead? [Why it was rejected](DEPLOIEMENT_INTERNE_TAILSCALE.md).
