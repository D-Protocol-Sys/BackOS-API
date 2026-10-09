# BackOS documentation

[← Back to the project README](../README.md)

| Topic                                  | Where                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| **Run BackOS** (all modes)             | [Deployment guides](deployments/README.md)                                      |
| Change BackOS's code (hot reload)      | [Development](deployments/DEPLOIEMENT_DEV.md)                                   |
| Use BackOS on your own computer        | [Local](deployments/DEPLOIEMENT_LOCAL.md)                                       |
| Automatic builds and deploys           | [CI/CD](deployments/CI_CD.md)                                                   |
| What is tested, and what not           | [Tests coverage audit](TESTS_COVERAGE_AUDIT.md)                                 |
| How `/generated/<slug>/...` is routed  | [`src/gateway/GATEWAY_README.md`](../src/gateway/GATEWAY_README.md)             |

## Folder layout

```
docs/
├── README.md                          ← you are here
├── TESTS_COVERAGE_AUDIT.md
└── deployments/
    ├── README.md                      ← start here: overview and "which guide?"
    ├── DEPLOIEMENT_DEV.md             ← Development (API on your machine, hot reload)
    ├── DEPLOIEMENT_LOCAL.md           ← Local (stable, everything in Docker, your own computer)
    ├── DEPLOIEMENT_LAN.md             ← LAN (private instance on a dedicated PC, Windows tray)
    ├── DEPLOIEMENT_DEMO.md            ← Demo (public, read-only)
    ├── DEPLOIEMENT_PRODUCTION.md      ← Production
    ├── DEPLOIEMENT_WIREGUARD.md       ← WireGuard (remote access)
    ├── DEPLOIEMENT_INTERNE_TAILSCALE.md ← Tailscale (alternative not chosen)
    ├── CI_CD.md                       ← GitHub Actions pipelines
    └── combines/
        ├── DEPLOIEMENT_COMBINE_DEMO_PRODUCTION.md
        ├── DEPLOIEMENT_COMBINE_PRODUCTION_WIREGUARD.md
        └── DEPLOIEMENT_COMBINE_LAN_DEMO_WIREGUARD.md
```
