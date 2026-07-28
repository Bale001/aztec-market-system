# Dev environment setup

All Aztec tooling is Linux-native. On Windows, everything runs inside **WSL2**;
the repo lives in the WSL filesystem (`~/aztec-market-system`) for I/O performance.
From Windows it is reachable at `\\wsl.localhost\Ubuntu\home\hayden\aztec-market-system`.

## One-time setup (done 2026-07-09)

1. WSL2 + Ubuntu (requires VT-x enabled in BIOS and the Virtual Machine Platform
   Windows feature).
2. systemd enabled in `/etc/wsl.conf` (`[boot] systemd=true`).
3. Docker Engine (`apt install docker.io`), user added to the `docker` group.
   No Docker Desktop.
4. Node via nvm (v24), then the Aztec toolchain:
   ```sh
   curl -fsSL https://install.aztec.network | bash
   aztec-up install 4.2.0
   aztec-up use 4.2.0
   ```

## Quirks to know

- **Non-interactive shells must `source ~/aztec-env.sh` first.** The `aztec` CLI
  is a Node wrapper; without nvm on PATH it fails with `exec: node: not found`.
- v4.2.0 ships the compiler as plain `nargo`; a wrapper at `~/.aztec/bin/aztec-nargo`
  execs `~/.aztec/current/bin/nargo`.
- Always use `aztec compile` / `aztec test`, never bare `nargo` (see CLAUDE.md).
- The Noir git dependency cache lives at `~/nargo/github.com/...`.

## Version pinning

Everything is pinned to **v4.2.0**: `@aztec/*` npm packages, the `aztec-nr` git tag
in each `Nargo.toml`, and the active toolchain (`aztec-up use 4.2.0`). Upgrade
deliberately between milestones, never mid-milestone (PLAN.md risk #5).
