# **Aztec Market System**

## **Technical Design and Implementation Plan**

## **1\. Overview**

The Aztec Market System is a privacy-preserving framework for creating and operating decentralized marketplaces on the Aztec Network.

The system is divided into two separate applications:

1. **Aztec Market Portal**  
2. **Aztec Market Creator**

The two applications share a common smart-contract protocol but serve different users and responsibilities.

The Aztec Market Portal is used by buyers, vendors, moderators, and marketplace administrators to access and interact with existing marketplaces.

The Aztec Market Creator is used by marketplace owners to configure, deploy, and publish new marketplaces.

The initial version will support only **self-arbitration**. Marketplace disputes will be handled by the marketplace superadmin or authorized moderators. External arbitration and arbitration-provider reputation systems are outside the scope of the first version.

The central architectural principle is:

**Public commitments, private order state, and controlled role-based disclosure.**

---

# **Part I: Shared Protocol**

## **2\. Shared Smart-Contract Architecture**

Both applications interact with a common set of Aztec smart contracts.

The initial protocol should be divided into the following logical components:

1. Marketplace registry  
2. Marketplace instance  
3. Role and permission management  
4. Vendor registration  
5. Listing management  
6. Order management  
7. Escrow  
8. Self-arbitration  
9. Fee distribution  
10. Private note and disclosure management

These components may be implemented as separate contracts or combined into a smaller number of contracts during the MVP.

The final contract boundaries should prioritize:

* security;  
* upgradeability strategy;  
* understandable permissions;  
* testability;  
* low deployment cost;  
* limited cross-contract complexity.

---

## **3\. Marketplace Registry**

The marketplace registry provides a canonical way to identify marketplaces created through the Aztec Market Creator.

Each marketplace receives an immutable marketplace identifier.

The registry may store:

* marketplace identifier;  
* marketplace contract address;  
* creator commitment or public administrator address;  
* marketplace metadata commitment;  
* creation timestamp or block reference;  
* marketplace status;  
* optional discovery information.

The registry should not require every marketplace to be publicly searchable.

A marketplace may be:

* publicly listed;  
* unlisted but accessible through its identifier;  
* privately shared through an identifier or invitation mechanism.

The registry should not store sensitive marketplace activity.

---

## **4\. Marketplace Identifier**

Every marketplace must have a unique and immutable identifier.

The identifier acts as:

* the marketplace address within the Portal;  
* a domain separator for marketplace-specific identities;  
* a namespace for vendors, listings, orders, and nullifiers;  
* a reference used by external indexing systems.

A conceptual identifier may be derived from:

`Hash(creator, deployment_nonce, configuration_commitment)`

The exact construction must ensure uniqueness and should not expose unnecessary private information.

---

## **5\. Marketplace Roles**

The protocol supports the following roles:

### **Superadmin**

The superadmin is the marketplace creator or the current holder of the marketplace's highest administrative authority.

The superadmin can:

* assign and remove moderators;  
* configure marketplace settings;  
* approve vendors;  
* configure vendor deposits;  
* manage marketplace metadata;  
* resolve disputes;  
* pause selected marketplace operations;  
* update protocol-supported marketplace policies.

### **Moderator**

Moderators are assigned by the superadmin.

Moderator permissions should be configurable rather than universal.

Possible moderator permissions include:

* approve vendors;  
* suspend vendors;  
* moderate listings;  
* view selected order information;  
* resolve disputes;  
* manage marketplace content.

A moderator should receive only the permissions required for their role.

### **Vendor**

A vendor can:

* create listings;  
* update listings;  
* deactivate listings;  
* receive private order information;  
* update fulfillment status;  
* respond to disputes;  
* receive escrowed payments after settlement.

Vendor authorization is specific to one marketplace.

### **Buyer**

A buyer can:

* view available listings;  
* place orders;  
* provide private delivery information;  
* view private order status;  
* confirm completion;  
* open disputes;  
* submit private dispute evidence;  
* receive refunds.

---

## **6\. Marketplace-Specific Identity**

The protocol should avoid using a single public wallet identity across all marketplaces.

A user should derive a separate pseudonymous identity for each marketplace.

A conceptual construction may resemble:

`marketplace_identity = Hash(user_secret, marketplace_id, identity_domain)`

