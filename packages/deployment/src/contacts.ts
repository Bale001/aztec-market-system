// Attested contact addresses (AD-6): publish and resolve the sealed SimpleX
// address an identity can be reached at for disputes. The contract keys the
// blob by the caller's DERIVED identity (set_contact_address is private,
// identity-secret authed), so a successfully opened address is provably that
// pseudonym's -- the on-chain write is the attestation.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { MarketplaceContract } from '@market/contract-bindings';
import { type FieldLike, toFr } from '@market/identity';
import {
  CONTACT_MAX_FIELDS,
  bytesToFields,
  fieldsToBytes,
  openContactAddress,
  sealContactAddress,
} from '@market/market-metadata';

import { asBigInt, asFrArray } from './deploy.js';
import { sendActingAs } from './act.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';

interface ContactSessionOptions {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  /** Who sends and pays (defaults to `from`); see sendActingAs. */
  sender?: AztecAddress;
  marketplaceAddress: AztecAddress;
}

async function marketplaceAt(options: ContactSessionOptions) {
  await ensureContractRegistered(
    options.wallet,
    options.node,
    options.marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  return MarketplaceContract.at(options.marketplaceAddress, options.wallet);
}

/**
 * Publishes (or rotates) the caller's contact address under their derived
 * marketplace identity. Reads the blob back and requires it is byte-for-byte
 * what was written. Returns the identity so callers can hand it out.
 */
export async function setContactAddress(
  options: ContactSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    /** The market link secret; contact blobs are sealed under it. */
    accessSecret: Fr;
    /** The SimpleX contact/business address link to publish. */
    simplexAddress: string;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string; identity: Fr }> {
  const { from, accessSecret } = options;

  const sealed = await sealContactAddress(options.simplexAddress, accessSecret);
  const fields = bytesToFields(sealed);
  const blob = Array.from({ length: CONTACT_MAX_FIELDS }, (_, i) => fields[i] ?? Fr.ZERO);

  const marketplace = await marketplaceAt(options);
  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.set_contact_address(blob, sealed.length, account, nonce),
  );

  // Account model: the entry is keyed by the caller's account address.
  const identity = from.toField();

  // Read the blob back and require it is exactly ours: a silent failure or a
  // concurrent rotation must surface here, not as an unreachable contact.
  const stored = await readContactBlob(marketplace, from, identity);
  if (
    stored === null ||
    stored.length !== sealed.length ||
    !stored.every((b, i) => b === sealed[i])
  ) {
    throw new Error(
      'the contact address read back from the contract is not what was written -- ' +
        'a concurrent rotation, or a failed write',
    );
  }

  return { txHash, identity };
}

async function readContactBlob(
  marketplace: Awaited<ReturnType<typeof marketplaceAt>>,
  from: AztecAddress,
  identity: Fr,
): Promise<Uint8Array | null> {
  const { result } = await marketplace.methods.get_contact_address(identity).simulate({ from });
  const [rawFields, rawLen] = result as [unknown, unknown];
  const len = Number(asBigInt(rawLen, 'get_contact_address length'));
  if (len === 0) {
    return null;
  }
  return fieldsToBytes(asFrArray(rawFields, 'get_contact_address data'), len);
}

/**
 * Resolves the contact address an identity published on this market, or null
 * when it never published one (a valid state: contact publication is
 * optional). Throws when a blob exists but cannot be opened -- wrong access
 * secret, tampering, or a hostile writer.
 */
export async function getContactAddress(
  options: ContactSessionOptions & {
    /** The pseudonymous identity (moderator, vendor, or superadmin). */
    identity: FieldLike;
    accessSecret: Fr;
  },
): Promise<string | null> {
  const marketplace = await marketplaceAt(options);
  const sealed = await readContactBlob(
    marketplace,
    options.from,
    toFr(options.identity, 'identity'),
  );
  if (sealed === null) {
    return null;
  }
  return openContactAddress(sealed, options.accessSecret);
}
