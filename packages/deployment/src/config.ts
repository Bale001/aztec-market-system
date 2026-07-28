// Conversion between the metadata document's on-chain mirror and the
// contract's MarketConfig argument, plus the client-side config commitment.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import type { OnchainConfigMirror } from '@market/market-metadata';

/** Shape the generated Marketplace bindings expect for the config struct. */
export interface ContractMarketConfig {
  payment_asset: AztecAddress;
  fee_bps: number;
  vendor_policy: number;
  vendor_deposit: bigint;
  order_timeout: bigint;
  finalization_collateral: bigint;
  listing_policy: number;
}

export function toContractConfig(mirror: OnchainConfigMirror): ContractMarketConfig {
  return {
    payment_asset: AztecAddress.fromBigIntUnsafe(BigInt(mirror.paymentAsset)),
    fee_bps: mirror.feeBps,
    vendor_policy: mirror.vendorPolicy,
    vendor_deposit: BigInt(mirror.vendorDeposit),
    order_timeout: BigInt(mirror.orderTimeoutSeconds),
    finalization_collateral: BigInt(mirror.finalizationCollateral),
    listing_policy: mirror.listingPolicy,
  };
}

/**
 * config_commitment = poseidon2(MarketConfig.serialize())
 *
 * Field order mirrors the Noir struct's declaration order exactly
 * (contracts/marketplace/src/market_config.nr) — the derived Serialize impl
 * packs one field per struct member. The sandbox integration test asserts
 * this against the contract's own derivation via get_marketplace_id.
 */
export async function computeConfigCommitment(config: ContractMarketConfig): Promise<Fr> {
  return poseidon2Hash([
    config.payment_asset.toField(),
    new Fr(BigInt(config.fee_bps)),
    new Fr(BigInt(config.vendor_policy)),
    new Fr(config.vendor_deposit),
    new Fr(config.order_timeout),
    new Fr(config.finalization_collateral),
    new Fr(BigInt(config.listing_policy)),
  ]);
}
