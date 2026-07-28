export {
  assignModerator,
  getModeratorPermissions,
  getSuperadminIdentity,
  removeModerator,
  setListingStatusAsAdmin,
  setMarketplaceMetadata,
} from './admin.js';
export {
  computeConfigCommitment,
  toContractConfig,
  type ContractMarketConfig,
} from './config.js';
export {
  createMarketAccount,
  marketAccountAddress,
  type InitializerlessAccountFactory,
} from './accounts.js';
export { getContactAddress, setContactAddress } from './contacts.js';
export {
  deployMarketplace,
  resolveMarketplace,
  type DeployMarketplaceOptions,
  type DeployedMarketplace,
  type ResolvedMarketplace,
} from './deploy.js';
export {
  createListing,
  listCategoryListings,
  listCategoryPage,
  moveListing,
  listMarketListings,
  listVendorListings,
  priceTable,
  listingPriceCommitment,
  resolveListingContent,
  resolveListings,
  setListingStatusAsVendor,
  updateListing,
  type CategoryPage,
  type CreateListingOptions,
  type CreatedListing,
  type FetchPayload,
  type ListingIndexEntry,
  type ResolvedListing,
  type UpdateListingOptions,
  type UploadPayload,
} from './listings.js';
export { bridgeFeeJuice, claimFeeJuice, feeJuiceBalanceOf, type FeeJuiceClaim } from './fee-juice.js';
export {
  acceptOrder,
  cancelOrder,
  claimTimeoutSettlement,
  confirmCompletion,
  getDisputeCommitment,
  getOrderDisputeState,
  listListingFeedback,
  markOrderDisputed,
  ORDER_MEMO_MAX_BYTES,
  placeOrder,
  refundOrder,
  resolveDispute,
  resolveOrders,
  resolveOrderEscrowTerms,
  updateOrderStatus,
  type ListingFeedback,
  type OrderView,
  type PlacedOrder,
  type PlaceOrderOptions,
} from './orders.js';
// Per-order escrow: the money half of every settlement. Each of these follows a
// TERMINAL order state the marketplace already wrote -- see orderEscrow.ts.
export {
  claimOrderEscrow,
  claimOrderEscrowRefund,
  deriveBuyerAuth,
  deriveEscrowSalt,
  deriveOrderEscrow,
  getOrderEscrowBalance,
  orderStatesSlot,
  prepareEscrowFunding,
  registerOrderEscrow,
  releaseOrderEscrow,
  type EscrowTerms,
} from './orderEscrow.js';
export {
  CANONICAL_FPC_ADDRESS,
  CANONICAL_FPC_AZTEC_VERSION,
  CANONICAL_FPC_SALT,
  deriveBridgeSecret,
  DOM_SEP__FPC_BRIDGE_SECRET,
  fpcCreditOf,
  FPCFeePaymentMethod,
  PrivateFPCContract,
  registerPrivateFpc,
  type FpcBridgeClaim,
} from './private-fpc.js';
// NB: the L1-bridge funding (bridgeForFpcMint / fundFpcCredit) is intentionally
// NOT re-exported here -- it pulls viem + the @aztec/ethereum / l1-artifacts
// packages, which must stay off the wallet-open bundle. Import it lazily from
// the '@market/deployment/fpc-funding' subpath instead.
export { ensureContractRegistered, type RegistersContracts } from './register.js';
export {
  acceptedPaymentAssets,
  CUSDC_DECIMALS,
  CUSDC_MAINNET_ADDRESS,
  CUSDC_TESTNET_ADDRESS,
  CUSDC_NAME,
  CUSDC_SYMBOL,
  cusdcBalanceOf,
  deployMockCusdc,
  getCusdcTokenArtifact,
  mintCusdc,
  pullCusdc,
  transferCusdc,
} from './token.js';
export {
  executeDepositWithdrawal,
  getUsernameHash,
  getVendorRecord,
  isUsernameTaken,
  listVendors,
  registerUser,
  registerVendor,
  requestDepositWithdrawal,
  resolveUsername,
  setVendorStatus,
  verifyVendorUsername,
  type RegisteredVendor,
  type RegisterVendorOptions,
  type VendorRecord,
} from './vendors.js';
