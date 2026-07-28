// Renderer-side client for the embedded SimpleX core (AD-6). The core runs
// in the Electron main process (native addon + SQLite, see
// electron/simplex.cjs); this module types the preload bridge and layers the
// market policy on top:
//
//   - ONE SimpleX user profile per market ACCOUNT (created lazily, named after
//     that account's pseudonym), so activity is unlinkable at the messaging
//     layer BOTH across markets and across accounts on one market. Two accounts
//     are two personas; sharing a message store between them would defeat the
//     reason for having more than one. The mapping is device-local, same
//     durability class as the PXE store. See profileKey.
//   - the DISPUTE-desk profile is the exception and stays per market: its
//     address is published on-chain, so it belongs to the market, not a persona.
//   - the market's DISPUTE address is a business address: every connecting
//     buyer lands in a fresh group with the owner -- the per-dispute room
//     the moderators are then invited into.
//   - buyers connect to dispute addresses INCOGNITO (a random one-off
//     profile), so a dispute links to neither their pseudonym nor other
//     disputes.

import { getActiveIdentity } from './identity.js';

/** Minimal shapes of the bridge's JSON payloads (subset we consume). */
export interface SimplexUser {
  userId: number;
  localDisplayName: string;
  activeUser?: boolean;
}

export interface SimplexUserInfo {
  user: SimplexUser;
  unreadCount?: number;
}

export interface SimplexContact {
  contactId: number;
  localDisplayName: string;
}

export interface SimplexGroup {
  groupId: number;
  localDisplayName: string;
  /** This profile's own member record; memberStatus 'invited' = not joined yet. */
  membership?: { memberStatus?: string };
}

export interface SimplexGroupMember {
  groupMemberId: number;
  memberRole: string;
  localDisplayName: string;
}

export type SimplexMemberRole = 'member' | 'admin' | 'owner' | 'observer';

interface SimplexBridge {
  status(): Promise<{ initialized: boolean; started: boolean; users: SimplexUserInfo[] }>;
  init(): Promise<{ users: SimplexUserInfo[] }>;
  createUser(displayName: string): Promise<SimplexUser>;
  setActiveUser(userId: number): Promise<SimplexUser>;
  start(): Promise<{ started: boolean }>;
  createAddress(
    userId: number,
    options: { business: boolean; welcomeMessage?: string },
  ): Promise<string>;
  getAddress(userId: number): Promise<string | null>;
  connect(userId: number, link: string, incognito: boolean): Promise<unknown>;
  listContacts(userId: number): Promise<SimplexContact[]>;
  listGroups(userId: number): Promise<SimplexGroup[]>;
  listMembers(userId: number, groupId: number): Promise<SimplexGroupMember[]>;
  addMember(
    userId: number,
    groupId: number,
    contactId: number,
    role: SimplexMemberRole,
  ): Promise<unknown>;
  /** Joins a group this profile was invited to (see the main-process note). */
  joinGroup(userId: number, groupId: number): Promise<unknown>;
  sendText(
    userId: number,
    chatType: 'direct' | 'group',
    chatId: number,
    text: string,
  ): Promise<unknown>;
  getChats(userId: number): Promise<unknown[]>;
  getChat(
    userId: number,
    chatType: 'direct' | 'group',
    chatId: number,
    count: number,
  ): Promise<unknown>;
  onEvent(handler: (event: { type: string } & Record<string, unknown>) => void): () => void;
}

declare global {
  interface Window {
    marketSimplex?: SimplexBridge;
  }
}

/** The bridge exists only inside Electron (not in a plain-browser dev tab). */
export function simplexAvailable(): boolean {
  return typeof window !== 'undefined' && window.marketSimplex !== undefined;
}

export function simplex(): SimplexBridge {
  const bridge = window.marketSimplex;
  if (bridge === undefined) {
    throw new Error(
      'the messaging core is only available inside the desktop app',
    );
  }
  return bridge;
}

/**
 * Initializes the core (first call creates the database) and starts the
 * messaging loop if any profile exists yet. Safe to call repeatedly.
 */
export async function ensureSimplexRunning(): Promise<{
  users: SimplexUserInfo[];
  started: boolean;
}> {
  const bridge = simplex();
  const { users } = await bridge.init();
  if (users.length === 0) {
    return { users, started: false };
  }
  const { started } = await bridge.start();
  return { users, started };
}

const PROFILE_KEY_PREFIX = 'market.simplexUser.v1.';

