/**
 * @file types.ts
 * @description Shared types and interfaces for the Vaultfire XMTP package.
 *
 * All public-facing types are defined here to ensure a single source of truth
 * and clean re-exports from the package root.
 *
 * @module vaultfire-xmtp/types
 */

// ---------------------------------------------------------------------------
// Bond & Trust Types
// ---------------------------------------------------------------------------

/**
 * On-chain bond tier for an agent, derived from the stakeAmount stored in
 * AIPartnershipBondsV2. Higher tiers unlock additional protocol features and
 * agent-to-agent trust escalations.
 *
 * | Tier     | Stake Range          |
 * |----------|----------------------|
 * | none     | 0                    |
 * | bronze   | > 0 and < 0.01 ETH  |
 * | silver   | >= 0.01 and < 0.1   |
 * | gold     | >= 0.1 and < 1.0    |
 * | platinum | >= 1.0 ETH          |
 */
export type BondTier = 'none' | 'bronze' | 'silver' | 'gold' | 'platinum';

/**
 * On-chain trust profile for a single Vaultfire agent on a single chain.
 * Populated by reading AIPartnershipBondsV2 and ERC8004IdentityRegistry.
 */
export interface VaultfireTrustProfile {
  /** Ethereum address of the agent */
  address: string;
  /** Whether the agent is registered in ERC8004IdentityRegistry */
  isRegistered: boolean;
  /** Whether the agent has at least one bond */
  hasBond: boolean;
  /** Stake amount in wei (string to preserve bigint precision) */
  bondAmount: string;
  /** Whether the highest-value bond is currently active */
  bondActive: boolean;
  /** Bond ID (first bond returned by getBondsByParticipant) */
  bondId: number;
  /** Bond tier derived from stakeAmount */
  bondTier: BondTier;
  /** Chain this profile was read from */
  chain: string;
  /** Human-readable trust summary */
  summary: string;
}

/**
 * Aggregated trust result across all supported chains.
 * The `bestProfile` is the one with the highest active bond.
 */
export interface MultiChainTrustProfile {
  /** Ethereum address */
  address: string;
  /** Profile from the chain with the highest active bond */
  bestProfile: VaultfireTrustProfile;
  /** Per-chain trust profiles */
  allChains: Record<string, VaultfireTrustProfile>;
  /** Name of the chain holding the best active bond */
  bestChain: string;
}

// ---------------------------------------------------------------------------
// Agent Configuration Types
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a Vaultfire trust-gated XMTP agent.
 */
export interface VaultfireAgentConfig {
  /**
   * Hex-encoded private key for the agent wallet.
   * With or without the `0x` prefix.
   * If omitted, the agent is created from environment variables
   * (WALLET_KEY / XMTP_ENV per @xmtp/agent-sdk conventions).
   */
  walletKey?: string;
  /** XMTP network environment (default: 'production') */
  env?: 'production' | 'dev' | 'local';
  /** Path for the local XMTP SQLite database (default: auto) */
  dbPath?: string;
  /** Chain to verify trust on (default: 'base') */
  chain?: string;
  /** Minimum bond amount in wei that qualifies as trusted (default: '0') */
  minBondWei?: string;
  /** Block messages from untrusted agents entirely (default: false) */
  blockUntrusted?: boolean;
  /** Optional x402 payment integration */
  x402?: X402Integration;
}

// ---------------------------------------------------------------------------
// x402 Payment Integration Interface
// ---------------------------------------------------------------------------

/**
 * Optional x402 payment protocol integration.
 *
 * If you use `vaultfire-x402` (or any compatible x402 implementation),
 * pass an instance here to enable /pay, /x402, /balance commands and
 * auto-pay handling. Without this, payment commands gracefully report
 * that x402 is not configured.
 *
 * @example
 * ```ts
 * import { createX402Client } from '@vaultfire/x402';
 * import { createVaultfireAgent, configureVaultfireXMTP } from '@vaultfire/xmtp';
 *
 * const x402 = createX402Client({ walletKey: process.env.WALLET_KEY });
 * configureVaultfireXMTP({ x402 });
 *
 * const agent = await createVaultfireAgent({ x402 });
 * ```
 */
export interface X402Integration {
  /**
   * Initiate an x402 USDC payment via EIP-3009 transferWithAuthorization.
   * @param recipient - Ethereum address or .vns name
   * @param amount - USDC amount as a decimal string (e.g., '1.50')
   * @param reason - Optional payment reason / memo
   * @returns Signed payment payload and an on-chain payment record
   */
  initiatePayment(
    recipient: string,
    amount: string,
    reason?: string,
  ): Promise<{ payload: X402PaymentPayload; record: X402PaymentRecord }>;

  /**
   * Verify that an x402 payment payload's EIP-712 signature is valid.
   * @returns `{ valid, recoveredAddress }` — plus optional error string
   */
  verifyPaymentSignature(payload: X402PaymentPayload): Promise<{
    valid: boolean;
    recoveredAddress: string;
    error?: string;
  }>;

