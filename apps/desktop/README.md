# Aztec Market — desktop app

A single Electron app that unifies what used to be the separate Creator and
Portal web apps. One download, a top-level mode switch, and per-market tabs:

- **Shop** — open a hidden market from its link + registry address, browse the
  storefront (category sidebar, product rows, pagination), buy privately, and
  manage your orders. Also exposes **Vendor** and **Admin** tabs and any
  operator-authored **custom pages**.
- **Create a market** — the deployment wizard (config → review → deploy),
  including custom-page authoring. The deploying account is the market's
  superadmin; its keys are shown so you can administer the market from the
  Admin tab or another device.

Everything runs locally: the embedded Aztec wallet lives in the renderer, and
market secrets never leave the device. The app talks to a local Aztec node
(default `http://localhost:8080`).

## Develop

```bash
# from the repo root, once:
yarn install

# start the Vite renderer + Electron together:
yarn workspace @market/desktop dev
```

`dev` runs Vite on port 5175 and launches Electron pointed at it (hot reload).
You need a local Aztec network running (`aztec start --local-network`).

## Build & package

```bash
yarn workspace @market/desktop build     # type-check + bundle the renderer
yarn workspace @market/desktop package   # electron-builder -> release/
```

`package` targets NSIS (Windows), AppImage (Linux), and dmg (macOS) per the
`build` block in `package.json`. Packaging downloads the Electron binary for
the host platform on first run.

## Notes

- Product images are placeholders (deterministic gradients from the title).
  Real listing images await the off-chain image strategy (AD-3).
- `webSecurity` is disabled in the main process so the packaged `file://`
  origin can reach the local node over http; this is a local tool with no
  remote content.
- Custom pages are sealed into the market metadata like everything else, so
  they share the ~3968-byte on-chain metadata budget — keep them brief.
