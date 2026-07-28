// Canonical marketplace metadata document (spec sec.24).
//
// This is the off-chain half of a marketplace's definition: presentation and
// human-readable policies. Every market is hidden (architecture decision
// 2026-07-10): the document is published only as an AEAD-encrypted blob, so
// there is no visibility field -- nothing here is ever publicly readable. The `onchain` block mirrors the contract's
// MarketConfig for display only — the Portal must always treat contract state
// as the source of truth and this block as advisory.
//
// Validation throws on the first problem; there are no defaulted or coerced
// fields. Optional-but-absent values are explicit nulls so canonicalization
// is total over the document.

import { ListingPolicy, VendorPolicy } from '@market/shared-types';

import {
  ARWEAVE_TX_ID,
  DECIMAL,
  FIELD_HEX,
  requireExactKeys,
  requireInt,
  requireObject,
  requirePattern,
  requireString,
  requireStringArray,
  requireStringOrNull,
} from './validation.js';

// v2: custom page bodies moved off-chain to Arweave; pages carry
// {title, storageId} instead of {title, body}.
// v3: onchain mirror gained finalizationCollateral (buyer-side order
// collateral, refunded at confirmation-with-feedback).
// v4: on-chain disputes removed (handled off-chain over SimpleX); the mirror
// dropped disputeWindowSeconds and allowedOutcomes. policies.disputeRules
// stays -- it describes the operator's off-chain arbitration.
// v5: onchain mirror gained listingPolicy (OPEN vs APPROVAL: whether new
// listings require moderator approval before going live).
export const METADATA_SCHEMA_VERSION = 5;

export interface MarketplaceAppearance {
  theme: 'light' | 'dark' | 'system';
  /** #rrggbb, or null for the Portal default. */
  accentColor: string | null;
  layout: 'grid' | 'list';
}

export interface MarketplacePolicies {
  feeExplanation: string | null;
  vendorRequirements: string | null;
  disputeRules: string | null;
}

/**
 * An operator-authored content page, rendered as a tab in the storefront
 * (e.g. "About", "Shipping", "Rules"). Only the tab title lives here (inside
 * the sealed on-chain metadata); the body is sealed under the access secret
 * with the page key domain (see page.ts) and stored on Arweave, referenced by
 * its storage id. The storage id itself needs no extra encryption: this whole
 * document is ciphertext on-chain, so only link holders ever see it.
 */
export interface MarketplacePage {
  /** Tab label (the only page content stored on-chain). */
  title: string;
  /** Arweave storage id of the sealed page body (43-char base64url). */
  storageId: string;
}

/** Human-readable mirror of the on-chain MarketConfig (display only). */
export interface OnchainConfigMirror {
  /** Field element as 0x-hex. */
  paymentAsset: string;
  /**
   * Marketplace fee in basis points. The fee is paid to the market's OWNER
   * (superadmin) -- the owner IS the treasury, so there is no separate
   * recipient to configure.
   */
  feeBps: number;
  vendorPolicy: VendorPolicy;
  /** u128 as decimal string. */
  vendorDeposit: string;
  orderTimeoutSeconds: number;
  /**
   * u128 base units as decimal string: extra escrow every order carries,
   * refunded to the buyer when they finalize (confirm + feedback), paid to
   * the vendor on a timeout claim. '0' disables the mechanism.
   */
  finalizationCollateral: string;
  /** OPEN (new listings go live) or APPROVAL (held pending moderation). */
  listingPolicy: ListingPolicy;
}

export interface MarketplaceMetadata {
  schemaVersion: typeof METADATA_SCHEMA_VERSION;
  name: string;
  shortDescription: string;
  /** Content-hash reference to an off-chain asset (Arweave), or null. */
  logoRef: string | null;
  categories: string[];
  contact: string | null;
  appearance: MarketplaceAppearance;
  policies: MarketplacePolicies;
  /** Operator-authored content pages shown as storefront tabs. */
  pages: MarketplacePage[];
  onchain: OnchainConfigMirror;
}

const ACCENT = /^#[0-9a-fA-F]{6}$/;