This allows the same user to interact with multiple marketplaces without automatically creating a public link between those activities.

The user's wallet remains responsible for:

* signing transactions;  
* controlling assets;  
* paying fees;  
* receiving private notes;  
* proving ownership of marketplace roles.

The marketplace identity is used for marketplace-specific interaction.

---

## **7\. Role Proofs**

Users should be able to prove that they possess a role without revealing unnecessary information about their wallet or activity elsewhere.

Examples include proving:

* the user is an approved vendor;  
* the user is an authorized moderator;  
* the user owns a specific order;  
* the user is permitted to resolve a dispute;  
* the user has deposited the required vendor bond.

Nullifiers should be used to prevent duplicate or repeated actions where required.

A conceptual vendor registration nullifier may resemble:

`Hash(user_secret, marketplace_id, "vendor_registration")`

The final implementation must use Aztec-compatible primitives and should not rely on an unreviewed custom cryptographic design.

---

## **8\. Public and Private State**

The protocol should explicitly classify all information as either public or private.

### **Public State**

Public state should contain only information required for:

* protocol verification;  
* listing discovery;  
* payment settlement;  
* role authorization;  
* dispute execution;  
* marketplace indexing;  
* preventing duplicate actions.

Examples may include:

* marketplace identifier;  
* marketplace metadata commitment;  
* listing commitment;  
* listing price;  
* listing availability;  
* vendor authorization commitment;  
* escrow commitment;  
* order nullifier;  
* dispute flag;  
* settlement result;  
* marketplace fee configuration.

### **Private State**

Private state may include:

* buyer identity;  
* delivery address;  
* delivery instructions;  
* private order contents;  
* order quantity where privacy is desired;  
* fulfillment notes;  
* shipping information;  
* private order status;  
* dispute evidence;  
* private communication between buyer and vendor.

Sensitive state should be represented through private notes or encrypted data accessible only to authorized participants.

---

# **Part II: Aztec Market Portal**

## **9\. Purpose**

The Aztec Market Portal is the application used to access and interact with marketplaces that have already been deployed.

The Portal does not create or deploy marketplaces.

It serves four primary user groups:

1. Buyers  
2. Vendors  
3. Moderators  
4. Superadmins managing an existing marketplace

The Portal should provide one consistent interface while rendering each marketplace according to its own configuration.

---

## **10\. Portal Responsibilities**

The Aztec Market Portal is responsible for:

* opening a marketplace by identifier;  
* reading public marketplace configuration;  
* loading off-chain marketplace content;  
* displaying listings;  
* creating private orders;  
* managing buyer order history;  
* displaying vendor orders;  
* updating private order status;  
* interacting with escrow;  
* opening disputes;  
* submitting private dispute evidence;  
* allowing authorized administrators to resolve disputes;  
* displaying marketplace-specific themes and layouts.

The Portal should not contain deployment functionality.

---

## **11\. Marketplace Access**

A user accesses a marketplace by entering or opening its unique marketplace identifier.

The Portal performs the following actions:

1. Resolve the marketplace identifier through the registry.  
2. Load the marketplace contract address.  
3. Read the marketplace's protocol-critical configuration.  
4. Load the marketplace metadata file.  
5. Verify the metadata file against its on-chain hash or commitment.  
6. Render the marketplace.  
7. Connect the user's Aztec wallet.  
8. derive or load the user's marketplace-specific identity.

A marketplace may be opened through a URL structure such as:

`portal.example/market/{marketplace_identifier}`

The specific domain and routing scheme are implementation details.

---

## **12\. Marketplace Presentation**

The Portal may render marketplace-specific:

* name;  
* logo;  
* theme;  
* categories;  
* custom pages;  
* navigation structure;  
* layout;  
* marketplace policies;  
* vendor rules;  
* dispute rules;  
* service fees.

Large presentation data should be loaded from content-addressed storage.

The on-chain marketplace configuration should contain a hash or commitment to the active metadata file.

The Portal must verify the loaded metadata before displaying it.

---

## **13\. Listing Discovery**

The Portal should read or index publicly available listing information.

Each listing may expose:

* listing identifier;  
* title;  
* price;  
* availability;  
* category;  
* vendor marketplace identity or display name;  
* content hash;  
* optional inventory information;  
* listing status.

