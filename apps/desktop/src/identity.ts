// Per-market account store + role resolution (account model).
//
// On a market, a user acts through per-market ACCOUNTS derived from their
// universal seed + the market access secret + an index (see
// @market/identity deriveMarketAccountKeys). This module tracks, per market,
// the accounts the user has (each = an index + a label + an optional
// registered username) and which one is active. The active account's ADDRESS
// is the on-chain identity (msg_sender); its role (owner / moderator / vendor /
// buyer) is read from the contract by that address.
//
// Index 0 is the auto-created "anonymous" account: the browsing identity, which
// never claims a handle and so stays anonymous. (Buying does not use it at all
// -- orders are placed by the universal wallet directly.) Named accounts
// (index 1+) are created by CLAIMING A USERNAME -- there is no separate "create
// account" step -- and carry that username registered on-chain; a market you
// own has an "owner" account.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import {
  getModeratorPermissions,
  getSuperadminIdentity,
  getUsernameHash,
  getVendorRecord,
} from '@market/deployment';
import { VendorStatus } from '@market/shared-types';

import type { Session } from './session.js';

export type AccountKind = 'anonymous' | 'named' | 'owner';

export interface StoredIdentity {
  id: string;
  label: string;
  /** Derivation index of this per-market account (0 = anonymous). */
  index: number;
  /** Registered username, or null (anonymous/unregistered). */
  username: string | null;
  kind: AccountKind;
}

interface MarketAccounts {
  accounts: StoredIdentity[];
  activeId: string;
}

const storageKey = (marketAddr: string) => `market.accounts.v1:${marketAddr}`;

function load(marketAddr: string): MarketAccounts | null {
  const raw = localStorage.getItem(storageKey(marketAddr));
  if (raw === null) {
    return null;
  }
  const parsed = JSON.parse(raw) as MarketAccounts;
  if (!Array.isArray(parsed.accounts)) {
    throw new Error('stored accounts are malformed; clear app data to reset');
  }
  return parsed;
}

function save(marketAddr: string, data: MarketAccounts): void {
  localStorage.setItem(storageKey(marketAddr), JSON.stringify(data));
}

function newId(): string {
  return crypto.randomUUID();
}

/** The next free derivation index for a new account on this market. */
function nextIndex(accounts: StoredIdentity[]): number {
  return accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1;
}

export function listIdentities(marketAddr: string): StoredIdentity[] {
  return load(marketAddr)?.accounts ?? [];
}

export function getActiveIdentity(marketAddr: string): StoredIdentity | null {
  const data = load(marketAddr);
  if (data === null) {
    return null;
  }
  return data.accounts.find(a => a.id === data.activeId) ?? data.accounts[0] ?? null;
}

export function setActiveId(marketAddr: string, id: string): void {
  const data = load(marketAddr);
  if (data === null || !data.accounts.some(a => a.id === id)) {
    throw new Error(`unknown account ${id}`);
  }
  save(marketAddr, { ...data, activeId: id });
}

/**
 * Creates a new per-market account with the next derivation index, and makes it
 * active. Driven by claiming a username (see App's claimUsername): the
 * `username` is recorded locally here, while registering it ON-CHAIN is done by
 * the caller from this account's session -- so the caller must roll this account
 * back (deleteIdentity) if that transaction fails.
 */
export function createIdentity(marketAddr: string, label: string, username: string | null = null): StoredIdentity {
  const data = load(marketAddr) ?? { accounts: [], activeId: '' };
  const account: StoredIdentity = {
    id: newId(),
    label: label.trim() === '' ? `Account ${data.accounts.length + 1}` : label.trim(),
    index: nextIndex(data.accounts),
    username,
    kind: username === null ? 'anonymous' : 'named',
  };
  save(marketAddr, { accounts: [...data.accounts, account], activeId: account.id });
  return account;
}

export function renameIdentity(marketAddr: string, id: string, label: string): void {
  const data = load(marketAddr);
  if (data === null) {
    return;
  }
  save(marketAddr, {
    ...data,
    accounts: data.accounts.map(a => (a.id === id ? { ...a, label: label.trim() || a.label } : a)),
  });
}

/** Records that an account's username was registered on-chain. */
export function setIdentityUsername(marketAddr: string, id: string, username: string): void {
  const data = load(marketAddr);
  if (data === null) {
    return;
  }
  save(marketAddr, {
    ...data,
    accounts: data.accounts.map(a =>
      a.id === id ? { ...a, username, kind: a.kind === 'owner' ? 'owner' : 'named' } : a,
    ),
  });
}

