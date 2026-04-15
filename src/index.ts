/**
 * @file index.ts
 * @description Vaultfire XMTP — Trust-Gated Agent Messaging
 *
 * Main package entry point. Re-exports all public APIs from sub-modules.
 *
 * @example
 * ```ts
 * import {
 *   createVaultfireAgent,
 *   verifyVaultfireTrust,
 *   calculateBondTier,
 *   configureVaultfireXMTP,
 * } from '@vaultfire/xmtp';
 * ```
 *
 * @module @vaultfire/xmtp
 */

// ---------------------------------------------------------------------------
// Core connector — trust-gated XMTP agent
// ---------------------------------------------------------------------------

export {
  // Agent factory
  createVaultfireAgent,
  configureVaultfireXMTP,

  // Trust verification
  verifyVaultfireTrust,
  verifyMultiChainTrust,
  isTrustedAgent,

  // Bond utilities
  calculateBondTier,
  clearTrustCache,
  TRUST_CACHE_TTL_MS,

  // Middleware factory
  createTrustMiddleware,

  // Group helpers
  createTrustedGroup,
  sendTrustedDm,

  // Message metadata
  encodeVaultfireMeta,
  decodeVaultfireMeta,

  // Utilities
  formatWei,

  // Contract address maps (read-only)
  RPC_URLS,
  IDENTITY_REGISTRY,
  BOND_CONTRACT,
} from './xmtp-connector.js';

// ---------------------------------------------------------------------------
// Server-side XMTP client (@xmtp/xmtp-js wrapper)
// ---------------------------------------------------------------------------

export {
  XMTPClient,
  getXMTPClient,
  resetXMTPClient,
} from './xmtp-client.js';

// ---------------------------------------------------------------------------
// Browser XMTP client
// ---------------------------------------------------------------------------

export {
  XMTPBrowserClient,
  PrivateKeyWalletProvider,
  getXMTPBrowserClient,
  initializeXMTPBrowser,
  getXMTPBrowserState,
  isXMTPBrowserConnected,
  isRealXMTPConnection,
  sendXMTPBrowserMessage,
  getXMTPBrowserMessages,
  onXMTPStatusChange,
  onXMTPMessage,
  createAgentRoom,
  createCollaborationRoom,
  disconnectXMTPBrowser,
} from './xmtp-browser.js';

// ---------------------------------------------------------------------------
// All shared types
// ---------------------------------------------------------------------------

export type {
  // Bond & Trust
  BondTier,
  VaultfireTrustProfile,
  MultiChainTrustProfile,

  // Agent Configuration
  VaultfireAgentConfig,

  // x402 Integration
  X402Integration,
  X402PaymentPayload,
  X402PaymentRecord,

  // Browser Client
  XMTPConnectionStatus,
  XMTPMessage,
  XMTPConversation,
  XMTPState,
  WalletProvider,

  // Server Client
  XmtpMessage,
  XmtpSendResult,
  XmtpConversation,
  XmtpMessageHandler,

  // Message Metadata
  VaultfireMessageMeta,

  // Chain Maps
  SupportedChain,
  ChainAddressMap,
  ChainRpcMap,
} from './types.js';

// ---------------------------------------------------------------------------
// AgentMiddleware type (re-exported from xmtp-connector for convenience)
// ---------------------------------------------------------------------------
export type { AgentMiddleware, AgentMessageHandler } from './xmtp-connector.js';