Large listing information should be stored off-chain.

This may include:

* full descriptions;  
* images;  
* media;  
* technical specifications;  
* shipping policies.

The Portal verifies off-chain listing content using the on-chain content hash.

---

## **14\. Buyer Order Flow**

The buyer order flow is:

1. Buyer opens a listing.  
2. Buyer selects quantity and options.  
3. Buyer enters delivery information.  
4. Buyer reviews the marketplace's fee and arbitration rules.  
5. Buyer creates a private order.  
6. Buyer transfers payment into escrow.  
7. Vendor receives a private order note.  
8. Buyer receives a private order receipt.  
9. Vendor updates fulfillment status.  
10. Buyer confirms completion or opens a dispute.  
11. Escrow releases or refunds funds according to the settlement result.

The buyer's delivery information should not be publicly visible.

---

## **15\. Private Order Notes**

An order should create private information for at least:

* the buyer;  
* the vendor.

Where administrative access is required, selected information may also be disclosed to:

* the superadmin;  
* authorized moderators.

The initial system should avoid giving all administrators permanent access to every private order.

Access should be scoped according to role and purpose.

For example:

* listing moderators do not need delivery information;  
* dispute moderators may need access only after a dispute is opened;  
* the superadmin may have dispute access without receiving routine order access.

---

## **16\. Order Status**

Order status should be private by default.

Possible statuses include:

* created;  
* accepted;  
* processing;  
* shipped;  
* delivered;  
* completed;  
* disputed;  
* refunded;  
* cancelled.

The buyer and vendor should be able to view the full status.

Public state should contain only the information needed to enforce settlement.

This may include:

* whether an order is active;  
* whether a dispute exists;  
* whether the escrow has been finalized;  
* whether a settlement nullifier has been consumed.

The protocol should not publicly publish detailed fulfillment progress unless a marketplace explicitly chooses to do so.

---

## **17\. Vendor Dashboard**

The Portal should provide vendors with a dashboard for:

* viewing their listings;  
* creating listings;  
* editing listing metadata;  
* updating prices;  
* changing availability;  
* reviewing incoming orders;  
* reading private delivery information;  
* updating order status;  
* responding to disputes;  
* tracking escrow settlement;  
* monitoring their vendor deposit.

The vendor dashboard should display only orders assigned to the active vendor identity.

---

## **18\. Buyer Dashboard**

The buyer dashboard should provide:

* active orders;  
* completed orders;  
* order status;  
* escrow state;  
* private delivery information;  
* vendor updates;  
* dispute controls;  
* refund status;  
* order receipts.

Order history should be derived from private notes and wallet-controlled data rather than from a globally public buyer address.

The application must account for note recovery and wallet synchronization.

---

## **19\. Administrator Dashboard**

The Portal should provide the superadmin and moderators with access based on their assigned permissions.

Possible administrative functions include:

* approve vendor registrations;  
* suspend vendors;  
* review listings;  
* deactivate prohibited listings;  
* view disputed orders;  
* review dispute evidence;  
* execute dispute decisions;  
* update marketplace metadata;  
* manage moderators.

Administrative actions should be logged through contract state or events where appropriate.

---

# **Part III: Aztec Market Creator**

## **20\. Purpose**

The Aztec Market Creator is a separate application used to configure, deploy, and publish marketplaces.

It is intended primarily for marketplace owners.

The Creator does not serve as the primary interface for buyers and vendors.

Its responsibilities end after deployment and configuration, although it may allow the owner to reopen and modify supported marketplace settings.

---

## **21\. Creator Responsibilities**

The Aztec Market Creator is responsible for:

* connecting the creator's wallet;  
* collecting marketplace configuration;  
* validating configuration;  
* estimating deployment costs;  
* preparing metadata;  
* uploading off-chain content;  
* deploying marketplace contracts;  
* initializing roles and permissions;  
* configuring vendor policies;  
* configuring service fees;  
* configuring self-arbitration;  
* registering the marketplace;  
* returning the marketplace identifier;  
* generating a Portal access link.

---

## **22\. Marketplace Creation Workflow**

The marketplace creation workflow is:

