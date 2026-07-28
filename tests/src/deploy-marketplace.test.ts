// Hidden-markets integration test, run against a local Aztec network
// (`aztec start --local-network`). AD-3: everything lives on-chain -- no
// publisher service exists anywhere in this suite. M4/AD-4: listings are
// created by pseudonymous vendors through private entries, and every listing
// carries a price commitment verified at resolution.
//
//   - end-to-end deploy: metadata sealed under the access secret and stored
//     in the Marketplace contract; registry keyed by the secret-derived
//     lookup key
//   - resolution from the access secret alone reads the chain, decrypts,
//     and verifies
//   - vendor lifecycle: register (pending), approve, list; deposit-gated
//     registration moves real tokens under an authwit
//   - a wrong secret, a squatted lookup key, foreign/corrupted on-chain
//     ciphertext, and a mismatched price commitment are all rejected, never
//     rendered
//
// AZTEC_NODE_URL overrides the default http://localhost:8080.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NO_FROM } from '@aztec/aztec.js/account';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec/stdlib/abi';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import { MarketplaceContract, MarketplaceRegistryContract } from '@market/contract-bindings';
import {
  createListing,
  deployMarketplace,
  getContactAddress,
  registerUser,
  registerVendor,
  resolveListings,
  resolveMarketplace,
  setContactAddress,
  setMarketplaceMetadata,
  setVendorStatus,
  updateListing,
} from '@market/deployment';
import {
  deriveMarketLookupKey,
  generateMarketAccessSecret,
} from '@market/identity';
import {
  bytesToFields,
  encryptMetadataBytes,
  sampleListingDocument,
  sampleMarketplaceMetadata,
  toBlobArray,
} from '@market/market-metadata';
import { CUSDC_TESTNET_ADDRESS } from '@market/deployment';
import { ListingStatus, VendorPolicy, VendorStatus } from '@market/shared-types';

import { memoryArweaveIO } from './arweave-io.js';

// Listing content is stored off-chain (Arweave); these tests exercise
// marketplace logic, so they use an in-memory store spread into every
// create/update/resolve listing call.
const io = memoryArweaveIO();

// cUSDC is the aztec-standards Token, and the marketplace calls ITS abi.
const tokenArtifact = loadContractArtifact(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../node_modules/@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json',
          import.meta.url,
        ),
      ),
      'utf-8',
    ),
  ) as Parameters<typeof loadContractArtifact>[0],
);

// Listing ids are 1-BASED (0 is the null for the per-category ordering links,
// see LISTING_FIRST_ID), so a market's first listing is 1.
const FIRST_LISTING_ID = 1n;

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const TX_WAIT = { timeout: 300 };

let node: AztecNode;
let wallet: EmbeddedWallet;
// Account model: the deployer/generic actor, and the owner's per-market
// account (the superadmin). Distinct accounts, not secrets on one wallet.
let from: AztecAddress;
let owner: AztecAddress;
let paymentMethod: SponsoredFeePaymentMethod;
let registryAddress: AztecAddress;

// Deploys a fresh account (paid by the sponsored FPC) and returns its address.
async function newAccount(): Promise<AztecAddress> {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await account.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod }, wait: TX_WAIT });
  return account.address;
}

beforeAll(async () => {
  // Wallet + PXE against the local network.
  node = createAztecNodeClient(NODE_URL);
  wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });

  // Fees are paid by the pre-deployed sponsored FPC.
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  // Deployer/generic actor + the owner's per-market account (superadmin).
  from = await newAccount();
  owner = await newAccount();

  // Global registry.
  const registryDeploy = MarketplaceRegistryContract.deploy(wallet);
  const { contract: registry } = await registryDeploy.send({
    from,
    fee: { paymentMethod },
    wait: TX_WAIT,
  });
  registryAddress = registry.address;
});

function deployWithSample() {
  return deployMarketplace({
    wallet,
    node,
    from,
    superadmin: owner,
    ownerUsername: 'owner',
    fee: { paymentMethod },
    registryAddress,
    metadata: sampleMarketplaceMetadata(),
    deploymentNonce: Fr.random().toBigInt(),
  });
}

