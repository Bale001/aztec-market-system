// The user's wallet: one persistent account that works across all markets,
// holding cUSDC (the marketplace currency) and a self-funded fee-juice balance
// (network gas). On testnet/mainnet cUSDC is a fixed token funded by bridging
// (Shield); on the local sandbox it is a deployable, mintable mock. Fees are
// paid from a private credit inside the shared PrivateFPC.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import {
  cusdcBalanceOf,
  deployMockCusdc,
  fpcCreditOf,
  mintCusdc,
  transferCusdc,
} from '@market/deployment';
import { useEffect, useState } from 'react';

import { ArweaveWalletCard } from './arweave-card.js';
import { SimplexCard } from './simplex-card.js';
import { WalletConnectCard } from './walletconnect-card.js';
import { ARWEAVE_GATEWAY_STORAGE_KEY, ARWEAVE_KEY_STORAGE_KEY } from './arweave.js';
import { defaultCusdcAddress, storeLocalMockCusdc } from './cusdc.js';
import { DEFAULT_L1_RPC, getL1RpcUrl, getL1Signer, setL1RpcUrl, setL1Signer } from './l1.js';
import {
  advanceBlocks,
  connectUniversal,
  loadOrCreateAccountKeys,
  storeAccountKeys,
  type AccountKeys,
  type UniversalSession,
} from './session.js';
import { runWithSpendContext } from './spend.js';
import { formatFeeJuice, formatUnits, message, parseUnits } from './ui.js';

// ---------------------------------------------------------------------------
// Backup & recovery. The wallet IS this device's stored secrets: the account
// keys (which unlock the cUSDC balance and FPC fee-juice credit -- the notes
// themselves are recovered from the chain by the PXE once the keys exist) and
// the per-market identity keys (vendor/owner/moderator pseudonyms). Exporting
// them as one JSON blob is a full wallet backup; restoring it on another
// computer recovers everything except market links, which the app never
// stores.
// ---------------------------------------------------------------------------

const IDENTITIES_PREFIX = 'market.identities.v1:';

interface WalletBackup {
  kind: 'aztec-market-wallet-backup';
  version: 1;
  account: AccountKeys;
  identities: Record<string, unknown>;
  settings: { cusdcMockAddress: string; registryAddress: string; arweaveGateway?: string };
  /** Arweave keyfile (JWK), when a storage wallet exists. Optional since v1. */
  arweaveKey?: unknown;
}

function collectBackup(): string {
  const identities: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith(IDENTITIES_PREFIX)) {
      identities[key.slice(IDENTITIES_PREFIX.length)] = JSON.parse(localStorage.getItem(key)!);
    }
  }
  const arweaveRaw = localStorage.getItem(ARWEAVE_KEY_STORAGE_KEY);
  const backup: WalletBackup = {
    kind: 'aztec-market-wallet-backup',
    version: 1,
    account: loadOrCreateAccountKeys(),
    identities,
    settings: {
      cusdcMockAddress: localStorage.getItem('cusdcMockAddress') ?? '',
      registryAddress: localStorage.getItem('registryAddress') ?? '',
      ...(localStorage.getItem(ARWEAVE_GATEWAY_STORAGE_KEY)
        ? { arweaveGateway: localStorage.getItem(ARWEAVE_GATEWAY_STORAGE_KEY)! }
        : {}),
    },
    ...(arweaveRaw !== null ? { arweaveKey: JSON.parse(arweaveRaw) } : {}),
  };
  return JSON.stringify(backup, null, 2);
}