1. Creator connects an Aztec wallet.  
2. Creator enters marketplace identity information.  
3. Creator configures marketplace presentation.  
4. Creator configures vendor registration rules.  
5. Creator configures vendor deposit rules.  
6. Creator configures service fees.  
7. Creator configures moderator permissions.  
8. Creator reviews self-arbitration rules.  
9. Creator uploads logos and content.  
10. Creator approves the generated metadata.  
11. Creator reviews estimated deployment and initialization costs.  
12. Creator submits the deployment transaction.  
13. Contracts are deployed and initialized.  
14. Marketplace is registered.  
15. Creator receives the immutable marketplace identifier.  
16. Creator receives a Portal link for the new marketplace.

---

## **23\. Creator Configuration Categories**

The Creator should organize configuration into clear sections.

### **Basic Information**

* marketplace name;  
* short description;  
* logo;  
* marketplace visibility;  
* categories;  
* contact or support information.

### **Appearance**

* theme;  
* layout;  
* navigation;  
* custom pages;  
* branding metadata.

### **Vendor Policy**

* admin approval required;  
* open registration;  
* deposit required;  
* deposit amount;  
* vendor suspension rules;  
* vendor slashing conditions.

### **Fees**

* marketplace service fee;  
* fee recipient;  
* moderator or treasury allocation;  
* dispute fee;  
* cancellation fee where applicable.

### **Arbitration**

The initial Creator supports only self-arbitration.

The creator configures:

* whether only the superadmin can resolve disputes;  
* whether selected moderators can resolve disputes;  
* dispute submission window;  
* response deadline;  
* allowed settlement outcomes;  
* dispute fee;  
* vendor deposit slashing rules;  
* evidence access policy.

### **Privacy**

* public or unlisted marketplace;  
* optional public transaction statistics;  
* moderator disclosure rules;  
* dispute-specific disclosure rules;  
* listing visibility.

---

## **24\. Metadata Generation**

The Creator should generate a canonical metadata document.

The document may contain:

* marketplace name;  
* presentation settings;  
* custom pages;  
* logo reference;  
* category definitions;  
* layout configuration;  
* marketplace policies;  
* human-readable fee explanations;  
* vendor requirements;  
* dispute rules.

The metadata should be serialized deterministically.

The Creator should then:

1. upload the metadata to content-addressed storage;  
2. compute or retrieve the content hash;  
3. store the hash or commitment in the marketplace contract;  
4. return the metadata reference to the creator.

The Portal must verify the metadata against the contract commitment.

---

## **25\. Deployment Cost Controls**

The Creator should show estimated costs before deployment.

The estimate may include:

* marketplace contract deployment;  
* registry transaction;  
* initialization;  
* role setup;  
* metadata commitment;  
* optional on-chain content;  
* vendor deposit contract setup;  
* initial moderator assignments.

Large images and documents should not be stored directly on-chain by default.

The Creator may expose an advanced option for on-chain storage only where technically and economically reasonable.

---

## **26\. Publishing**

After successful deployment, the Creator should display:

* marketplace identifier;  
* marketplace contract address;  
* Portal URL;  
* metadata reference;  
* deployment transaction reference;  
* initial superadmin identity;  
* marketplace visibility status.

The creator should be advised to store the marketplace identifier and deployment information.

---

# **Part IV: Vendor Registration**

## **27\. Vendor Registration Models**

The initial system should support two vendor registration models.

### **Admin Approval**

A prospective vendor submits a registration request.

The superadmin or an authorized moderator approves or rejects the request.

Approval creates or updates a vendor authorization commitment.

### **Deposit-Based Registration**

A prospective vendor deposits the required amount.

The deposit proves economic eligibility to become a vendor.

The marketplace may require both:

* a deposit;  
* administrator approval.

The exact policy is configured during marketplace creation.

---

## **28\. Vendor Deposits**

Vendor deposits may be used to:

* discourage spam;  
* discourage repeated abusive identities;  
* create funds that may be slashed after a dispute;  
* create economic accountability.

The contract must define:

* deposit amount;  
* withdrawal conditions;  
* withdrawal delay;  
* active-order restrictions;  
* slashing conditions;  
* maximum slash amount;  
* authority allowed to slash;  
* dispute linkage.

The superadmin must not have unrestricted access to vendor deposits.

Any transfer or slashing must follow predefined contract rules.

---

