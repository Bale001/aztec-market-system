// Arweave end-to-end: a listing (with an inline image) is sealed, uploaded to
// a REAL Arweave gateway (arlocal), and only an encrypted pointer is stored on
// chain. Resolution decrypts the pointer, fetches the blob back from arlocal,
// and reconstructs the exact document -- image bytes included.
//
// Requires both a local Aztec network (:8080) and an arlocal (:1984). Set
// ARLOCAL_URL to override the gateway.

import { NO_FROM } from '@aztec/aztec.js/account';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import { makeArweave } from '@market/arweave-store';
import { MarketplaceRegistryContract } from '@market/contract-bindings';
import {
  createListing,
  deployMarketplace,
  listCategoryListings,
  listCategoryPage,
  listMarketListings,
  listVendorListings,
  registerUser,
  registerVendor,
  resolveListingContent,
  resolveListings,
  resolveMarketplace,
} from '@market/deployment';
import { deriveCategoryTag, generateMarketAccessSecret } from '@market/identity';
import {
  openPageBody,
  sampleListingDocument,
  sampleMarketplaceMetadata,
  sealPageBody,
} from '@market/market-metadata';
import { VendorPolicy } from '@market/shared-types';

import { arlocalArweaveIO } from './arweave-io.js';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const ARLOCAL_URL = process.env.ARLOCAL_URL ?? 'http://localhost:1984';
const TX_WAIT = { timeout: 300 };

// A tiny 1x1 PNG (67 bytes), base64 (no data-URL prefix).
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let node: AztecNode;
let wallet: EmbeddedWallet;
let operator: AztecAddress;
let vendor: AztecAddress;
let paymentMethod: SponsoredFeePaymentMethod;
let io: ReturnType<typeof arlocalArweaveIO>;

async function newAccount(): Promise<AztecAddress> {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await account.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod }, wait: TX_WAIT });
  return account.address;
}

function session(from: AztecAddress) {
  return { wallet, node, from, marketplaceAddress, fee: { paymentMethod } };
}

let marketplaceAddress: AztecAddress;
let registryAddress: AztecAddress;
let accessSecret: Fr;
// A custom page whose body lives on Arweave; only {title, storageId} goes
// into the sealed on-chain metadata.
const PAGE_BODY = 'Welcome to the test bazaar.\n\nWe ship worldwide.';
let pageStorageId: string;

beforeAll(async () => {
  node = createAztecNodeClient(NODE_URL);
  wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  operator = await newAccount();
  vendor = await newAccount();

  // Arweave storage wallet for the vendor, funded on arlocal by the IO helper.
  const arweave = makeArweave(ARLOCAL_URL);
  const jwk = await arweave.wallets.generate();
  const address = await arweave.wallets.jwkToAddress(jwk);
  io = arlocalArweaveIO(jwk, address, ARLOCAL_URL);

  const { contract: registry } = await MarketplaceRegistryContract.deploy(wallet).send({
    from: operator,
    fee: { paymentMethod },
    wait: TX_WAIT,
  });
  const metadata = sampleMarketplaceMetadata();
  metadata.onchain.vendorPolicy = VendorPolicy.Open;

  // The page body must be sealed under the access secret before deploy, so
  // bring our own secret instead of letting deployMarketplace generate one.
  accessSecret = generateMarketAccessSecret();
  pageStorageId = await io.uploadPayload(await sealPageBody(PAGE_BODY, accessSecret));
  metadata.pages = [{ title: 'About', storageId: pageStorageId }];

  const deployed = await deployMarketplace({
    wallet,
    node,
    from: operator,
    superadmin: operator,
    ownerUsername: 'owner',
    accessSecret,
    fee: { paymentMethod },
    registryAddress: registry.address,
    metadata,
    deploymentNonce: Fr.random().toBigInt(),
  });
  marketplaceAddress = deployed.marketplaceAddress;
  registryAddress = registry.address;
}, 600_000);