function restoreBackup(text: string): void {
  const parsed = JSON.parse(text) as WalletBackup;
  if (parsed.kind !== 'aztec-market-wallet-backup' || parsed.version !== 1) {
    throw new Error('this is not an Aztec Market wallet backup');
  }
  if (!parsed.account?.secretKey || !parsed.account?.salt || !parsed.account?.signingKey) {
    throw new Error('the backup is missing the account keys');
  }
  storeAccountKeys(parsed.account);
  for (const [addr, data] of Object.entries(parsed.identities ?? {})) {
    localStorage.setItem(IDENTITIES_PREFIX + addr, JSON.stringify(data));
  }
  if (parsed.settings?.cusdcMockAddress) {
    localStorage.setItem('cusdcMockAddress', parsed.settings.cusdcMockAddress);
  }
  if (parsed.settings?.registryAddress) {
    localStorage.setItem('registryAddress', parsed.settings.registryAddress);
  }
  if (parsed.settings?.arweaveGateway) {
    localStorage.setItem(ARWEAVE_GATEWAY_STORAGE_KEY, parsed.settings.arweaveGateway);
  }
  if (parsed.arweaveKey !== undefined) {
    localStorage.setItem(ARWEAVE_KEY_STORAGE_KEY, JSON.stringify(parsed.arweaveKey));
  }
}