# **Part V: Listings**

## **29\. Listing Creation**

An authorized vendor creates a listing through the Portal.

The listing creation process is:

1. Vendor prepares listing content.  
2. Portal uploads large content to content-addressed storage.  
3. Portal calculates or retrieves the content hash.  
4. Vendor submits listing-critical information to the contract.  
5. Contract verifies vendor authorization.  
6. Contract creates the listing record or commitment.  
7. Listing becomes available through the Portal.

---

## **30\. Listing State**

A listing may contain:

* marketplace identifier;  
* listing identifier;  
* vendor authorization reference;  
* price;  
* currency or asset type;  
* availability;  
* category;  
* inventory value or commitment;  
* content hash;  
* status.

Listing status may include:

* draft;  
* active;  
* paused;  
* sold out;  
* suspended;  
* removed.

Only active listings should be purchasable.

---

# **Part VI: Escrow**

> **Implementation note (2026-07-26).** The requirements in this part are
> unchanged, but how they are met is worth knowing before reading on. Escrow is
> NOT pooled in the marketplace contract: each order's funds sit at their own
> `contracts/order-escrow` instance, at an address derived from a per-order
> secret, which nobody deploys and whose class is never published. Because such
> a contract can have no public functions, it cannot serialize against a
> competing transaction — so the five "must prevent" guarantees below are
> enforced by the MARKETPLACE, in public, which records a terminal order state;
> the escrow only pays out against a state already final. Settlement is
> therefore two transactions. See AD-9 in `docs/DECISIONS.md` for why a pooled
> escrow could not be made private per order.

## **31\. Escrow Requirements**

Escrow is mandatory for the initial marketplace order flow.

When an order is placed:

1. the buyer's payment enters escrow;  
2. the vendor cannot immediately withdraw the payment;  
3. settlement occurs after buyer confirmation, timeout, cancellation, or dispute resolution.

The escrow system must prevent:

* double withdrawal;  
* double refund;  
* settlement after cancellation;  
* settlement while a dispute is active;  
* unauthorized dispute resolution.

---

## **32\. Standard Settlement**

A standard settlement may occur when:

* the buyer confirms completion;  
* the buyer does not dispute before the configured timeout;  
* the vendor cancels before fulfillment;  
* the vendor does not accept the order before the deadline.

Possible outcomes include:

* full payment to vendor;  
* full refund to buyer;  
* protocol-defined cancellation refund;  
* partial fee retention where disclosed in advance.

---

## **33\. Timeout Rules**

Each marketplace must define timeout rules.

Possible timeouts include:

* vendor acceptance deadline;  
* fulfillment deadline;  
* buyer confirmation deadline;  
* dispute opening deadline;  
* administrator decision deadline.

Timeouts must be visible before a buyer places an order.

The contract should enforce timeout-dependent settlement wherever possible.

---

# **Part VII: Self-Arbitration**

## **34\. Scope**

The initial release supports self-arbitration only.

Disputes are resolved by:

* the marketplace superadmin;  
* authorized marketplace moderators.

No external arbitration provider is involved.

---

## **35\. Dispute Flow**

The dispute flow is:

1. Buyer or vendor opens a dispute.  
2. Escrow settlement is paused.  
3. Both parties receive a dispute notification.  
4. Buyer submits private evidence.  
5. Vendor submits private evidence.  
6. Authorized marketplace arbiters review the evidence.  
7. An authorized arbiter selects a permitted outcome.  
8. The contract executes the settlement.  
9. The dispute is finalized.  
10. Relevant deposits may be slashed if contract rules allow it.

---

## **36\. Dispute Outcomes**

The initial system may support:

* release full payment to vendor;  
* refund full payment to buyer;  
* split payment;  
* refund buyer and slash vendor deposit;  
* release payment and reject the dispute.

A marketplace may enable only a subset of these outcomes.

Settlement ranges and slashing limits should be enforced by the contract.

---

## **37\. Private Evidence**

Dispute evidence should remain private.

Evidence may include:

* order details;  
* delivery information;  
* shipping records;  
* buyer statements;  
* vendor statements;  
* private messages;  
* photographs or documents;  
* fulfillment timestamps.

Large evidence files should be stored off-chain in encrypted form.

The contract or dispute record should store a commitment to the evidence.