export function deleteIdentity(marketAddr: string, id: string): void {
  const data = load(marketAddr);
  if (data === null) {
    return;
  }
  const target = data.accounts.find(a => a.id === id);
  if (target === undefined || target.kind === 'owner' || target.kind === 'anonymous' || data.accounts.length <= 1) {
    throw new Error('cannot delete this account');
  }
  const accounts = data.accounts.filter(a => a.id !== id);
  const activeId = data.activeId === id ? accounts[0]!.id : data.activeId;
  save(marketAddr, { accounts, activeId });
}

/** Guarantees the market has the anonymous (index 0) browsing account. */
export function ensureSeed(marketAddr: string): void {
  const data = load(marketAddr);
  const anon: StoredIdentity = {
    id: newId(),
    label: 'Anonymous',
    index: 0,
    username: null,
    kind: 'anonymous',
  };
  if (data === null || data.accounts.length === 0) {
    save(marketAddr, { accounts: [anon], activeId: anon.id });
    return;
  }
  // A market this user DEPLOYED starts with only the Owner account (index 1),
  // leaving index 0 free. It still needs the anonymous account: without it the
  // owner cannot browse their own market unlinked from the owner identity, and
  // -- since claiming a username mints the new wallet from the anonymous
  // account -- could never create a second identity at all. Only ever appends;
  // never changes which account is active.
  if (!data.accounts.some(a => a.index === 0)) {
    save(marketAddr, { ...data, accounts: [...data.accounts, anon] });
  }
}

/**
 * Ensures an Owner account exists for a market this user owns, at the given
 * `index` (the index whose derived address is the market's superadmin). Newly
 * added, it becomes the active account.
 */
export function ensureOwnerIdentity(marketAddr: string, index: number, username: string | null = null): StoredIdentity {
  const data = load(marketAddr) ?? { accounts: [], activeId: '' };
  const existing = data.accounts.find(a => a.kind === 'owner');
  if (existing !== undefined) {
    return existing;
  }
  const owner: StoredIdentity = {
    id: newId(),
    label: 'Owner',
    index,
    username,
    kind: 'owner',
  };
  save(marketAddr, { accounts: [owner, ...data.accounts], activeId: owner.id });
  return owner;
}

export interface Role {
  isOwner: boolean;
  moderatorPerms: bigint;
  vendorStatus: VendorStatus;
  /**
   * The account claimed a username on this market (users_reverse != 0).
   * Registration is the on-chain prerequisite for becoming a vendor and what
   * lets the operator appoint the account as a moderator by username.
   */
  registered: boolean;
  /** The account's on-chain address on this market (hex). */
  address: string;
}

/**
 * Resolves the role an account address holds on a market. Everything is a
 * function of the address: the caller is the owner iff their per-market account
 * address equals the market's stored superadmin address; moderator/vendor
 * status are read from the maps keyed by that address. All reads are
 * simulations (no transaction).
 */
export async function resolveRole(
  viewer: Session,
  marketplaceAddress: AztecAddress,
  accountAddress: AztecAddress,
): Promise<Role> {
  const common = {
    wallet: viewer.wallet,
    node: viewer.node,
    from: viewer.from,
    marketplaceAddress,
  };
  const key = accountAddress.toField();
  const superadmin = await getSuperadminIdentity(common);
  const isOwner = key.equals(superadmin);
  const moderatorPerms = await getModeratorPermissions({ ...common, moderatorIdentity: key });
  const vendor = await getVendorRecord({ ...common, vendorId: key });
  const usernameHash = await getUsernameHash({ ...common, account: key });
  return {
    isOwner,
    moderatorPerms,
    vendorStatus: vendor.status,
    registered: !usernameHash.isZero(),
    address: accountAddress.toString(),
  };
}

export function roleLabel(role: Role): string {
  if (role.isOwner) {
    return 'Owner';
  }
  if (role.moderatorPerms !== 0n) {
    return 'Moderator';
  }
  switch (role.vendorStatus) {
    case VendorStatus.Active:
      return 'Vendor';
    case VendorStatus.Pending:
      return 'Vendor (pending)';
    case VendorStatus.Suspended:
      return 'Vendor (suspended)';
    default:
      return 'Buyer';
  }
}