export function Wallet({ nodeUrl }: { nodeUrl: string }) {
  // Local sandbox uses the dev L1 (anvil); any other node bridges fee juice
  // from Ethereum Sepolia, which needs the L1 settings below.
  const isLocalNetwork = /localhost|127\.0\.0\.1/.test(nodeUrl);
  const [l1Rpc, setL1Rpc] = useState(() => getL1RpcUrl());
  const [l1SignerInput, setL1SignerInput] = useState(() => getL1Signer());
  const [session, setSession] = useState<UniversalSession | null>(null);
  // The cUSDC token address for this network: fixed on testnet/mainnet, the
  // locally-deployed mock on the sandbox.
  const [token, setToken] = useState(() => defaultCusdcAddress(nodeUrl));
  const [balance, setBalance] = useState<bigint | null>(null);
  const [fpcCredit, setFpcCredit] = useState<bigint | null>(null);
  const [mintAmount, setMintAmount] = useState('100');
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [backupCopied, setBackupCopied] = useState(false);
  const [restoreText, setRestoreText] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Which wallet subpage is showing — one per "thing" the wallet has.
  const [page, setPage] = useState<'funds' | 'connect' | 'storage' | 'messaging' | 'backup'>('funds');

  const onRestore = () => {
    setRestoreError(null);
    if (
      !window.confirm(
        'Restoring replaces the wallet on this device. If the current wallet holds funds and has no backup, they will be unrecoverable. Continue?',
      )
    ) {
      return;
    }
    try {
      restoreBackup(restoreText);
    } catch (err) {
      setRestoreError(message(err));
      return;
    }
    window.location.reload();
  };

  // Persist only the local mock's address; the fixed testnet/mainnet token isn't stored.
  useEffect(() => { if (isLocalNetwork) storeLocalMockCusdc(token); }, [token, isLocalNetwork]);
  // On a network switch, point at that network's cUSDC (fixed token, or the stored mock locally).
  useEffect(() => { setToken(defaultCusdcAddress(nodeUrl)); }, [nodeUrl]);

  async function run(label: string, action: () => Promise<void>) {
    setError(null);
    setBusy(label);
    try {
      // Any spend inside (network fee, upload) prompts under this label.
      await runWithSpendContext({ title: label }, action);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshBalances(s: UniversalSession, tokenAddr: string) {
    setFpcCredit(await fpcCreditOf({ wallet: s.wallet, fpcAddress: s.fpcAddress, account: s.from }));
    if (tokenAddr.trim() === '') {
      setBalance(null);
      return;
    }
    setBalance(
      await cusdcBalanceOf({
        wallet: s.wallet,
        node: s.node,
        from: s.from,
        tokenAddress: AztecAddress.fromStringUnsafe(tokenAddr),
        owner: s.from,
      }),
    );
  }

  const onConnect = () =>
    run('Opening your wallet…', async () => {
      const s = await connectUniversal(nodeUrl, { onProgress: setBusy });
      setSession(s);
      setBusy('Reading balances…');
      await refreshBalances(s, token);
    });

  const onDeployMock = () =>
    run('Deploying a mock cUSDC (local sandbox)…', async () => {
      if (session === null) throw new Error('connect first');
      // Local sandbox only: no real cUSDC exists, so deploy a standard 6-decimal
      // Token named cUSDC. The deployer becomes its minter (dev faucet). Paid by
      // the sponsored FPC so it works before any FPC credit exists.
      const addr = await deployMockCusdc({
        wallet: session.wallet,
        node: session.node,
        from: session.from,
        fee: { paymentMethod: session.bootstrapPaymentMethod },
      });
      setToken(addr.toString());
      await refreshBalances(session, addr.toString());
    });

  const onMint = () =>
    run('Minting mock cUSDC to your wallet…', async () => {
      if (session === null) throw new Error('connect first');
      await mintCusdc({
        wallet: session.wallet,
        node: session.node,
        from: session.from,
        fee: { paymentMethod: session.paymentMethod },
        tokenAddress: AztecAddress.fromStringUnsafe(token),
        to: session.from,
        // The input is whole cUSDC; cUSDC uses 6 decimals.
        amount: parseUnits(mintAmount || '0', 'mint amount'),
      });
      await refreshBalances(session, token);
    });

  // Sends cUSDC privately to any address -- most importantly to the user's own
  // per-market accounts (copy the address from a market's identity bar), which
  // pay escrow and vendor deposits themselves.
  const onSend = () =>
    run('Sending cUSDC privately…', async () => {
      if (session === null) throw new Error('connect first');
      await transferCusdc({
        wallet: session.wallet,
        node: session.node,
        from: session.from,
        fee: { paymentMethod: session.paymentMethod },
        tokenAddress: AztecAddress.fromStringUnsafe(token),
        to: AztecAddress.fromStringUnsafe(sendTo.trim()),
        amount: parseUnits(sendAmount || '0', 'send amount'),
      });
      setSendAmount('');
      await refreshBalances(session, token);
    });

  const onAddFeeJuice = () =>
    run('Bridging fee juice into your private FPC credit (this takes a bit)…', async () => {
      if (session === null) throw new Error('connect first');
      // Bridge fee juice from L1 with a claimer-bound secret, claim it, and
      // prove the claim in-circuit via mint -- crediting THIS account's private
      // balance inside the shared FPC. The bootstrap (sponsored) path pays for
      // the claim/mint txs and for forcing block production. Loaded lazily: the
      // L1-bridge module pulls viem + @aztec/ethereum, which must stay off the
      // wallet-open bundle.
      const { fundFpcCredit } = await import('@market/deployment/fpc-funding');
      if (isLocalNetwork) {
        await fundFpcCredit({
          wallet: session.wallet,
          node: session.node,
          fpcAddress: session.fpcAddress,
          claimer: session.from,
          salt: Fr.random(),
          produceL2Block: () => advanceBlocks(session, 1),
          fee: { paymentMethod: session.bootstrapPaymentMethod },
        });
      } else {
        // Testnet: the deposit is a real L1 (Sepolia) transaction; the L1->L2
        // message lands via the natural inbox (no forced blocks) and takes
        // minutes, so poll patiently. Needs a funded Sepolia signer.
        const signer = getL1Signer();
        if (signer === '') {
          throw new Error(
            'set your L1 (Sepolia) RPC and signer in “L1 bridge settings” below before adding fee juice',
          );
        }
        await fundFpcCredit({
          wallet: session.wallet,
          node: session.node,
          fpcAddress: session.fpcAddress,
          claimer: session.from,
          salt: Fr.random(),
          produceL2Block: () => Promise.resolve(),
          fee: { paymentMethod: session.bootstrapPaymentMethod },
          l1RpcUrl: getL1RpcUrl(),
          l1Mnemonic: signer,
          messagePollTries: 240,
          messagePollIntervalMs: 15_000, // ~60 min ceiling; breaks early when ready
        });
      }
      await refreshBalances(session, token);
    });

  return (
    <main className="home">
      <nav className="subnav">
        <button className={page === 'funds' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setPage('funds')}>Funds</button>
        <button className={page === 'connect' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setPage('connect')}>Connect a wallet</button>
        <button className={page === 'storage' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setPage('storage')}>Storage</button>
        <button className={page === 'messaging' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setPage('messaging')}>Messaging</button>
        <button className={page === 'backup' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setPage('backup')}>Backup</button>
      </nav>

      {page === 'funds' && (
      <div className="card">
        <h2>Your wallet</h2>
        <p>
          One wallet that works across every market. It holds <strong>cUSDC</strong> (the
          marketplace currency) and pays network fees in fee juice. Your wallet address is never shown in
          marketplace state — you act under pseudonymous identities per market.
        </p>

        {session === null ? (
          <div className="actions">
            <button onClick={() => void onConnect()} disabled={busy !== null}>Open wallet</button>
          </div>
        ) : (
          <>
            <dl className="summary">
              <dt>Wallet account</dt>
              <dd className="mono">{session.from.toString()}</dd>
            </dl>

            <h3>Balances</h3>
            <dl className="summary">
              <dt>cUSDC</dt>
              <dd title={balance === null ? undefined : `${balance.toString()} base units`}>
                {balance === null ? '—' : `${formatUnits(balance)} cUSDC`}
              </dd>
              <dt>Fee-juice credit (private FPC)</dt>
              <dd title={fpcCredit === null ? undefined : `${fpcCredit.toString()} base units`}>
                {fpcCredit === null ? '—' : `${formatFeeJuice(fpcCredit)} FJ`}{' '}
                <button className="secondary small" onClick={() => void onAddFeeJuice()} disabled={busy !== null}>
                  Add fee juice
                </button>
              </dd>
            </dl>
            <p className="hint">
              Your fees are paid from a private, self-funded credit inside a shared PrivateFPC: the
              FPC is the public fee payer for everyone (a large anonymity set), while your credit is a
              private note only you can spend. "Add fee juice" bridges 1000 FJ from L1 into your
              credit — enough for millions of transactions (a market deploy costs ~0.0001 FJ). Fund
              this before buying, selling, or creating a market.
            </p>

            {!isLocalNetwork && (
              <div className="box">
                <h4>L1 bridge settings (Sepolia)</h4>
                <p className="hint">
                  On testnet, “Add fee juice” deposits on Ethereum Sepolia. Provide a Sepolia RPC and
                  a funded signer (12-word mnemonic or 0x private key) — fund it with Sepolia ETH
                  (e.g. the Aztec faucet) to pay L1 gas. The key stays on this device, is used only
                  with the RPC below, and is not part of your wallet backup.
                </p>
                <label>Sepolia RPC URL</label>
                <input
                  type="text"
                  value={l1Rpc}
                  spellCheck={false}
                  placeholder={DEFAULT_L1_RPC}
                  onChange={e => { setL1Rpc(e.target.value); setL1RpcUrl(e.target.value); }}
                />
                <label>Signer (mnemonic or 0x private key)</label>
                <input
                  type="password"
                  value={l1SignerInput}
                  spellCheck={false}
                  placeholder="12 words, or 0x…"
                  onChange={e => { setL1SignerInput(e.target.value); setL1Signer(e.target.value); }}
                />
              </div>
            )}

            <h3>cUSDC token</h3>
            {isLocalNetwork ? (
              <>
                {/* Local sandbox: no real cUSDC exists, so deploy/join a MOCK (a
                    standard 6-decimal Token). The address input renders in both
                    states so a device that didn't deploy can paste a shared mock. */}
                <label>Mock cUSDC address (local sandbox — deploy one, or paste a shared mock's)</label>
                <input type="text" value={token} onChange={e => setToken(e.target.value)} placeholder="0x…" />
                {token.trim() === '' ? (
                  <>
                    <p className="hint">
                      No cUSDC on this local network. Deploy a mock cUSDC once — the deployer becomes
                      its minter — and share the address the way you share the registry address. On
                      testnet and mainnet the app uses the real cUSDC automatically.
                    </p>
                    <div className="actions">
                      <button onClick={() => void onDeployMock()} disabled={busy !== null}>Deploy mock cUSDC</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="row-actions">
                      <input
                        type="text"
                        value={mintAmount}
                        onChange={e => setMintAmount(e.target.value)}
                        placeholder="amount (whole cUSDC)"
                      />
                      <button onClick={() => void onMint()} disabled={busy !== null || mintAmount.trim() === ''}>
                        Mint cUSDC to my wallet
                      </button>
                      <button
                        className="secondary"
                        onClick={() => void run('Refreshing…', () => refreshBalances(session, token))}
                        disabled={busy !== null}
                      >
                        Refresh balances
                      </button>
                    </div>
                    <p className="hint">Minting works only from the wallet that deployed this mock cUSDC (its minter).</p>
                    <div className="actions">
                      <button className="secondary" onClick={() => void onDeployMock()} disabled={busy !== null}>
                        Redeploy mock cUSDC (fresh token)
                      </button>
                    </div>
                    <p className="hint">
                      Redeploy if the local network was reset — the address above then points at a
                      token that no longer exists (balance reads fail). This deploys a brand-new token
                      and replaces the stored address; old balances are gone with the old network, and
                      markets must be recreated so they use the new token.
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                <label>cUSDC token address (the standard token on this network)</label>
                <input type="text" value={token} readOnly spellCheck={false} />
                <p className="hint">
                  This network uses the standard cUSDC token. It can't be minted — fund your wallet
                  by bridging USDC in the “Connect a wallet” tab (Shield). Use Send below to top up
                  your per-market accounts.
                </p>
                <div className="row-actions">
                  <button
                    className="secondary"
                    onClick={() => void run('Refreshing…', () => refreshBalances(session, token))}
                    disabled={busy !== null}
                  >
                    Refresh balances
                  </button>
                </div>
              </>
            )}

            {token.trim() !== '' && (
              <>
                <h3>Send cUSDC</h3>
                <p className="hint">
                  Sends privately from this wallet to any address — e.g. to one of your own
                  per-market accounts (copy its address from the market's identity bar) so it can
                  pay escrow or a vendor deposit. Orders top up your market account automatically;
                  this is the manual path.
                </p>
                <label>Recipient address (0x…)</label>
                <input type="text" value={sendTo} onChange={e => setSendTo(e.target.value)} placeholder="0x…" />
                <div className="row-actions">
                  <input
                    type="text"
                    value={sendAmount}
                    onChange={e => setSendAmount(e.target.value)}
                    placeholder="amount (whole cUSDC)"
                  />
                  <button
                    onClick={() => void onSend()}
                    disabled={busy !== null || sendTo.trim() === '' || sendAmount.trim() === ''}
                  >
                    Send privately
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {busy !== null && <p className="log">{busy}</p>}
        {error !== null && <p className="error">{error}</p>}
      </div>
      )}

      {page === 'connect' && <WalletConnectCard session={session} />}

      {page === 'storage' && <ArweaveWalletCard />}

      {page === 'messaging' && <SimplexCard />}

      {page === 'backup' && (
      <div className="card">
        <h2>Backup &amp; recovery</h2>
        <p>
          Your wallet lives on this device: the account keys (which unlock your cUSDC and
          fee-juice balances), your per-market identity keys, and your Arweave storage keyfile.
          Export them to move to a new computer — balances are recovered from the chain once the
          keys are restored.
        </p>
        {backup === null ? (
          <div className="actions">
            <button className="secondary" onClick={() => setBackup(collectBackup())}>
              Export wallet backup
            </button>
          </div>
        ) : (
          <>
            <p className="error">
              This backup contains your secret keys. Anyone who has it controls your funds and
              identities. Store it somewhere safe.
            </p>
            <textarea readOnly value={backup} rows={6} />
            <div className="row-actions">
              <button
                className="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(backup).then(() => {
                    setBackupCopied(true);
                    setTimeout(() => setBackupCopied(false), 1500);
                  });
                }}
              >
                {backupCopied ? 'Copied ✓' : 'Copy to clipboard'}
              </button>
              <button className="secondary" onClick={() => setBackup(null)}>Hide</button>
            </div>
          </>
        )}

        <h3>Restore on this device</h3>
        <p className="hint">
          Paste a backup and restore. This replaces the wallet currently on this device — export
          it first if it holds funds. Market links (access secrets) are never stored by the app;
          keep those safe separately.
        </p>
        <textarea
          value={restoreText}
          onChange={e => setRestoreText(e.target.value)}
          placeholder='{"kind":"aztec-market-wallet-backup", …}'
          rows={4}
        />
        <div className="actions">
          <button onClick={onRestore} disabled={restoreText.trim() === ''}>Restore backup</button>
        </div>
        {restoreError !== null && <p className="error">{restoreError}</p>}
      </div>
      )}
    </main>
  );
}