Access should be limited to:

* the buyer;  
* the vendor;  
* the assigned superadmin or moderator.

---

## **38\. Arbitration Permissions**

Self-arbitration authority should be configurable.

Possible configurations include:

* superadmin only;  
* any authorized dispute moderator;  
* selected moderator assigned to the dispute;  
* multiple moderators with a threshold decision.

The MVP should begin with:

* superadmin resolution;  
* optional single authorized moderator resolution.

Multi-party arbitration can be added later.

---

## **39\. Administrator Risk**

Self-arbitration gives marketplace administrators significant authority.

The interface must clearly disclose:

* who controls dispute resolution;  
* whether moderators can resolve disputes;  
* whether vendor deposits can be slashed;  
* what settlement outcomes are possible;  
* whether decisions are appealable;  
* what evidence administrators can access.

The initial version does not require an appeal mechanism.

The lack of appeal should be disclosed before purchase.

---

# **Part VIII: Fee Model**

## **40\. Service Fee**

A marketplace may charge a service fee when an order is placed or settled.

The fee may be allocated to:

* the superadmin;  
* the marketplace treasury;  
* moderation and dispute operations;  
* protocol infrastructure.

The fee calculation must be deterministic and visible before order confirmation.

---

## **41\. Transaction Fees**

The system should explicitly define who pays each network transaction fee.

Possible responsibilities include:

* marketplace creator pays deployment costs;  
* vendor pays listing creation costs;  
* buyer pays order creation costs;  
* vendor pays fulfillment update costs;  
* dispute opener pays dispute creation costs;  
* marketplace treasury sponsors selected administrative actions.

The service fee should not be assumed to automatically pay future gas costs unless a fee-sponsorship mechanism is implemented.

---

# **Part IX: Application Architecture**

## **42\. Shared Code**

The Portal and Creator should share packages for:

* contract interfaces;  
* generated contract bindings;  
* marketplace metadata schemas;  
* identity derivation helpers;  
* cryptographic utilities;  
* wallet integration;  
* content hash verification;  
* validation;  
* common data types.

Shared code should be maintained in a separate package or workspace.

---

## **43\. Aztec Market Portal Components**

The Portal may contain:

### **Frontend**

Responsible for:

* marketplace rendering;  
* wallet connection;  
* buyer workflows;  
* vendor workflows;  
* administrative workflows;  
* private order display;  
* dispute display.

### **Portal Service Layer**

Responsible for:

* contract calls;  
* note queries;  
* metadata retrieval;  
* content verification;  
* indexing integration;  
* transaction construction.

### **Optional Indexer**

Responsible for indexing public information such as:

* marketplaces;  
* listings;  
* categories;  
* listing status;  
* public marketplace metadata.

The indexer must not become a required trusted party for settlement.

---

## **44\. Aztec Market Creator Components**

The Creator may contain:

### **Creator Frontend**

Responsible for:

* configuration forms;  
* validation;  
* previews;  
* fee estimates;  
* deployment progress;  
* publishing results.

### **Deployment Service Layer**

Responsible for:

* contract deployment;  
* registry registration;  
* initialization;  
* moderator setup;  
* metadata commitment;  
* wallet transaction construction.

### **Metadata Publisher**

Responsible for:

* deterministic serialization;  
* asset upload;  
* metadata upload;  
* content hash generation;  
* reference verification.

---

## **45\. Rust Responsibilities**

Rust may be used for:

* backend services;  
* metadata processing;  
* indexing;  
* content verification;  
* deployment tooling;  
* command-line utilities;  
* shared non-contract business logic;  
* integration testing utilities.

The smart-contract language and client requirements should determine which components must use Aztec-specific languages and SDKs.

The architecture should not require all user-facing code to be written in Rust if the supported Aztec client libraries are better suited to another environment.

---

## **46\. Smart-Contract Responsibilities**

Smart contracts should enforce:

* marketplace identity;  
* role authorization;  
* vendor registration;  
* vendor deposits;  
* listing validity;  
* order creation;  
* escrow;  
* settlement;  
* dispute state;  
* dispute authority;  
* fee distribution;  
* nullifier consumption;  
* state commitments.

Smart contracts should not store large presentation files.

---

## **47\. Client Responsibilities**

