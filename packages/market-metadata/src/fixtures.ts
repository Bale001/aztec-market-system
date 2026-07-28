// Sample documents for tests and local development.

import { ListingPolicy, VendorPolicy } from '@market/shared-types';

import { METADATA_SCHEMA_VERSION, type MarketplaceMetadata } from './schema.js';

export function sampleMarketplaceMetadata(): MarketplaceMetadata {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    name: 'Test Bazaar',
    shortDescription: 'A private marketplace for testing.',
    logoRef: null,
    categories: ['electronics', 'books'],
    contact: 'admin@test-bazaar.example',
    appearance: {
      theme: 'system',
      accentColor: '#3366ff',
      layout: 'grid',
    },
    policies: {
      feeExplanation: 'A 2.5% service fee applies to every settled order.',
      vendorRequirements: 'Vendors require admin approval.',
      disputeRules: 'Disputes are resolved by the marketplace superadmin.',
    },
    // Page bodies live on Arweave (schema v2); samples ship without pages so
    // no fixture implies a fetchable storage id.
    pages: [],
    onchain: {
      paymentAsset: '0xa55e7',
      feeBps: 250,
      vendorPolicy: VendorPolicy.Approval,
      vendorDeposit: '0',
      orderTimeoutSeconds: 604800,
      finalizationCollateral: '0',
      listingPolicy: ListingPolicy.Open,
    },
  };
}