/** Profile scopes: 'main' is the user's own market presence (vendor contact,
 * buyer messaging, moderator contact); 'dispute' is the operator's dispute
 * desk. Separate scopes exist because a SimpleX profile has exactly ONE
 * contact address: the dispute intake must be a BUSINESS address while the
 * same person's vendor/moderator contact must stay personal -- on one shared
 * profile the two flipped each other's settings and broke repeat connects
 * (found in the live 2-instance run, operator==vendor). */
export type ProfileScope = 'main' | 'dispute';

/**
 * Marks which per-market account inherited the pre-account-scoping profile, so
 * exactly one account adopts it and the rest start clean.
 */
const PROFILE_CLAIM_PREFIX = 'market.simplexUserClaim.v1.';

/**
 * The messaging profile key.
 *
 * 'main' is PER ACCOUNT, not per market. A per-market account is a separate
 * persona -- that is the entire point of having more than one -- so they must
 * not share a message store, a contact list, or a display name. Keyed by
 * derivation index, which is what identifies the account on-chain, rather than
 * by label or username: those are editable and two accounts may share them.
 *
 * 'dispute' stays PER MARKET on purpose. It is the market's dispute desk, whose
 * address is published on-chain, not a persona; scoping it per account would
 * strand every open dispute the moment the owner switched accounts.
 */
function profileKey(marketAddress: string, scope: ProfileScope): string {
  if (scope !== 'main') {
    return `${PROFILE_KEY_PREFIX}${scope}:${marketAddress}`;
  }
  const index = getActiveIdentity(marketAddress)?.index ?? 0;
  return `${PROFILE_KEY_PREFIX}acct${index}:${marketAddress}`;
}

/**
 * Hands the historical un-scoped profile to the first account that asks for
 * one, so an install that predates account scoping keeps its conversations
 * instead of silently starting empty. Every other account gets a fresh profile.
 */
function adoptLegacyProfile(marketAddress: string): void {
  const legacyKey = PROFILE_KEY_PREFIX + marketAddress;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy === null) {
    return;
  }
  const claimKey = PROFILE_CLAIM_PREFIX + marketAddress;
  if (localStorage.getItem(claimKey) !== null) {
    return; // already inherited by some account
  }
  const key = profileKey(marketAddress, 'main');
  if (localStorage.getItem(key) === null) {
    localStorage.setItem(key, legacy);
  }
  localStorage.setItem(claimKey, key);
}

/** The stored profile for (market, scope), or null if never created. */
export async function loadStoredMarketProfile(
  marketAddress: string,
  scope: ProfileScope,
): Promise<SimplexUser | null> {
  if (scope === 'main') {
    adoptLegacyProfile(marketAddress);
  }
  const storedId = localStorage.getItem(profileKey(marketAddress, scope));
  if (storedId === null) {
    return null;
  }
  const { users } = await simplex().init();
  return users.find(u => u.user.userId === Number(storedId))?.user ?? null;
}

/**
 * The SimpleX profile this device uses on a given market, created on first
 * use. `displayName` should be the caller's pseudonym-ish handle for the
 * market -- it is what other members of a dispute group see.
 */
export async function ensureMarketProfile(
  marketAddress: string,
  displayName: string,
  scope: ProfileScope = 'main',
): Promise<SimplexUser> {
  const bridge = simplex();
  if (scope === 'main') {
    adoptLegacyProfile(marketAddress);
  }
  const key = profileKey(marketAddress, scope);
  const { users } = await bridge.init();

  const storedId = localStorage.getItem(key);
  if (storedId !== null) {
    const found = users.find(u => u.user.userId === Number(storedId));
    if (found === undefined) {
      throw new Error(
        `the messaging profile recorded for market ${marketAddress} (userId ${storedId}) ` +
          'no longer exists in the messaging database',
      );
    }
    return found.user;
  }

  // SimpleX display names are UNIQUE per core database, and this device holds
  // ONE database across all markets: a fixed name ("Market operator") works on
  // the first market and fails with userExists on the second. Append a short
  // random tag so every market gets its own profile -- the market -> userId
  // mapping above is what finds the profile again, never the name. Random
  // (not market-derived) so the name itself links to nothing.
  const tag = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const created = await bridge.createUser(`${displayName} ${tag}`);
  localStorage.setItem(key, String(created.userId));
  await bridge.start();
  return created;
}

/**
 * Creates (or fetches) the market's dispute-intake address: a business
 * address with auto-accept, so each buyer who connects lands in a fresh
 * group. The returned link is what gets published on-chain via
 * setContactAddress under the owner identity.
 *
 * Lives on the dedicated 'dispute' profile (see ProfileScope): the intake
 * must stay a business address without hijacking the operator's own
 * vendor/moderator contact address on the main profile.
 */