The client applications should handle:

* wallet interaction;  
* private note discovery;  
* encryption and decryption workflows;  
* metadata loading;  
* media loading;  
* local validation;  
* user interface state;  
* transaction construction;  
* content commitment verification.

The client must not be trusted to enforce payment or permission rules.

---

# **Part X: Repository Structure**

## **48\. Suggested Repository Layout**

A monorepo may initially be used:

aztec-market-system/  
├── apps/  
│   ├── market-portal/  
│   └── market-creator/  
├── contracts/  
│   ├── marketplace-registry/  
│   ├── marketplace/  
│   ├── escrow/  
│   └── test-contracts/  
├── packages/  
│   ├── contract-bindings/  
│   ├── market-metadata/  
│   ├── identity/  
│   ├── shared-types/  
│   └── test-utils/  
├── services/  
│   ├── public-indexer/  
│   └── metadata-publisher/  
├── tests/  
│   ├── unit/  
│   ├── integration/  
│   └── end-to-end/  
└── docs/

The Portal and Creator may later be moved into separate repositories if independent release cycles become necessary.

---

# **Part XI: Testing Strategy**

## **49\. Unit Tests**

Unit tests should cover:

* fee calculations;  
* role checks;  
* vendor deposit rules;  
* listing validation;  
* timeout calculations;  
* allowed dispute outcomes;  
* metadata serialization;  
* identity domain separation;  
* nullifier derivation helpers.

---

## **50\. Contract Tests**

Contract tests should cover:

* marketplace creation;  
* duplicate marketplace prevention;  
* moderator assignment;  
* unauthorized administrative actions;  
* vendor registration;  
* duplicate vendor registration;  
* vendor deposit withdrawal;  
* vendor deposit slashing;  
* listing creation;  
* unauthorized listing updates;  
* order creation;  
* escrow funding;  
* buyer confirmation;  
* timeout settlement;  
* dispute opening;  
* unauthorized dispute resolution;  
* refund;  
* vendor payment;  
* double-settlement prevention.

---

## **51\. Privacy Tests**

Privacy tests should verify that:

* buyer delivery information is not public;  
* private order contents are visible only to permitted users;  
* marketplace identities are not trivially linked across markets;  
* public order records do not reveal buyer wallet identity;  
* listing activity does not expose private order details;  
* dispute evidence is unavailable to unrelated moderators;  
* settled orders cannot be replayed;  
* private notes are recoverable by intended recipients.

---

## **52\. End-to-End Tests**

The primary end-to-end flow should be:

1. Create a marketplace through the Creator.  
2. Open it through the Portal.  
3. Register a vendor.  
4. Create a listing.  
5. Place a private order.  
6. Fund escrow.  
7. Update fulfillment status.  
8. Confirm completion.  
9. Release payment.

The dispute flow should be:

1. Create and fund an order.  
2. Open a dispute.  
3. Submit buyer evidence.  
4. Submit vendor evidence.  
5. Resolve through the superadmin.  
6. Execute refund or payment.  
7. Verify escrow cannot settle twice.

These tests should initially run against a local Aztec development environment.

---

# **Part XII: Implementation Milestones**

## **53\. Milestone 1: Protocol Foundation**

Deliverables:

* repository setup;  
* shared type definitions;  
* marketplace registry prototype;  
* marketplace identifier generation;  
* superadmin role;  
* moderator role;  
* local Aztec testing environment;  
* initial contract test suite.

Success criteria:

* a marketplace can be created locally;  
* it receives a unique identifier;  
* unauthorized users cannot modify its configuration.

---

## **54\. Milestone 2: Aztec Market Creator MVP**

Deliverables:

* Creator configuration form;  
* marketplace metadata schema;  
* deterministic metadata generation;  
* metadata upload;  
* deployment workflow;  
* marketplace registry integration;  
* deployment result page;  
* Portal link generation.

Success criteria:

* a user can configure and deploy a marketplace locally;  
* the marketplace can be resolved by its identifier;  
* its metadata can be verified against its on-chain commitment.

---

## **55\. Milestone 3: Portal Marketplace Viewing**

Deliverables:

* marketplace identifier routing;  
* registry resolution;  
* metadata loading;  
* metadata verification;  
* themed marketplace rendering;  
* listing index;  
* listing detail page.