describe('hidden markets: fully on-chain deployment and resolution', () => {
  const metadata = sampleMarketplaceMetadata();

  it('deploys, registers, and resolves from the access secret alone', async () => {
    const deployed = await deployWithSample();

    expect(deployed.accessSecret.isZero()).toBe(false);
    expect(deployed.marketplaceId.toBigInt()).not.toBe(0n);
    expect(
      deployed.lookupKey.equals(await deriveMarketLookupKey(deployed.accessSecret)),
    ).toBe(true);

    // Portal path: secret -> lookup key -> registry -> contract storage ->
    // decrypted + verified doc. Chain data only.
    const resolved = await resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: deployed.accessSecret,
        allowUnlistedPaymentAsset: true,
      });

    expect(resolved.marketplaceAddress.toString()).toBe(deployed.marketplaceAddress.toString());
    expect(resolved.marketplaceId.equals(deployed.marketplaceId)).toBe(true);
    expect(resolved.status).toBe(1);
    expect(resolved.metadata).toEqual(metadata);
  });

  it('the owner replaces the sealed metadata (the Customize path); a non-owner cannot', async () => {
    const deployed = await deployWithSample();

    // The owner reshapes presentation: name, theme, a custom page.
    const updated = sampleMarketplaceMetadata();
    updated.name = 'Renamed by Customize';
    updated.appearance.theme = 'dark';
    updated.appearance.layout = 'grid';
    // Page bodies live on Arweave; the doc stores title + storage id only.
    updated.pages = [{ title: 'About', storageId: 'A'.repeat(43) }];

    await setMarketplaceMetadata({
      wallet,
      node,
      from: owner,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
      accessSecret: deployed.accessSecret,
      metadata: updated,
    });

    // Resolution from the access secret now yields the replacement document.
    const resolved = await resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: deployed.accessSecret,
        allowUnlistedPaymentAsset: true,
      });
    expect(resolved.metadata).toEqual(updated);

    // A non-owner account must be rejected on-chain (from = the deployer, not
    // the superadmin owner).
    await expect(
      setMarketplaceMetadata({
        wallet,
        node,
        from,
        fee: { paymentMethod },
        marketplaceAddress: deployed.marketplaceAddress,
        accessSecret: deployed.accessSecret,
        metadata: sampleMarketplaceMetadata(),
      }),
    ).rejects.toThrow();

    // And the failed attempt changed nothing.
    const after = await resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: deployed.accessSecret,
        allowUnlistedPaymentAsset: true,
      });
    expect(after.metadata).toEqual(updated);
  });

  it('rejects resolution with an unknown access secret', async () => {
    await expect(
      resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: generateMarketAccessSecret(),
      }),
    ).rejects.toThrow('no market is registered under this access secret');
  });

  it('rejects a squatted lookup key (record not created with the secret)', async () => {
    // Deploy an honest market under secret s1.
    const honest = await deployWithSample();

    // A squatter registers the lookup key of a DIFFERENT secret s2, pointing
    // at the honest market's contract. The registry record looks fine -- but
    // the contract's metadata was sealed under s1, so opening with s2 fails.
    const squattedSecret = generateMarketAccessSecret();
    const squattedKey = await deriveMarketLookupKey(squattedSecret);
    const registry = await MarketplaceRegistryContract.at(registryAddress, wallet);
    await registry.methods
      .register(squattedKey, honest.marketplaceAddress)
      .send({ from, fee: { paymentMethod }, wait: TX_WAIT });

    await expect(
      resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: squattedSecret,
        allowUnlistedPaymentAsset: true,
      }),
    ).rejects.toThrow('wrong access secret or tampered blob');
  });

  it('refuses to open a market whose registered contract is not a genuine Marketplace', async () => {
    // A creator can register ANY address under a lookup key. Point one at a
    // contract of a DIFFERENT class (the registry itself is a convenient
    // non-Marketplace contract) -- resolution must reject it on the class-id
    // trust anchor before ever trusting or transacting with that bytecode.
    const secret = generateMarketAccessSecret();
    const key = await deriveMarketLookupKey(secret);
    const registry = await MarketplaceRegistryContract.at(registryAddress, wallet);
    await registry.methods
      .register(key, registryAddress)
      .send({ from, fee: { paymentMethod }, wait: TX_WAIT });

    await expect(
      resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: secret,
        allowUnlistedPaymentAsset: true,
      }),
    ).rejects.toThrow('not a recognized Marketplace');
  });

  it('refuses a market priced in a currency this client does not recognize', async () => {
    // The threat: nothing on-chain constrains which token a market names, so an
    // operator can point one at a token they wrote and control. Escrowing into
    // it is unrecoverable, and the class-id anchor does not help -- the contract
    // is a genuine Marketplace, it is the MONEY that is hostile.
    const deployed = await deployWithSample();

    await expect(
      resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: deployed.accessSecret,
        // Enforcement on: the sample market is priced in a placeholder asset.
      }),
    ).rejects.toThrow('unrecognized currency');
  });

  it('refuses a market whose storefront misreports its own currency', async () => {
    // The subtler version. The config is what place_order reads and what the
    // escrow terms are built from; the metadata copy is what the app builds its
    // token handle from. An operator who deploys legitimately and THEN rewrites
    // the metadata makes the two disagree, so a buyer would fund an escrow in a
    // token it was never denominated in.
    const deployed = await deployWithSample();
    const lying = sampleMarketplaceMetadata();
    lying.onchain.paymentAsset = CUSDC_TESTNET_ADDRESS;
    await setMarketplaceMetadata({
      wallet,
      node,
      from: owner,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
      accessSecret: deployed.accessSecret,
      metadata: lying,
    });

    // Allowlist bypassed, so this can only fail on the mirror check itself.
    await expect(
      resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: deployed.accessSecret,
        allowUnlistedPaymentAsset: true,
      }),
    ).rejects.toThrow('misreports its own currency');
  });

  it('runs the vendor lifecycle: pending registration cannot list until approved, then sealed listings resolve', async () => {
    const deployed = await deployWithSample();
    // The vendor is a dedicated per-market account that first claims a username.
    const vendor = await newAccount();
    const vendorSession = {
      wallet,
      node,
      from: vendor,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
    };
    await registerUser({ ...vendorSession, accessSecret: deployed.accessSecret, username: 'acme' });

    // The sample market uses the Approval policy: registration succeeds but
    // lands in Pending.
    const registered = await registerVendor(vendorSession);
    expect(registered.status).toBe(VendorStatus.Pending);
    expect(registered.vendorId.equals(vendor.toField())).toBe(true);

    const first = sampleListingDocument();
    const second = { ...sampleListingDocument(), title: 'Second item', options: [{ label: '', price: '42' }], shipping: [{ label: 'Standard', price: '0' }] };

    // Pending vendors are rejected in the public authorization check.
    await expect(
      createListing({
        ...io,
        ...vendorSession,
        listing: first,
        accessSecret: deployed.accessSecret,
      }),
    ).rejects.toThrow(/vendor is not active/);

    // Approve (from the superadmin owner account), then list.
    await setVendorStatus({
      wallet,
      node,
      from: owner,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
      vendor,
      status: VendorStatus.Active,
    });

    const createdFirst = await createListing({
      ...io,
      ...vendorSession,
      listing: first,
      accessSecret: deployed.accessSecret,
    });
    expect(createdFirst.listingId).toBe(FIRST_LISTING_ID);

    const createdSecond = await createListing({
      ...io,
      ...vendorSession,
      listing: second,
      accessSecret: deployed.accessSecret,
    });
    expect(createdSecond.listingId).toBe(FIRST_LISTING_ID + 1n);

    // Moderation: the superadmin pauses the second listing; its content must
    // stop being returned.
    const marketplace = await MarketplaceContract.at(deployed.marketplaceAddress, wallet);
    await marketplace.methods
      .set_listing_status(
        new Fr(FIRST_LISTING_ID + 1n),
        ListingStatus.Paused,
        owner,
        Fr.ZERO,
      )
      .send({ from: owner, fee: { paymentMethod }, wait: TX_WAIT });

    const listings = await resolveListings({
      ...io,
      wallet,
      node,
      from,
      marketplaceAddress: deployed.marketplaceAddress,
      accessSecret: deployed.accessSecret,
    });
    expect(listings).toHaveLength(2);
    expect(listings[0]?.status).toBe(ListingStatus.Active);
    expect(listings[0]?.listing).toEqual(first);
    // The creator is the vendor's per-market account address.
    expect(listings[0]?.creator.equals(vendor.toField())).toBe(true);
    expect(listings[0]?.creator.toBigInt()).not.toBe(from.toField().toBigInt());
    expect(listings[1]?.status).toBe(ListingStatus.Paused);
    expect(listings[1]?.listing).toBeNull();

    // A holder of a different secret can see that listings exist but can
    // never decrypt them.
    await expect(
      resolveListings({
        ...io,
        wallet,
        node,
        from,
        marketplaceAddress: deployed.marketplaceAddress,
        accessSecret: generateMarketAccessSecret(),
      }),
    ).rejects.toThrow('wrong access secret or tampered blob');

    // A price change through the proper path re-commits and still verifies.
    await updateListing({
      ...io,
      ...vendorSession,
      listingId: FIRST_LISTING_ID,
      listing: { ...first, options: [{ label: '', price: '77' }] },
      accessSecret: deployed.accessSecret,
    });
    const updated = await resolveListings({
      ...io,
      wallet,
      node,
      from,
      marketplaceAddress: deployed.marketplaceAddress,
      accessSecret: deployed.accessSecret,
    });
    expect(updated[0]?.listing?.options[0]?.price).toBe('77');
  }, 900_000);

  it('publishes and resolves an attested contact address (AD-6)', async () => {
    const deployed = await deployWithSample();
    const simplexAddress =
      'https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Ftest%40smp8.simplex.im%2Fdispute-intake-abc123';

    // Any account can publish -- the write lands under the caller's account
    // address (msg_sender), which IS the attestation.
    const published = await setContactAddress({
      wallet, node, from,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
      accessSecret: deployed.accessSecret,
      simplexAddress,
    });

    // Any link holder resolves it from the identity alone.
    await expect(
      getContactAddress({
        wallet, node, from,
        marketplaceAddress: deployed.marketplaceAddress,
        identity: published.identity,
        accessSecret: deployed.accessSecret,
      }),
    ).resolves.toBe(simplexAddress);

    // Rotation replaces the blob in place.
    const rotated = 'https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2Frotated';
    await setContactAddress({
      wallet, node, from,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
      accessSecret: deployed.accessSecret,
      simplexAddress: rotated,
    });
    await expect(
      getContactAddress({
        wallet, node, from,
        marketplaceAddress: deployed.marketplaceAddress,
        identity: published.identity,
        accessSecret: deployed.accessSecret,
      }),
    ).resolves.toBe(rotated);

    // An identity that never published resolves to null (a valid state)...
    await expect(
      getContactAddress({
        wallet, node, from,
        marketplaceAddress: deployed.marketplaceAddress,
        identity: Fr.random(),
        accessSecret: deployed.accessSecret,
      }),
    ).resolves.toBeNull();

    // ...while a published blob without the market link is undecodable.
    await expect(
      getContactAddress({
        wallet, node, from,
        marketplaceAddress: deployed.marketplaceAddress,
        identity: published.identity,
        accessSecret: Fr.random(),
      }),
    ).rejects.toThrow();
  }, 600_000);

  it('refuses to render a listing whose price commitment does not match (AD-4)', async () => {
    const deployed = await deployWithSample();
    const vendor = await newAccount();
    const vendorSession = {
      wallet,
      node,
      from: vendor,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
    };
    await registerUser({ ...vendorSession, accessSecret: deployed.accessSecret, username: 'pricebug' });
    await registerVendor(vendorSession);
    await setVendorStatus({
      wallet,
      node,
      from: owner,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
      vendor,
      status: VendorStatus.Active,
    });
    await createListing({
      ...io,
      ...vendorSession,
      listing: sampleListingDocument(),
      accessSecret: deployed.accessSecret,
    });

    // A buggy or malicious client bypasses the pipeline and re-commits to a
    // wrong price while keeping the same off-chain pointer. The contract cannot
    // know; the resolving client must refuse to render.
    const marketplace = await MarketplaceContract.at(deployed.marketplaceAddress, wallet);
    const record = (await marketplace.methods.get_listing(new Fr(FIRST_LISTING_ID)).simulate({ from: vendor }))
      .result as { pointer_0: bigint | Fr; pointer_1: bigint | Fr; category_tag: bigint | Fr };
    await marketplace.methods
      .update_listing_payload(
        new Fr(FIRST_LISTING_ID),
        [record.pointer_0, record.pointer_1],
        new Fr(0xbad0c0den),
        record.category_tag,
        // The acting account + authwit nonce are the #[authorize_once] pair
        // every vendor-facing entry point takes; self-sending permits nonce 0.
        vendor,
        Fr.ZERO,
      )
      .send({ from: vendor, fee: { paymentMethod }, wait: TX_WAIT });

    await expect(
      resolveListings({
      ...io,
        wallet,
        node,
        from,
        marketplaceAddress: deployed.marketplaceAddress,
        accessSecret: deployed.accessSecret,
      }),
    ).rejects.toThrow('price commitment does not match');
  }, 900_000);

  it('escrows a real token deposit during registration on a deposit-policy market', async () => {
    // A market whose vendor policy demands a 1000-unit deposit in a real
    // token. Deploy the token first so the config can reference it.
    //
    // The aztec-standards Token, not @aztec/noir-contracts.js/Token: the
    // marketplace calls the former's abi (transfer_to_public here), and against
    // the latter the deposit fails with an unknown function selector. It is
    // also what cUSDC actually is.
    const { contract: token } = await Contract.deploy(
      wallet,
      tokenArtifact,
      [
        'DepositToken0000000000000000000',
        'DEP0000000000000000000000000000',
        6,
        from,
        AztecAddress.ZERO,
      ],
      'constructor_with_minter',
    ).send({ from, fee: { paymentMethod }, wait: TX_WAIT });

    const depositMetadata = sampleMarketplaceMetadata();
    depositMetadata.onchain.paymentAsset = token.address.toString();
    depositMetadata.onchain.vendorPolicy = VendorPolicy.Deposit;
    depositMetadata.onchain.vendorDeposit = '1000';
    const deployed = await deployMarketplace({
      wallet,
      node,
      from,
      superadmin: owner,
      ownerUsername: 'owner',
      fee: { paymentMethod },
      registryAddress,
      metadata: depositMetadata,
      deploymentNonce: Fr.random().toBigInt(),
    });

    // The vendor's per-market account holds the deposit (funded privately here).
    const vendor = await newAccount();
    await token.methods
      .mint_to_private!(vendor, 5000n)
      .send({ from, fee: { paymentMethod }, wait: TX_WAIT });

    const vendorSession = {
      wallet,
      node,
      from: vendor,
      fee: { paymentMethod },
      marketplaceAddress: deployed.marketplaceAddress,
    };
    await registerUser({ ...vendorSession, accessSecret: deployed.accessSecret, username: 'deposco' });
    const registered = await registerVendor({
      ...vendorSession,
      deposit: {
        tokenAddress: token.address,
        amount: 1000n,
        // Deposits are custodied in the marketplace's PUBLIC balance, and this
        // must be the exact function the contract calls (main.nr:491) --
        // the authwit authorizes one specific call.
        createTransferInteraction: (owner_, to, amount, authwitNonce) =>
          Promise.resolve(
            token.methods.transfer_private_to_public!(owner_, to, amount, authwitNonce),
          ),
      },
    });
    // Deposit policy without approval: active immediately.
    expect(registered.status).toBe(VendorStatus.Active);

    const escrowed = (
      await token.methods.balance_of_public!(deployed.marketplaceAddress).simulate({ from })
    ).result;
    expect(escrowed).toBe(1000n);

    const created = await createListing({
      ...io,
      ...vendorSession,
      listing: sampleListingDocument(),
      accessSecret: deployed.accessSecret,
    });
    expect(created.listingId).toBe(FIRST_LISTING_ID);
  }, 900_000);

  it('resolves from a fresh wallet that deployed nothing (Portal scenario)', async () => {
    const deployed = await deployWithSample();

    // A brand-new PXE, like a Portal user's browser: it knows neither the
    // registry nor the marketplace, and its viewing account is never
    // deployed on-chain (viewing is read-only and costs nothing).
    const freshWallet = await EmbeddedWallet.create(node, {
      ephemeral: true,
      pxeConfig: { proverEnabled: false },
    });
    const viewer = await freshWallet.createSchnorrAccount(
      Fr.random(),
      Fr.random(),
      GrumpkinScalar.random(),
    );

    const resolved = await resolveMarketplace({
      wallet: freshWallet,
      node,
      from: viewer.address,
      registryAddress,
      accessSecret: deployed.accessSecret,
      allowUnlistedPaymentAsset: true,
    });
    expect(resolved.metadata).toEqual(metadata);

    const listings = await resolveListings({
      ...io,
      wallet: freshWallet,
      node,
      from: viewer.address,
      marketplaceAddress: resolved.marketplaceAddress,
      accessSecret: deployed.accessSecret,
    });
    expect(listings).toEqual([]);
  });

  it('rejects on-chain metadata that was not sealed under the market secret', async () => {
    const deployed = await deployWithSample();

    // The superadmin key is compromised (or malicious) and swaps the sealed
    // metadata for ciphertext under a different secret. Link holders must
    // get a verification failure, not attacker-controlled content.
    const foreign = await encryptMetadataBytes(
      new TextEncoder().encode('{"malicious":"replacement"}'),
      generateMarketAccessSecret(),
    );
    const marketplace = await MarketplaceContract.at(deployed.marketplaceAddress, wallet);
    await marketplace.methods
      .set_metadata(toBlobArray(bytesToFields(foreign)), BigInt(foreign.length), owner, Fr.ZERO)
      .send({ from: owner, fee: { paymentMethod }, wait: TX_WAIT });

    await expect(
      resolveMarketplace({
        wallet,
        node,
        from,
        registryAddress,
        accessSecret: deployed.accessSecret,
        allowUnlistedPaymentAsset: true,
      }),
    ).rejects.toThrow('wrong access secret or tampered blob');
  });
});