export async function ensureDisputeAddress(
  marketAddress: string,
  ownerDisplayName: string,
  welcomeMessage: string,
): Promise<string> {
  const user = await ensureMarketProfile(marketAddress, ownerDisplayName, 'dispute');
  return simplex().createAddress(user.userId, { business: true, welcomeMessage });
}

/**
 * Creates (or fetches) a personal contact address for a moderator/vendor
 * profile on a market -- what they publish on-chain so the dispute
 * automation can reach them.
 */
export async function ensurePersonalAddress(
  marketAddress: string,
  displayName: string,
): Promise<string> {
  const user = await ensureMarketProfile(marketAddress, displayName);
  return simplex().createAddress(user.userId, { business: false });
}

// ---------------------------------------------------------------------------
// In-app messaging (the Messages tab). The core's chat payloads are deeply
// nested and vary by item type; the extractors below are tolerant and skip
// anything that is not a renderable text item.
// ---------------------------------------------------------------------------

export interface Conversation {
  kind: 'direct' | 'group';
  id: number;
  name: string;
}

export interface ChatMessage {
  id: number;
  text: string;
  /** Sent by this profile (renders right-aligned). */
  mine: boolean;
  /** Group messages: the sender's display name ('' for direct / own). */
  author: string;
  /** Core timestamp (ISO string, '' when absent). */
  sentAt: string;
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Extracts the renderable messages from a getChat result (oldest first). */
export function parseChatItems(raw: unknown): ChatMessage[] {
  const container = rec(raw);
  const items = (rec(container.chat).chatItems ?? container.chatItems ?? []) as unknown[];
  const out: ChatMessage[] = [];
  for (const entry of items) {
    // getChat returns BARE ChatItems ({chatDir, meta, content}); event payloads
    // wrap them in {chatItem}. Accept both (live-verified via messages-smoke).
    const wrapped = rec(entry);
    const item = wrapped.chatDir !== undefined ? wrapped : rec(wrapped.chatItem);
    const dir = rec(item.chatDir);
    const meta = rec(item.meta);
    const content = rec(item.content);
    // Only actual messages (snd/rcvMsgContent): feature-toggle and other
    // system items carry meta.itemText but no msgContent, and would clutter
    // the top of every fresh conversation (live-verified via messages-smoke).
    const text = rec(content.msgContent).text;
    if (typeof text !== 'string' || text === '') {
      continue;
    }
    out.push({
      id: typeof meta.itemId === 'number' ? meta.itemId : out.length,
      text,
      mine: typeof dir.type === 'string' && dir.type.endsWith('Snd'),
      author:
        typeof rec(dir.groupMember).localDisplayName === 'string'
          ? (rec(dir.groupMember).localDisplayName as string)
          : '',
      sentAt: typeof meta.itemTs === 'string' ? meta.itemTs : '',
    });
  }
  out.sort((a, b) => a.id - b.id);
  return out;
}

const CONTACT_LINK_KEY_PREFIX = 'market.simplexLinkContact.v1.';

/**
 * Connects the market profile to a contact-address link (a vendor's sealed
 * listing contact, etc.), remembering the resulting contactId so a later call
 * for the same link reopens the conversation instead of creating a duplicate
 * contact. Returns the contactId when the conversation already exists, or
 * null when the connection was just initiated -- it appears in Messages once
 * the peer's auto-accept completes.
 */
export async function connectToContactAddress(
  marketAddress: string,
  displayName: string,
  link: string,
  incognito: boolean,
): Promise<number | null> {
  const profile = await ensureMarketProfile(marketAddress, displayName);
  const bridge = simplex();
  const key = `${CONTACT_LINK_KEY_PREFIX}${marketAddress}:${link}`;

  const stored = localStorage.getItem(key);
  if (stored !== null) {
    const contacts = await bridge.listContacts(profile.userId);
    const existing = contacts.find(c => c.contactId === Number(stored));
    if (existing !== undefined) {
      return existing.contactId;
    }
  }

  const unsubscribe = bridge.onEvent(event => {
    if (event.type !== 'contactConnected') {
      return;
    }
    const contact = (event as { contact?: { contactId?: unknown } }).contact;
    if (typeof contact?.contactId === 'number') {
      localStorage.setItem(key, String(contact.contactId));
    }
    unsubscribe();
  });
  try {
    await bridge.connect(profile.userId, link, incognito);
  } catch (err) {
    unsubscribe();
    throw err;
  }
  return null;
}