test('stores a listing with an image on Arweave and resolves it back', async () => {
  await registerUser({ ...session(vendor), accessSecret, username: 'photog' });
  await registerVendor({ ...session(vendor) });

  const listing = {
    ...sampleListingDocument(),
    title: 'Item with a photo',
    category: 'electronics',
    description: 'A'.repeat(2000), // bigger than the old ~3.9KB on-chain cap once sealed
    images: [{ mime: 'image/png', dataBase64: TINY_PNG }],
  };

  await createListing({
    ...io,
    ...session(vendor),
    listing,
    accessSecret,
  });
  // A second listing in a different category, to exercise the tag filter.
  await createListing({
    ...io,
    ...session(vendor),
    listing: { ...sampleListingDocument(), title: 'A book', category: 'books', options: [{ label: '', price: '5' }], shipping: [{ label: 'Standard', price: '0' }] },
    accessSecret,
  });

  const listings = await resolveListings({
    ...io,
    wallet,
    node,
    from: vendor,
    marketplaceAddress,
    accessSecret,
  });

  expect(listings).toHaveLength(2);
  const withPhoto = listings.find(l => l.listing?.title === 'Item with a photo');
  expect(withPhoto?.listing).toEqual(listing);
  // The image survived the Arweave round trip byte-for-byte.
  expect(withPhoto?.listing?.images[0]?.dataBase64).toBe(TINY_PNG);
}, 600_000);

test('the per-category on-chain index returns only that category', async () => {
  // The scalable path: read one category's entries via the on-chain index,
  // never the whole market.
  const electronicsTag = await deriveCategoryTag(accessSecret, 'electronics');
  const electronics = await listCategoryListings({ wallet, node, from: vendor, marketplaceAddress, categoryTag: electronicsTag });
  expect(electronics).toHaveLength(1);
  const doc = await resolveListingContent({ entry: electronics[0]!, accessSecret, fetchPayload: io.fetchPayload });
  expect(doc.title).toBe('Item with a photo');

  const booksTag = await deriveCategoryTag(accessSecret, 'books');
  const books = await listCategoryListings({ wallet, node, from: vendor, marketplaceAddress, categoryTag: booksTag });
  expect(books).toHaveLength(1);

  // The incremental page API (what the shop paginates with). Display order is a
  // linked list, so paging is CURSOR-based rather than by page number: the
  // first page holds the category's single entry and returns a null cursor,
  // meaning the category is exhausted.
  const page0 = await listCategoryPage({ wallet, node, from: vendor, marketplaceAddress, categoryTag: electronicsTag });
  expect(page0.entries.map(e => e.listingId)).toEqual(electronics.map(e => e.listingId));
  expect(page0.nextCursor).toBeNull();

  // A category no listing uses returns nothing.
  const foodTag = await deriveCategoryTag(accessSecret, 'food');
  const food = await listCategoryListings({ wallet, node, from: vendor, marketplaceAddress, categoryTag: foodTag });
  expect(food).toHaveLength(0);

  // The full index (test/audit path) still sees both.
  const all = await listMarketListings({ wallet, node, from: vendor, marketplaceAddress });
  expect(all).toHaveLength(2);

  // The per-vendor index: both listings share a creator, so their pseudonym's
  // bucket returns exactly the two of them (this powers the vendor tab, the
  // admin's per-vendor moderation, and the public vendor storefront).
  const byVendor = await listVendorListings({
    wallet, node, from: vendor, marketplaceAddress, vendorId: electronics[0]!.creator,
  });
  // Listing ids are 1-BASED (0 is the null for the ordering links).
  expect(byVendor.map(e => e.listingId).sort()).toEqual([1n, 2n]);
  const nobody = await listVendorListings({
    wallet, node, from: vendor, marketplaceAddress, vendorId: new Fr(0xdeadn),
  });
  expect(nobody).toHaveLength(0);
}, 600_000);

test('custom page bodies live on Arweave; the on-chain doc holds title + storage id only', async () => {
  // Resolving the market yields the page ref, not the body.
  const resolved = await resolveMarketplace({
    wallet, node, from: vendor, registryAddress, accessSecret,
    // This market is priced in the sample metadata's placeholder asset, which
    // no allowlist could contain. The allowlist is exercised in
    // deploy-marketplace.test.ts; here it is only in the way.
    allowUnlistedPaymentAsset: true,
  });
  expect(resolved.metadata.pages).toEqual([{ title: 'About', storageId: pageStorageId }]);

  // The body round-trips through Arweave for a link holder...
  const body = await openPageBody(await io.fetchPayload(pageStorageId), accessSecret);
  expect(body).toBe(PAGE_BODY);

  // ...but the blob is sealed: without the market link it stays unreadable.
  await expect(
    openPageBody(await io.fetchPayload(pageStorageId), Fr.random()),
  ).rejects.toThrow(/decryption failed|wrong access secret/);
}, 600_000);

test('a different secret cannot decrypt the pointer or fetch the listing', async () => {
  await expect(
    resolveListings({
      ...io,
      wallet,
      node,
      from: vendor,
      marketplaceAddress,
      accessSecret: Fr.random(),
    }),
  ).rejects.toThrow(/decryption failed|wrong access secret/);
}, 600_000);