  /**
   * Format a micro-USDC amount (integer string, 6 decimals) into a
   * human-readable decimal string (e.g., '1000000' → '1.000000').
   */
  formatUsdc(microAmount: string): string;

  /**
   * Fetch the USDC balance (in micro-USDC, 6 decimals) for an address on Base.
   */
  getUsdcBalance(address: string): Promise<string>;
}

/**
 * x402 payment payload in the EIP-3009 format accepted by compliant
 * HTTP 402 facilitators. Mirrors the structure produced by vaultfire-x402.
 */
export interface X402PaymentPayload {
  /** Always 1 for the current x402 spec */
  x402Version: number;
  accepted: {
    scheme: string;
    network: string;
    /** Amount in micro-USDC (6-decimal integer string) */
    amount: string;
    resource: string;
    description?: string;
  };
  payload: {
    /** EIP-3009 transferWithAuthorization signed data */
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/**
 * On-chain (or off-chain) payment record created after an x402 payment
 * is signed and/or settled.
 */
export interface X402PaymentRecord {
  /** Unique payment identifier */
  id: string;
  /** Recipient address (resolved from VNS if applicable) */
  payTo: string;
  /** Amount in micro-USDC */
  amount: string;
  /** Human-readable formatted amount */
  amountFormatted: string;
  /** Payment reason / memo */
  reason: string;
  /** Unix timestamp (milliseconds) */
  timestamp: number;
  /** Settlement status */
  status: 'pending' | 'settled' | 'failed';
  /** Optional VNS name resolved for the recipient */
  recipientVNS?: string;
}

// ---------------------------------------------------------------------------
// XMTP Browser Client Types
// ---------------------------------------------------------------------------

/** XMTP connection status for browser clients */
export type XMTPConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'
  | 'fallback';

/** A single XMTP message (browser client representation) */
export interface XMTPMessage {
  id: string;
  senderAddress: string;
  content: string;
  timestamp: number;
  isEncrypted: boolean;
  conversationTopic?: string;
}

/** A single XMTP conversation (browser client representation) */
export interface XMTPConversation {
  topic: string;
  peerAddress: string;
  createdAt: number;
  lastMessage?: XMTPMessage;
}

/** Full state snapshot for the browser XMTP client */
export interface XMTPState {
  status: XMTPConnectionStatus;
  address: string | null;
  conversationCount: number;
  messageCount: number;
  lastError: string | null;
  isRealXMTP: boolean;
}

// ---------------------------------------------------------------------------
// Server-side XMTP Client Types (from @xmtp/xmtp-js wrapper)
// ---------------------------------------------------------------------------

/** Server-side XMTP message representation */
export interface XmtpMessage {
  id: string;
  senderAddress: string;
  content: string;
  sent: Date;
}

/** Server-side XMTP send result */
export interface XmtpSendResult {
  success: boolean;
  messageId: string;
  to: string;
  error?: string;
}

/** Server-side XMTP conversation reference */
export interface XmtpConversation {
  peerAddress: string;
  createdAt: Date;
  topic: string;
}

/** Callback type for incoming XMTP messages */
export type XmtpMessageHandler = (message: XmtpMessage) => void;

// ---------------------------------------------------------------------------
// Vaultfire Message Metadata
// ---------------------------------------------------------------------------

/**
 * Structured metadata that can be embedded in XMTP messages as a compact
 * base64 footer to cryptographically prove Vaultfire identity.
 *
 * Encoded as `[VF:<base64json>]` appended to the message body.
 */
export interface VaultfireMessageMeta {
  protocol: 'vaultfire';
  version: '1.0';
  chain: string;
  bondContract: string;
  identityRegistry: string;
  senderAddress: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Wallet Provider Interface (for browser integration)
// ---------------------------------------------------------------------------

/**
 * Abstract wallet provider interface for the browser XMTP client.
 * Decouple from any specific wallet implementation.
 * Compatible with MetaMask, Coinbase Wallet, WalletConnect, and any
 * EIP-1193 provider wrapped to provide these methods.
 */
export interface WalletProvider {
  /** Returns the unlocked wallet address, or null if locked */
  getWalletAddress(): string | null;
  /**
   * Returns the session private key for XMTP key generation.
   * SECURITY: Never log or persist this value.
   */
  getSessionPrivateKey(): string | null;
  /** Returns true if the wallet is currently unlocked */
  isWalletUnlocked(): boolean;
}

// ---------------------------------------------------------------------------
// Contract Address Maps (exported constants shape)
// ---------------------------------------------------------------------------

/** Supported chain identifiers */
export type SupportedChain = 'base' | 'avalanche' | 'arbitrum' | 'polygon';

/** A record of contract addresses keyed by chain name */
export type ChainAddressMap = Record<SupportedChain, string>;

/** RPC URL map keyed by chain name */
export type ChainRpcMap = Record<SupportedChain, string>;