export function validateMarketplaceMetadata(value: unknown): MarketplaceMetadata {
  const doc = requireObject(value, 'metadata');

  requireExactKeys(doc, 'metadata', [
    'schemaVersion',
    'name',
    'shortDescription',
    'logoRef',
    'categories',
    'contact',
    'appearance',
    'policies',
    'pages',
    'onchain',
  ]);

  if (doc.schemaVersion !== METADATA_SCHEMA_VERSION) {
    throw new Error(
      `metadata.schemaVersion must be ${METADATA_SCHEMA_VERSION}, got ${String(doc.schemaVersion)}`,
    );
  }

  requireString(doc.name, 'metadata.name', { min: 1, max: 64 });
  requireString(doc.shortDescription, 'metadata.shortDescription', { min: 0, max: 512 });
  requireStringOrNull(doc.logoRef, 'metadata.logoRef', { min: 1, max: 128 });
  requireStringOrNull(doc.contact, 'metadata.contact', { min: 1, max: 256 });

  requireStringArray(doc.categories, 'metadata.categories', {
    maxEntries: 16,
    minLen: 1,
    maxLen: 32,
  });

  const appearance = requireObject(doc.appearance, 'metadata.appearance');
  requireExactKeys(appearance, 'metadata.appearance', ['theme', 'accentColor', 'layout']);
  if (!['light', 'dark', 'system'].includes(appearance.theme as string)) {
    throw new Error(`metadata.appearance.theme must be light|dark|system, got ${String(appearance.theme)}`);
  }
  if (appearance.accentColor !== null) {
    requireString(appearance.accentColor, 'metadata.appearance.accentColor', { min: 7, max: 7 });
    if (!ACCENT.test(appearance.accentColor as string)) {
      throw new Error('metadata.appearance.accentColor must be #rrggbb');
    }
  }
  if (appearance.layout !== 'grid' && appearance.layout !== 'list') {
    throw new Error(`metadata.appearance.layout must be grid|list, got ${String(appearance.layout)}`);
  }

  const policies = requireObject(doc.policies, 'metadata.policies');
  requireExactKeys(policies, 'metadata.policies', [
    'feeExplanation',
    'vendorRequirements',
    'disputeRules',
  ]);
  requireStringOrNull(policies.feeExplanation, 'metadata.policies.feeExplanation', { min: 1, max: 2000 });
  requireStringOrNull(policies.vendorRequirements, 'metadata.policies.vendorRequirements', { min: 1, max: 2000 });
  requireStringOrNull(policies.disputeRules, 'metadata.policies.disputeRules', { min: 1, max: 2000 });

  if (!Array.isArray(doc.pages)) {
    throw new Error('metadata.pages must be an array');
  }
  if (doc.pages.length > 8) {
    throw new Error('metadata.pages must have at most 8 entries');
  }
  doc.pages.forEach((entry, i) => {
    const page = requireObject(entry, `metadata.pages[${i}]`);
    requireExactKeys(page, `metadata.pages[${i}]`, ['title', 'storageId']);
    requireString(page.title, `metadata.pages[${i}].title`, { min: 1, max: 48 });
    requirePattern(
      page.storageId,
      `metadata.pages[${i}].storageId`,
      ARWEAVE_TX_ID,
      'Arweave storage id (43 base64url characters)',
    );
  });

  const onchain = requireObject(doc.onchain, 'metadata.onchain');
  requireExactKeys(onchain, 'metadata.onchain', [
    'paymentAsset',
    'feeBps',
    'vendorPolicy',
    'vendorDeposit',
    'orderTimeoutSeconds',
    'finalizationCollateral',
    'listingPolicy',
  ]);
  requirePattern(onchain.paymentAsset, 'metadata.onchain.paymentAsset', FIELD_HEX, '0x-hex field element');
  requirePattern(onchain.vendorDeposit, 'metadata.onchain.vendorDeposit', DECIMAL, 'decimal string');
  requirePattern(
    onchain.finalizationCollateral,
    'metadata.onchain.finalizationCollateral',
    DECIMAL,
    'decimal string',
  );
  requireInt(onchain.feeBps, 'metadata.onchain.feeBps', { min: 0, max: 10000 });
  requireInt(onchain.vendorPolicy, 'metadata.onchain.vendorPolicy', { min: 0, max: 3 });
  requireInt(onchain.orderTimeoutSeconds, 'metadata.onchain.orderTimeoutSeconds', { min: 1 });
  requireInt(onchain.listingPolicy, 'metadata.onchain.listingPolicy', { min: 0, max: 1 });

  // Cross-field rules, mirroring MarketConfig::assert_valid (Noir). Anything
  // rejected here would revert the constructor -- catch it in the wizard.
  if (BigInt(onchain.paymentAsset as string) === 0n) {
    throw new Error('metadata.onchain.paymentAsset must not be the zero address');
  }
  const policy = onchain.vendorPolicy as VendorPolicy;
  const requiresDeposit = policy === VendorPolicy.Deposit || policy === VendorPolicy.Both;
  if (requiresDeposit && BigInt(onchain.vendorDeposit as string) === 0n) {
    throw new Error(
      'metadata.onchain.vendorDeposit must be positive when the vendor policy requires a deposit',
    );
  }

  return doc as unknown as MarketplaceMetadata;
}