Success criteria:

* the Portal can open a deployed marketplace;  
* the Portal rejects metadata that does not match the on-chain commitment;  
* active listings can be viewed.

---

## **56\. Milestone 4: Vendor System**

Deliverables:

* vendor registration;  
* admin approval;  
* optional deposit;  
* vendor dashboard;  
* listing creation;  
* listing updates;  
* listing suspension;  
* vendor authorization tests.

Success criteria:

* only authorized vendors can create listings;  
* duplicate registration is prevented;  
* vendor deposits follow configured rules.

---

## **57\. Milestone 5: Private Orders and Escrow**

Deliverables:

* buyer marketplace identity;  
* private order notes;  
* private delivery information;  
* escrow funding;  
* vendor order dashboard;  
* buyer order dashboard;  
* private status updates;  
* buyer confirmation;  
* timeout settlement.

Success criteria:

* a buyer can place an order without publicly exposing delivery information;  
* a vendor can read assigned order data;  
* escrow cannot be withdrawn twice;  
* unauthorized users cannot read the order.

---

## **58\. Milestone 6: Self-Arbitration**

Deliverables:

* dispute creation;  
* escrow pause;  
* private buyer evidence;  
* private vendor evidence;  
* superadmin resolution;  
* optional moderator resolution;  
* refund;  
* vendor payment;  
* split settlement;  
* vendor deposit slashing where configured.

Success criteria:

* only authorized administrators can resolve disputes;  
* dispute evidence remains private;  
* the selected settlement is enforced;  
* finalized disputes cannot be replayed.

---

## **59\. Milestone 7: Security and Hardening**

Deliverables:

* permission audit;  
* privacy review;  
* metadata leakage review;  
* denial-of-service review;  
* escrow invariant tests;  
* deposit invariant tests;  
* malformed metadata handling;  
* wallet recovery testing;  
* testnet deployment.

Success criteria:

* critical contract invariants are covered by automated tests;  
* privacy assumptions are documented;  
* the full flow operates on an Aztec test network.

---

# **Part XIII: Deferred Features**

## **60\. Features Excluded from the Initial Release**

The following features should be deferred:

* external arbitration;  
* arbiter marketplaces;  
* arbiter reputation;  
* arbitration appeals;  
* cross-market vendor reputation;  
* cross-market buyer reputation;  
* decentralized governance;  
* multi-signature arbitration;  
* advanced private inventory;  
* marketplace token issuance;  
* auction listings;  
* subscription payments;  
* multiple settlement assets;  
* fully on-chain images;  
* advanced page builders;  
* public marketplace ranking.

These features should be considered only after the basic private order, escrow, and self-arbitration system has been validated.

---

# **Part XIV: Initial Product Boundary**

## **61\. Aztec Market Portal**

The Portal is responsible for:

* viewing existing markets;  
* browsing listings;  
* buying products;  
* managing private orders;  
* managing vendor listings;  
* updating fulfillment;  
* managing escrow interactions;  
* opening and resolving disputes;  
* administering existing markets.

It does not deploy new marketplaces.

---

## **62\. Aztec Market Creator**

The Creator is responsible for:

* configuring new marketplaces;  
* generating marketplace metadata;  
* setting roles and policies;  
* configuring vendor rules;  
* configuring self-arbitration;  
* estimating deployment costs;  
* deploying marketplaces;  
* registering marketplaces;  
* publishing marketplace identifiers.

It is not the primary buyer or vendor interface.

---

## **63\. Final Scope Statement**

The first version of the Aztec Market System consists of two separate applications built on one shared protocol.

**Aztec Market Creator** creates, configures, deploys, and publishes marketplaces.

**Aztec Market Portal** allows users to access, operate, and administer deployed marketplaces.

The first version supports:

* marketplace-specific identities;  
* configurable vendor registration;  
* optional vendor deposits;  
* public listing commitments;  
* private buyer information;  
* private order status;  
* escrow;  
* marketplace service fees;  
* role-based administrative access;  
* self-arbitration.

The first version does not support external arbiters.

The system should be considered successful when a marketplace owner can deploy a market through the Creator and buyers and vendors can complete a private, escrow-protected transaction through the Portal without exposing unnecessary personal or order information publicly.

