// Per-market account creation (account-model migration).
//
// Composes the client-side HD derivation (@market/identity) with the wallet's
// initializerless-account factory: a user's per-market account is derived
// deterministically from their universal seed + the market address (+ index),
// created as an initializerless Aztec account (usable from a fresh address with
// NO deployment transaction), and recoverable on any device from the seed
// alone. Verified end-to-end in tests/src/private-fpc.test.ts.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import type { AccountManager } from '@aztec/aztec.js/wallet';
import { deriveMarketAccountKeys, type FieldLike } from '@market/identity';
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

/**
 * The subset of the embedded wallet this module needs: the initializerless
 * account factory. Kept structural so the deployment package does not depend on
 * @aztec/wallets directly.
 */
export interface InitializerlessAccountFactory {
  createSchnorrInitializerlessAccount(
    secret: Fr,
    salt: Fr,
    signingKey: GrumpkinScalar,
    alias?: string,
  ): Promise<AccountManager>;
}

/**
 * Derives and creates the user's per-market account at `index` on
 * `marketAddress` from their universal `seed`. Returns the AccountManager,
 * whose `.address` is immediately usable (no deploy tx). Calling again with the
 * same inputs reproduces the same account — this is how a device recovers its
 * per-market accounts from the seed.
 */
export async function createMarketAccount(
  wallet: InitializerlessAccountFactory,
  seed: FieldLike,
  marketAddress: FieldLike,
  index: number = 0,
): Promise<AccountManager> {
  const { secret, salt, signingKey } = await deriveMarketAccountKeys(seed, marketAddress, index);
  return wallet.createSchnorrInitializerlessAccount(secret, salt, signingKey);
}

/** The address a user's per-market account WILL have, without creating it. */
export async function marketAccountAddress(
  wallet: InitializerlessAccountFactory,
  seed: FieldLike,
  marketAddress: FieldLike,
  index: number = 0,
): Promise<AztecAddress> {
  const account = await createMarketAccount(wallet, seed, marketAddress, index);
  return account.address;
}
