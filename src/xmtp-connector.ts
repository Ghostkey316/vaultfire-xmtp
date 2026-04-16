/**
 * @file xmtp-connector.ts
 * @description Vaultfire XMTP Connector — Trust-gated agent messaging
 *
 * Standalone integration of XMTP encrypted messaging with Vaultfire on-chain
 * trust verification. Agents register on Vaultfire (identity + bond),
 * communicate via XMTP, and receiving agents verify the sender's Vaultfire
 * bond before processing messages.
 *
 * Stack:
 *   - XMTP (@xmtp/agent-sdk v2.2.0+) — end-to-end encrypted messaging
 *   - Vaultfire (AIPartnershipBondsV2) — on-chain trust / accountability
 *   - x402 (optional) — micropayments via EIP-3009 USDC
 *
 * Trust Verification (3-step on-chain):
 *   1. getBondsByParticipantCount(address) → uint256
 *   2. getBondsByParticipant(address)      → uint256[]
 *   3. getBond(uint256)                    → Bond struct
 *
 * This file is 100% standalone — it has NO imports from the main Vaultfire
 * repository. Optional x402 integration is provided via the X402Integration
 * interface (see configureVaultfireXMTP).
 *
 * @module vaultfire-xmtp
 */

import type {
  AgentMiddleware,
  AgentMessageHandler,
  User,
} from '@xmtp/agent-sdk';

import type {
  BondTier,
  VaultfireTrustProfile,
  MultiChainTrustProfile,
  VaultfireAgentConfig,
  X402Integration,
  X402PaymentPayload,
  VaultfireMessageMeta,
} from './types.js';

// Re-export all public types
export type {
  BondTier,
  VaultfireTrustProfile,
  MultiChainTrustProfile,
  VaultfireAgentConfig,
  X402Integration,
  X402PaymentPayload,
  VaultfireMessageMeta,
};

// ---------------------------------------------------------------------------
// Contract constants (verified on BaseScan / SnowTrace / Arbiscan / PolygonScan)
// ---------------------------------------------------------------------------

/** JSON-RPC endpoints for supported chains */
export const RPC_URLS: Readonly<Record<string, string>> = {
  base: 'https://mainnet.base.org',
  avalanche: 'https://api.avax.network/ext/bc/C/rpc',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
} as const;

/** ERC8004IdentityRegistry — deployed addresses */
export const IDENTITY_REGISTRY: Readonly<Record<string, string>> = {
  base: '0x35978DB675576598F0781dA2133E94cdCf4858bC',
  avalanche: '0x57741F4116925341d8f7Eb3F381d98e07C73B4a3',
  arbitrum: '0x6298c62FDA57276DC60de9E716fbBAc23d06D5F1',
  polygon: '0x6298c62FDA57276DC60de9E716fbBAc23d06D5F1',
} as const;

/** AIPartnershipBondsV2 — deployed addresses */
export const BOND_CONTRACT: Readonly<Record<string, string>> = {
  base: '0xC574CF2a09B0B470933f0c6a3ef422e3fb25b4b4',
  avalanche: '0xea6B504827a746d781f867441364C7A732AA4b07',
  arbitrum: '0x0E777878C5b5248E1b52b09Ab5cdEb2eD6e7Da58',
  polygon: '0x0E777878C5b5248E1b52b09Ab5cdEb2eD6e7Da58',
} as const;

// ---------------------------------------------------------------------------
// ABI selectors (verified on-chain — do NOT modify)
// ---------------------------------------------------------------------------

/** getTotalAgents() → uint256 */
const GET_TOTAL_AGENTS_SELECTOR = '0x3731a16f';

/** getBondsByParticipantCount(address) → uint256 */
const GET_BONDS_BY_PARTICIPANT_COUNT_SELECTOR = '0x67ff6265';

/** getBondsByParticipant(address) → uint256[] */
const GET_BONDS_BY_PARTICIPANT_SELECTOR = '0xde4c4e4c';

/** getBond(uint256) → Bond struct */
const GET_BOND_SELECTOR = '0xd8fe7642';

/**
 * Bond struct field offsets (words of 32 bytes each):
 *   [0] tuple header (pointer)
 *   [1] id (uint256)
 *   [2] human address
 *   [3] aiAgent address
 *   [4] string data offset
 *   [5] stakeAmount (uint256)   ← BOND_STRUCT_STAKE_OFFSET
 *   [6] timestamp (uint256)
 *   [7] chain data
 *   [8] extra field
 *   [9] active (bool)           ← BOND_STRUCT_ACTIVE_OFFSET
 */
const BOND_STRUCT_STAKE_OFFSET = 5;
const BOND_STRUCT_ACTIVE_OFFSET = 9;

// ---------------------------------------------------------------------------
// Module-level x402 integration (optional, set via configureVaultfireXMTP)
// ---------------------------------------------------------------------------

let _x402: X402Integration | null = null;

/**
 * Configure the Vaultfire XMTP module with optional integrations.
 *
 * Call this once at application startup before creating agents.
 *
 * @example
 * ```ts
 * import { configureVaultfireXMTP } from '@vaultfire/xmtp';
 * import { createX402Client } from '@vaultfire/x402';
 *
 * configureVaultfireXMTP({
 *   x402: createX402Client({ walletKey: process.env.WALLET_KEY }),
 * });
 * ```
 */
export function configureVaultfireXMTP(options?: {
  x402?: X402Integration;
}): void {
  if (options?.x402) {
    _x402 = options.x402;
    console.log('[Vaultfire] x402 integration configured');
  }
}

// ---------------------------------------------------------------------------
// Bond tier calculation
// ---------------------------------------------------------------------------

/** Wei thresholds for each bond tier */
const TIER_THRESHOLDS = {
  silver: 10_000_000_000_000_000n,   // 0.01 ETH
  gold: 100_000_000_000_000_000n,    // 0.10 ETH
  platinum: 1_000_000_000_000_000_000n, // 1.00 ETH
} as const;

/**
 * Calculate the bond tier from a stakeAmount in wei.
 *
 * | Tier     | Stake Range           |
 * |----------|-----------------------|
 * | none     | 0                     |
 * | bronze   | > 0 and < 0.01 ETH   |
 * | silver   | >= 0.01 and < 0.1    |
 * | gold     | >= 0.1 and < 1.0     |
 * | platinum | >= 1.0 ETH           |
 *
 * @param stakeWei - Stake amount as a wei string or BigInt
 * @returns Bond tier identifier
 */
export function calculateBondTier(stakeWei: string | bigint): BondTier {
  const amount = typeof stakeWei === 'string' ? BigInt(stakeWei) : stakeWei;
  if (amount <= 0n) return 'none';
  if (amount < TIER_THRESHOLDS.silver) return 'bronze';
  if (amount < TIER_THRESHOLDS.gold) return 'silver';
  if (amount < TIER_THRESHOLDS.platinum) return 'gold';
  return 'platinum';
}

/** Emoji badge for a bond tier */
function tierBadge(tier: BondTier): string {
  switch (tier) {
    case 'platinum': return '💎';
    case 'gold':     return '🥇';
    case 'silver':   return '🥈';
    case 'bronze':   return '🥉';
    default:         return '⬜';
  }
}

// ---------------------------------------------------------------------------
// Trust cache (5-minute TTL)
// ---------------------------------------------------------------------------

/** Cache TTL: 5 minutes */
export const TRUST_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const trustCache = new Map<string, CacheEntry<VaultfireTrustProfile>>();
const multiChainCache = new Map<string, CacheEntry<MultiChainTrustProfile>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
): void {
  cache.set(key, { value, expiresAt: Date.now() + TRUST_CACHE_TTL_MS });
}

/**
 * Clear all trust verification caches.
 * Useful after staking/unstaking bonds or in test environments.
 */
export function clearTrustCache(): void {
  trustCache.clear();
  multiChainCache.clear();
}

// ---------------------------------------------------------------------------
// On-chain trust verification (pure fetch — zero ethers dependency)
// ---------------------------------------------------------------------------

/**
 * Verify an agent's Vaultfire trust profile by reading on-chain state.
 *
 * Uses the correct AIPartnershipBondsV2 3-step verification flow:
 *   1. `getBondsByParticipantCount(address)` — check if any bonds exist
 *   2. `getBondsByParticipant(address)`      — get the bond ID array
 *   3. `getBond(bondId)`                     — read stake and active flag
 *
 * Also calls `getTotalAgents()` on ERC8004IdentityRegistry as a liveness check.
 *
 * Results are cached for 5 minutes (TRUST_CACHE_TTL_MS).
 *
 * @param address - Ethereum address to verify (with or without 0x prefix)
 * @param chain   - Chain to query: 'base' | 'avalanche' | 'arbitrum' | 'polygon' (default: 'base')
 * @returns Trust profile including registration status, bond amount, tier
 */
export async function verifyVaultfireTrust(
  address: string,
  chain: string = 'base',
): Promise<VaultfireTrustProfile> {
  const cacheKey = `${chain}:${address.toLowerCase()}`;
  const cached = getCached(trustCache, cacheKey);
  if (cached) return cached;

  const rpc = RPC_URLS[chain] ?? (RPC_URLS['base'] as string);
  const identityAddr = IDENTITY_REGISTRY[chain] ?? (IDENTITY_REGISTRY['base'] as string);
  const bondAddr = BOND_CONTRACT[chain] ?? (BOND_CONTRACT['base'] as string);
  const paddedAddress = address.replace(/^0x/, '').toLowerCase().padStart(64, '0');

  // Step 0: Registry liveness check (getTotalAgents)
  let isRegistered = false;
  try {
    const regResult = await ethCall(rpc, identityAddr, GET_TOTAL_AGENTS_SELECTOR);
    isRegistered = regResult !== '0x' && regResult.length > 2;
  } catch {
    // Contract unreachable — proceed with bond check
  }

  // Steps 1–3: Bond verification
  let hasBond = false;
  let bondActive = false;
  let bondAmount = '0';
  let bondId = 0;

  try {
    // Step 1: Get bond count for this address
    const countCalldata =
      GET_BONDS_BY_PARTICIPANT_COUNT_SELECTOR + paddedAddress;
    const countResult = await ethCall(rpc, bondAddr, countCalldata);
    const bondCount =
      countResult && countResult.length > 2 ? BigInt(countResult) : 0n;

    if (bondCount > 0n) {
      // Step 2: Get bond ID array
      const bondsCalldata = GET_BONDS_BY_PARTICIPANT_SELECTOR + paddedAddress;
      const bondsResult = await ethCall(rpc, bondAddr, bondsCalldata);

      if (bondsResult && bondsResult.length > 2) {
        /**
         * ABI-encoded uint256[] layout:
         *   word 0: offset pointer (0x20)
         *   word 1: array length
         *   word 2+: array elements (bond IDs)
         * Each word is 64 hex characters (32 bytes).
         */
        const raw = bondsResult.slice(2); // remove 0x prefix
        const arrayLength = Number(BigInt('0x' + raw.slice(64, 128)));

        if (arrayLength > 0) {
          const firstBondId = BigInt('0x' + raw.slice(128, 192));
          bondId = Number(firstBondId);

          // Step 3: Read the Bond struct
          const bondIdPadded = firstBondId.toString(16).padStart(64, '0');
          const getBondCalldata = GET_BOND_SELECTOR + bondIdPadded;
          const bondResult = await ethCall(rpc, bondAddr, getBondCalldata);

          if (bondResult && bondResult.length > 2) {
            const bondRaw = bondResult.slice(2);
            /**
             * Bond struct field extraction:
             * Each word = 64 hex chars (32 bytes).
             * stakeAmount: word index BOND_STRUCT_STAKE_OFFSET
             * active:      word index BOND_STRUCT_ACTIVE_OFFSET
             */
            const stakeHex = bondRaw.slice(
              BOND_STRUCT_STAKE_OFFSET * 64,
              (BOND_STRUCT_STAKE_OFFSET + 1) * 64,
            );
            const activeHex = bondRaw.slice(
              BOND_STRUCT_ACTIVE_OFFSET * 64,
              (BOND_STRUCT_ACTIVE_OFFSET + 1) * 64,
            );

            if (stakeHex.length === 64) {
              bondAmount = BigInt('0x' + stakeHex).toString();
              hasBond = BigInt('0x' + stakeHex) > 0n;
            }
            if (activeHex.length === 64) {
              bondActive = BigInt('0x' + activeHex) === 1n;
            }

            // An active bond implies the agent is registered
            if (hasBond && bondActive) isRegistered = true;
          }
        }
      }
    }
  } catch (err) {
    if (process.env['NODE_ENV'] !== 'production') {
      console.warn(
        `[Vaultfire] Bond verification failed for ${address} on ${chain}:`,
        err,
      );
    }
  }

  const bondTier = calculateBondTier(bondAmount);

  const summary = hasBond && bondActive
    ? `${tierBadge(bondTier)} Trusted agent — active ${bondTier} bond of ${formatWei(bondAmount)} ETH on ${chain} (bond #${bondId})`
    : hasBond
      ? `Agent has bond #${bondId} (${formatWei(bondAmount)} ETH) but it is inactive`
      : isRegistered
        ? 'Registered agent — no bond staked'
        : 'Unknown agent — not registered on Vaultfire';

  const profile: VaultfireTrustProfile = {
    address,
    isRegistered,
    hasBond,
    bondAmount,
    bondActive,
    bondId,
    bondTier,
    chain,
    summary,
  };

  setCache(trustCache, cacheKey, profile);
  return profile;
}

// ---------------------------------------------------------------------------
// Multi-chain trust verification
// ---------------------------------------------------------------------------

/**
 * Verify trust across all supported chains and return the best result.
 *
 * Queries Base, Avalanche, Arbitrum, and Polygon in parallel. The "best" profile is
 * the one with the highest active bond amount. If no active bonds exist on
 * any chain, the first chain with any bond data is returned as the best.
 *
 * Results are cached for 5 minutes.
 *
 * @param address - Ethereum address to verify
 * @returns Aggregated multi-chain trust profile
 */
export async function verifyMultiChainTrust(
  address: string,
): Promise<MultiChainTrustProfile> {
  const cacheKey = `multi:${address.toLowerCase()}`;
  const cached = getCached(multiChainCache, cacheKey);
  if (cached) return cached;

  const chains = Object.keys(RPC_URLS) as string[];

  const results = await Promise.allSettled(
    chains.map((chain) => verifyVaultfireTrust(address, chain)),
  );

  const allChains: Record<string, VaultfireTrustProfile> = {};
  let bestProfile: VaultfireTrustProfile | null = null;
  let bestAmount = 0n;

  for (let i = 0; i < chains.length; i++) {
    const chain = chains[i] as string;
    const result = results[i];
    if (result && result.status === 'fulfilled') {
      const profile = result.value;
      allChains[chain] = profile;

      // Prefer active bonds with the highest stake
      if (profile.hasBond && profile.bondActive) {
        const amount = BigInt(profile.bondAmount);
        if (amount > bestAmount) {
          bestAmount = amount;
          bestProfile = profile;
        }
      }
    } else {
      // Chain query failed — create a degraded placeholder
      const reason =
        result && result.status === 'rejected' ? String(result.reason) : 'unknown';
      allChains[chain] = {
        address,
        isRegistered: false,
        hasBond: false,
        bondAmount: '0',
        bondActive: false,
        bondId: 0,
        bondTier: 'none',
        chain,
        summary: `Chain query failed: ${reason}`,
      };
    }
  }

  // If no active bond found, fall back to any chain with bond data
  if (!bestProfile) {
    bestProfile =
      Object.values(allChains).find((p) => p.hasBond) ??
      (allChains['base'] as VaultfireTrustProfile) ??
      {
        address,
        isRegistered: false,
        hasBond: false,
        bondAmount: '0',
        bondActive: false,
        bondId: 0,
        bondTier: 'none' as BondTier,
        chain: 'base',
        summary: 'No trust data found on any chain',
      };
  }

  const multiProfile: MultiChainTrustProfile = {
    address,
    bestProfile,
    allChains,
    bestChain: bestProfile.chain,
  };

  setCache(multiChainCache, cacheKey, multiProfile);
  return multiProfile;
}

/**
 * Quick boolean check: is this address a trusted Vaultfire agent?
 *
 * @param address    - Ethereum address to check
 * @param chain      - Chain to check (default: 'base')
 * @param minBond    - Minimum stake amount in wei (default: '0' — any bond)
 * @param multiChain - When `true`, checks all chains and returns `true` if
 *                     any chain has an active bond meeting the minimum
 * @returns `true` if the agent is trusted on the specified chain(s)
 */
export async function isTrustedAgent(
  address: string,
  chain: string = 'base',
  minBond: string = '0',
  multiChain: boolean = false,
): Promise<boolean> {
  if (multiChain) {
    const multi = await verifyMultiChainTrust(address);
    const best = multi.bestProfile;
    if (!best.hasBond || !best.bondActive) return false;
    return BigInt(best.bondAmount) >= BigInt(minBond);
  }

  const trust = await verifyVaultfireTrust(address, chain);
  if (!trust.hasBond || !trust.bondActive) return false;
  return BigInt(trust.bondAmount) >= BigInt(minBond);
}

// ---------------------------------------------------------------------------
// createVaultfireAgent — main entry point
// ---------------------------------------------------------------------------

/**
 * Create and configure a trust-gated Vaultfire XMTP agent.
 *
 * This function dynamically imports `@xmtp/agent-sdk` so the module is safe
 * to include in projects even when the SDK is not installed (it will throw
 * only at call time, not at import time).
 *
 * Features wired up automatically:
 *   - Trust-gate middleware (optional, set `blockUntrusted: true`)
 *   - Command router: /trust, /trust-all, /status, /bond, /contracts
 *   - Payment commands (if x402 is configured): /pay, /x402, /balance
 *   - Auto-pay handler for x402:pay: messages from trusted agents
 *   - Transaction reference handler (x402 signature verification)
 *   - Lifecycle logging in development
 *
 * @example
 * ```ts
 * import { createVaultfireAgent, configureVaultfireXMTP } from '@vaultfire/xmtp';
 *
 * // Optional: wire up x402 payments
 * // configureVaultfireXMTP({ x402: myX402Client });
 *
 * const agent = await createVaultfireAgent({
 *   walletKey: process.env.AGENT_PRIVATE_KEY,
 *   env: 'production',
 *   chain: 'base',
 *   blockUntrusted: true,
 * });
 *
 * // Add custom handlers
 * agent.on('text', async (ctx) => {
 *   const sender = await ctx.getSenderAddress();
 *   await ctx.conversation.sendText(`Hello, ${sender}! Powered by Vaultfire.`);
 * });
 *
 * await agent.start();
 * ```
 */
export async function createVaultfireAgent(config: VaultfireAgentConfig = {}) {
  const {
    Agent,
    createSigner,
    createUser,
    CommandRouter,
  } = await import('@xmtp/agent-sdk');

  const chain = config.chain ?? 'base';
  const minBondWei = config.minBondWei ?? '0';

  // Merge instance-level x402 config with module-level config
  const x402 = config.x402 ?? _x402;

  // ── Create the XMTP Agent ─────────────────────────────────────────────────

  let agent: InstanceType<typeof Agent>;

  if (config.walletKey) {
    const hexKey = config.walletKey.startsWith('0x')
      ? config.walletKey
      : `0x${config.walletKey}`;
    const user: User = createUser(hexKey as `0x${string}`);
    const signer = createSigner(user);
    agent = await Agent.create(signer, {
      env: config.env ?? 'production',
      dbPath: config.dbPath ?? null,
    });
  } else {
    agent = await Agent.createFromEnv({
      env: config.env ?? 'production',
      dbPath: config.dbPath ?? null,
    });
  }

  // ── Trust-gate middleware ─────────────────────────────────────────────────

  if (config.blockUntrusted) {
    const trustMiddleware: AgentMiddleware = async (ctx, next) => {
      const senderAddress = await ctx.getSenderAddress();
      if (!senderAddress) return; // cannot identify sender — block silently

      const trusted = await isTrustedAgent(senderAddress, chain, minBondWei);
      if (!trusted) {
        await ctx.conversation.sendText(
          '⚠️ Vaultfire Trust Gate: You must register and stake a bond at ' +
            'theloopbreaker.com before interacting with this agent.',
        );
        return; // do NOT call next() — message is blocked
      }

      await next();
    };

    agent.use(trustMiddleware);
  }

  // ── Built-in command router ───────────────────────────────────────────────

  const router = new CommandRouter();

  // /trust — check sender's trust status
  router.command('/trust', 'Check your Vaultfire trust status', async (ctx) => {
    const senderAddress = await ctx.getSenderAddress();
    if (!senderAddress) {
      await ctx.conversation.sendText('Could not determine your address.');
      return;
    }
    const trust = await verifyVaultfireTrust(senderAddress, chain);
    await ctx.conversation.sendMarkdown(
      `**Vaultfire Trust Report**\n\n` +
      `Address: \`${trust.address}\`\n` +
      `Registered: ${trust.isRegistered ? '✅' : '❌'}\n` +
      `Bond: ${trust.hasBond ? formatWei(trust.bondAmount) + ' ETH' : 'None'}\n` +
      `Bond ID: ${trust.bondId > 0 ? `#${trust.bondId}` : 'N/A'}\n` +
      `Active: ${trust.bondActive ? '✅' : '❌'}\n` +
      `Tier: ${tierBadge(trust.bondTier)} ${trust.bondTier.toUpperCase()}\n` +
      `Chain: ${trust.chain}\n\n` +
      `> ${trust.summary}`,
    );
  });

  // /trust-all — check trust across all chains
  router.command('/trust-all', 'Check trust across all chains', async (ctx) => {
    const senderAddress = await ctx.getSenderAddress();
    if (!senderAddress) {
      await ctx.conversation.sendText('Could not determine your address.');
      return;
    }
    const multi = await verifyMultiChainTrust(senderAddress);
    let report =
      `**Multi-Chain Trust Report**\n\n` +
      `Address: \`${multi.address}\`\n` +
      `Best Chain: **${multi.bestChain}**\n\n`;

    for (const [chainName, profile] of Object.entries(multi.allChains)) {
      const badge =
        profile.hasBond && profile.bondActive
          ? `${tierBadge(profile.bondTier)} Active`
          : profile.hasBond
            ? '⚠️ Inactive'
            : '❌ None';
      report += `**${chainName}**: ${badge}`;
      if (profile.hasBond) {
        report += ` — ${formatWei(profile.bondAmount)} ETH (bond #${profile.bondId})`;
      }
      report += '\n';
    }

    report += `\n> ${multi.bestProfile.summary}`;
    await ctx.conversation.sendMarkdown(report);
  });

  // /status — show this agent's own trust profile
  router.command('/status', "Show this agent's own trust profile", async (ctx) => {
    const agentAddress = agent.address;
    if (!agentAddress) {
      await ctx.conversation.sendText('Agent address not available.');
      return;
    }

    const multi = await verifyMultiChainTrust(agentAddress);
    const best = multi.bestProfile;

    let statusReport =
      `**Agent Status**\n\n` +
      `Agent Address: \`${agentAddress}\`\n` +
      `XMTP Env: ${config.env ?? 'production'}\n` +
      `Trust Gate: ${config.blockUntrusted ? 'Enabled' : 'Disabled'}\n` +
      `Min Bond: ${minBondWei === '0' ? 'Any' : formatWei(minBondWei) + ' ETH'}\n\n` +
      `**On-Chain Trust Profile**\n\n` +
      `Best Chain: **${multi.bestChain}**\n` +
      `Bond Tier: ${tierBadge(best.bondTier)} ${best.bondTier.toUpperCase()}\n` +
      `Bond Amount: ${best.hasBond ? formatWei(best.bondAmount) + ' ETH' : 'None'}\n` +
      `Bond Active: ${best.bondActive ? '✅' : '❌'}\n` +
      `Bond ID: ${best.bondId > 0 ? `#${best.bondId}` : 'N/A'}\n\n`;

    statusReport +=
      `**Per-Chain Status**\n\n` +
      `| Chain | Bond | Amount | Tier | Active |\n` +
      `|-------|------|--------|------|--------|\n`;

    for (const [chainName, profile] of Object.entries(multi.allChains)) {
      statusReport +=
        `| ${chainName} | ${profile.hasBond ? `#${profile.bondId}` : 'None'} | ` +
        `${profile.hasBond ? formatWei(profile.bondAmount) + ' ETH' : '—'} | ` +
        `${tierBadge(profile.bondTier)} ${profile.bondTier} | ` +
        `${profile.bondActive ? '✅' : '❌'} |\n`;
    }

    statusReport += `\n> ${best.summary}`;
    await ctx.conversation.sendMarkdown(statusReport);
  });

  // /bond — staking instructions
  router.command('/bond', 'Learn how to stake a Vaultfire bond', async (ctx) => {
    await ctx.conversation.sendMarkdown(
      '**Stake a Vaultfire Bond**\n\n' +
      'Visit [theloopbreaker.com](https://theloopbreaker.com) → Agent Hub → Launchpad\n\n' +
      '1. Create or import your agent wallet\n' +
      '2. Register your agent identity via ERC8004IdentityRegistry\n' +
      '3. Stake a bond on AIPartnershipBondsV2\n' +
      '4. Optionally claim a `.vns` identity name\n\n' +
      '**AIPartnershipBondsV2 Addresses**\n\n' +
      `| Chain | Address |\n` +
      `|-------|--------|\n` +
      `| Base | \`${BOND_CONTRACT['base']}\` |\n` +
      `| Avalanche | \`${BOND_CONTRACT['avalanche']}\` |\n` +
      `| Arbitrum | \`${BOND_CONTRACT['arbitrum']}\` |\n` +
      `| Polygon | \`${BOND_CONTRACT['polygon']}\` |\n\n` +
      '> Bond tiers: bronze (any), silver (0.01 ETH), gold (0.1 ETH), platinum (1.0 ETH)',
    );
  });

  // /contracts — show all contract addresses
  router.command('/contracts', 'Show Vaultfire contract addresses', async (ctx) => {
    await ctx.conversation.sendMarkdown(
      '**Vaultfire Contract Addresses**\n\n' +
      '| Contract | Base | Avalanche | Arbitrum | Polygon |\n' +
      '|---|---|---|---|---|\n' +
      `| ERC8004IdentityRegistry | \`${IDENTITY_REGISTRY['base']}\` | \`${IDENTITY_REGISTRY['avalanche']}\` | \`${IDENTITY_REGISTRY['arbitrum']}\` | \`${IDENTITY_REGISTRY['polygon']}\` |\n` +
      `| AIPartnershipBondsV2 | \`${BOND_CONTRACT['base']}\` | \`${BOND_CONTRACT['avalanche']}\` | \`${BOND_CONTRACT['arbitrum']}\` | \`${BOND_CONTRACT['polygon']}\` |\n\n` +
      '> Hub: [theloopbreaker.com](https://theloopbreaker.com)',
    );
  });

  // ── x402 Payment Commands ─────────────────────────────────────────────────

  // /pay — send a USDC payment
  router.command(
    '/pay',
    'Send a USDC payment via x402 — usage: /pay <address_or_vns> <amount> [reason]',
    async (ctx) => {
      if (!x402) {
        await ctx.conversation.sendMarkdown(
          '**x402 Not Configured**\n\n' +
          'To enable payments, configure x402 integration:\n\n' +
          '```ts\n' +
          "import { configureVaultfireXMTP } from '@vaultfire/xmtp';\n" +
          "import { createX402Client } from '@vaultfire/x402';\n\n" +
          'configureVaultfireXMTP({\n' +
          "  x402: createX402Client({ walletKey: process.env.WALLET_KEY }),\n" +
          '});\n' +
          '```',
        );
        return;
      }

      const rawContent = ctx.message.content as string | { text?: string };
      const text =
        (typeof rawContent === 'object' && rawContent !== null
          ? rawContent.text
          : rawContent) || '';
      const parts =
        typeof text === 'string'
          ? text.replace('/pay', '').trim().split(/\s+/)
          : [];
      const recipientInput = parts[0] ?? '';
      const amountUsdc = parts[1] ?? '';
      const reason = parts.slice(2).join(' ') || 'XMTP agent payment';

      if (!recipientInput || !amountUsdc) {
        await ctx.conversation.sendMarkdown(
          '**x402 Payment — Usage**\n\n' +
          '`/pay <address_or_vns_name> <amount_usdc> [reason]`\n\n' +
          'Examples:\n' +
          '- `/pay 0x1234...5678 1.50 API access fee`\n' +
          '- `/pay vaultfire-sentinel 2.00 Security audit`\n' +
          '- `/pay sentinel-7.vns 0.50 Task completion`\n\n' +
          'Accepts raw Ethereum addresses (0x...) or .vns names.\n' +
          'Sends USDC on Base via EIP-3009 transferWithAuthorization.',
        );
        return;
      }

      const isAddress = /^0x[a-fA-F0-9]{40}$/.test(recipientInput);
      const isVNS =
        /^[a-z0-9][a-z0-9-]*[a-z0-9](\.vns)?$/i.test(recipientInput) ||
        /^[a-z0-9]{1,2}(\.vns)?$/i.test(recipientInput);

      if (!isAddress && !isVNS) {
        await ctx.conversation.sendMarkdown(
          '**Invalid Recipient**\n\n' +
          'Must be a valid Ethereum address (`0x...`) or a .vns name.\n\n' +
          'Use `/pay` with no arguments to see examples.',
        );
        return;
      }

      const parsedAmount = parseFloat(amountUsdc);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        await ctx.conversation.sendText(
          'Invalid amount. Must be a positive number (e.g., 1.50).',
        );
        return;
      }

      try {
        const senderAddress = await ctx.getSenderAddress();
        if (senderAddress) {
          const balance = await x402.getUsdcBalance(senderAddress);
          const amountMicro = Math.floor(parsedAmount * 1_000_000);
          if (BigInt(balance) < BigInt(amountMicro)) {
            await ctx.conversation.sendMarkdown(
              `**Insufficient USDC Balance**\n\n` +
              `Required: ${amountUsdc} USDC\n` +
              `Available: ${x402.formatUsdc(balance)} USDC\n\n` +
              `Top up your USDC on Base to proceed.`,
            );
            return;
          }
        }

        const { record } = await x402.initiatePayment(
          recipientInput,
          amountUsdc,
          reason,
        );

        await ctx.conversation.sendMarkdown(
          `**x402 Payment Signed**\n\n` +
          `| Field | Value |\n` +
          `|-------|-------|\n` +
          `| To | \`${record.payTo}\` |\n` +
          `| Amount | ${amountUsdc} USDC |\n` +
          `| Network | Base (EIP-155:8453) |\n` +
          `| Scheme | exact (EIP-3009) |\n` +
          `| Status | Signed |\n` +
          `| Payment ID | \`${record.id}\` |\n\n` +
          (record.recipientVNS
            ? `> Resolved \`${recipientInput}\` → \`${record.payTo}\` via VNS\n`
            : '') +
          `> Submit to a facilitator or x402-enabled server to settle on-chain.`,
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        await ctx.conversation.sendMarkdown(
          `**x402 Payment Failed**\n\nError: ${errorMsg}\n\n` +
          `Ensure your wallet is unlocked and has sufficient USDC on Base.`,
        );
      }
    },
  );

  // /x402 — show payment protocol info
  router.command('/x402', 'Show x402 payment protocol info', async (ctx) => {
    if (!x402) {
      await ctx.conversation.sendText(
        'x402 integration not configured. See /pay for setup instructions.',
      );
      return;
    }

    await ctx.conversation.sendMarkdown(
      '**x402 Payment Protocol**\n\n' +
      '| Property | Value |\n' +
      '|----------|-------|\n' +
      '| Token | USDC (6 decimals) |\n' +
      '| Network | Base (Chain ID 8453) |\n' +
      '| Scheme | exact |\n' +
      '| Standard | EIP-3009 transferWithAuthorization |\n' +
      '| Signing | EIP-712 typed data |\n' +
      '| VNS | Enabled (pay by .vns name) |\n\n' +
      'Use `/pay <address_or_vns> <amount>` to send USDC.\n' +
      'Use `/balance` to check your USDC balance on Base.',
    );
  });

  // /balance — check USDC balance
  router.command('/balance', 'Check your USDC balance on Base', async (ctx) => {
    const senderAddress = await ctx.getSenderAddress();
    if (!senderAddress) {
      await ctx.conversation.sendText('Could not determine your address.');
      return;
    }

    if (!x402) {
      await ctx.conversation.sendText(
        'x402 integration not configured — cannot fetch balance.',
      );
      return;
    }

    try {
      const balance = await x402.getUsdcBalance(senderAddress);
      const formatted = x402.formatUsdc(balance);

      await ctx.conversation.sendMarkdown(
        `**USDC Balance (Base)**\n\n` +
        `Address: \`${senderAddress}\`\n` +
        `Balance: **${formatted} USDC**\n` +
        `Network: Base (Chain ID 8453)`,
      );
    } catch {
      await ctx.conversation.sendText(
        'Failed to fetch USDC balance. Try again later.',
      );
    }
  });

  agent.use(router.middleware());

  // ── Lifecycle logging ─────────────────────────────────────────────────────

  const isDev = process.env['NODE_ENV'] !== 'production';

  agent.on('start', () => {
    if (isDev) console.debug(`[Vaultfire] Agent online: ${agent.address}`);
  });

  agent.on('stop', () => {
    if (isDev) console.debug('[Vaultfire] Agent stopped');
  });

  agent.on('unhandledError', (error: unknown) => {
    if (isDev) console.error('[Vaultfire] Unhandled error:', error);
  });

  // ── Transaction reference handler (x402 payment verification) ────────────

  agent.on('transaction-reference', async (ctx) => {
    const txRef = ctx.message.content;
    let report = `**Transaction Reference Received**\n\n`;

    try {
      const refData =
        typeof txRef === 'string' ? (JSON.parse(txRef) as unknown) : txRef;

      if (
        x402 &&
        refData !== null &&
        typeof refData === 'object' &&
        'x402Version' in refData &&
        'payload' in refData &&
        typeof (refData as Record<string, unknown>)['payload'] === 'object' &&
        (refData as Record<string, unknown>)['payload'] !== null &&
        'signature' in ((refData as Record<string, unknown>)['payload'] as Record<string, unknown>)
      ) {
        const paymentPayload = refData as X402PaymentPayload;
        const verification = await x402.verifyPaymentSignature(paymentPayload);

        report +=
          `**x402 Payment Verification**\n\n` +
          `| Field | Value |\n` +
          `|-------|-------|\n` +
          `| Version | x402 v${paymentPayload.x402Version} |\n` +
          `| Scheme | ${paymentPayload.accepted.scheme} |\n` +
          `| Network | ${paymentPayload.accepted.network} |\n` +
          `| Amount | ${x402.formatUsdc(paymentPayload.accepted.amount)} USDC |\n` +
          `| From | \`${paymentPayload.payload.authorization.from}\` |\n` +
          `| To | \`${paymentPayload.payload.authorization.to}\` |\n` +
          `| Signature Valid | ${verification.valid ? '✅ Yes' : '❌ No'} |\n` +
          `| Recovered Signer | \`${verification.recoveredAddress}\` |\n`;

        if (verification.error) {
          report += `\n> ⚠️ Verification error: ${verification.error}`;
        } else if (verification.valid) {
          report += `\n> ✅ Payment signature verified.`;
        } else {
          report += `\n> ❌ Signature mismatch — recovered address does not match claimed sender.`;
        }
      } else {
        report +=
          `Reference: \`${JSON.stringify(txRef)}\`\n\n` +
          `Verify on-chain at the relevant block explorer.`;
      }
    } catch {
      report +=
        `Reference: \`${JSON.stringify(txRef)}\`\n\n` +
        `Verify on-chain at the relevant block explorer.`;
    }

    await ctx.conversation.sendMarkdown(report);
  });

  // ── Auto-pay handler for x402:pay: protocol messages ─────────────────────

  agent.on('text', async (ctx) => {
    const rawText = ctx.message.content as string | { text?: string };
    const text =
      typeof rawText === 'string' ? rawText : (rawText?.text ?? '');

    // Detect x402 payment request: "x402:pay:<address>:<amount_usdc>:<reason>"
    if (typeof text === 'string' && text.startsWith('x402:pay:')) {
      const parts = text.split(':');
      if (parts.length >= 4) {
        const recipientAddress = parts[2] ?? '';
        const amountUsdc = parts[3] ?? '';
        const reason = parts.slice(4).join(':') || 'Agent payment request';

        const senderAddress = await ctx.getSenderAddress();
        if (!senderAddress) return;

        // Only auto-pay requests from trusted agents
        const trusted = await isTrustedAgent(senderAddress, chain, minBondWei);
        if (!trusted) {
          await ctx.conversation.sendMarkdown(
            `**x402 Auto-Pay Declined**\n\n` +
            `Requesting agent \`${senderAddress}\` is not a trusted Vaultfire agent.\n` +
            `Only bonded agents can request auto-payments.`,
          );
          return;
        }

        if (!x402) {
          await ctx.conversation.sendText(
            'x402 integration not configured — cannot process auto-payment.',
          );
          return;
        }

        try {
          const { record } = await x402.initiatePayment(
            recipientAddress,
            amountUsdc,
            reason,
          );

          await ctx.conversation.sendMarkdown(
            `**x402 Auto-Payment Processed**\n\n` +
            `| Field | Value |\n` +
            `|-------|-------|\n` +
            `| Requested By | \`${senderAddress}\` (trusted) |\n` +
            `| To | \`${recipientAddress}\` |\n` +
            `| Amount | ${amountUsdc} USDC |\n` +
            `| Payment ID | \`${record.id}\` |\n` +
            `| Status | Signed |\n\n` +
            `> Authorization signed. Submit to facilitator to settle on-chain.`,
          );
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Unknown error';
          await ctx.conversation.sendText(`x402 auto-pay failed: ${errorMsg}`);
        }
      }
    }
  });

  return agent;
}

// ---------------------------------------------------------------------------
// Trust middleware factory
// ---------------------------------------------------------------------------

/**
 * Create a standalone trust-gate middleware for any XMTP agent.
 *
 * Use this when you create your own `Agent` instance and want to add
 * Vaultfire trust gating without using `createVaultfireAgent`.
 *
 * @example
 * ```ts
 * import { Agent, createSigner, createUser } from '@xmtp/agent-sdk';
 * import { createTrustMiddleware } from '@vaultfire/xmtp';
 *
 * const user = createUser(walletKey);
 * const agent = await Agent.create(createSigner(user), { env: 'production' });
 *
 * agent.use(createTrustMiddleware({
 *   chain: 'base',
 *   blockUntrusted: true,
 *   minBondWei: '10000000000000000', // 0.01 ETH = silver tier
 * }));
 *
 * agent.on('text', async (ctx) => { ... });
 * await agent.start();
 * ```
 */
export function createTrustMiddleware(
  options: {
    chain?: string;
    minBondWei?: string;
    blockUntrusted?: boolean;
  } = {},
): AgentMiddleware {
  const chain = options.chain ?? 'base';
  const minBond = options.minBondWei ?? '0';
  const block = options.blockUntrusted ?? true;

  const middleware: AgentMiddleware = async (ctx, next) => {
    const senderAddress = await ctx.getSenderAddress();

    if (!senderAddress) {
      if (block) return;
      await next();
      return;
    }

    const trusted = await isTrustedAgent(senderAddress, chain, minBond);
    if (!trusted && block) {
      await ctx.conversation.sendText(
        '⚠️ Vaultfire Trust Gate: Register and stake a bond at ' +
          'theloopbreaker.com to interact.',
      );
      return;
    }

    await next();
  };

  return middleware;
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

/**
 * Create a Vaultfire trust-gated XMTP group conversation.
 *
 * All members should be Vaultfire-registered agents. The group metadata
 * includes the Vaultfire branding.
 *
 * @example
 * ```ts
 * const agent = await createVaultfireAgent({ walletKey: '0x...' });
 * const group = await createTrustedGroup(agent, 'Sentinel Council', [
 *   '0xAgent1...',
 *   '0xAgent2...',
 * ]);
 * ```
 */
export async function createTrustedGroup(
  agent: Awaited<ReturnType<typeof createVaultfireAgent>>,
  name: string,
  memberAddresses: string[],
  description?: string,
) {
  const group = await agent.createGroupWithAddresses(
    memberAddresses as `0x${string}`[],
    {
      groupName: name,
      groupDescription:
        description ?? `Vaultfire trust-gated group: ${name}`,
    },
  );
  return group;
}

/**
 * Send a DM to another agent with a Vaultfire identity footer.
 *
 * The footer is appended to the message body when the sending agent has an
 * active bond: `--- Sent by bonded Vaultfire agent (💎 1.0000 ETH on base)`
 *
 * @example
 * ```ts
 * const agent = await createVaultfireAgent({ walletKey: '0x...' });
 * await sendTrustedDm(agent, '0xRecipient...', 'Hello from a bonded agent!');
 * ```
 */
export async function sendTrustedDm(
  agent: Awaited<ReturnType<typeof createVaultfireAgent>>,
  recipientAddress: string,
  message: string,
  chain: string = 'base',
) {
  const agentAddress = agent.address;
  let trustLine = '';

  if (agentAddress) {
    const selfTrust = await verifyVaultfireTrust(agentAddress, chain);
    if (selfTrust.hasBond && selfTrust.bondActive) {
      trustLine =
        `\n\n---\n_Sent by bonded Vaultfire agent ` +
        `(${tierBadge(selfTrust.bondTier)} ${formatWei(selfTrust.bondAmount)} ETH bond on ${chain})_`;
    }
  }

  const dm = await agent.createDmWithAddress(recipientAddress as `0x${string}`);
  await dm.sendMarkdown(message + trustLine);
  return dm;
}

// ---------------------------------------------------------------------------
// Vaultfire message metadata
// ---------------------------------------------------------------------------

/**
 * Encode Vaultfire identity metadata as a compact base64 footer.
 *
 * Append the result to any XMTP message body to embed verifiable identity
 * metadata. Recipients can decode it with `decodeVaultfireMeta`.
 *
 * @example
 * ```ts
 * const footer = encodeVaultfireMeta('0xMyAddress', 'base');
 * await dm.send(`My message content ${footer}`);
 * ```
 */
export function encodeVaultfireMeta(
  address: string,
  chain: string = 'base',
): string {
  const meta: VaultfireMessageMeta = {
    protocol: 'vaultfire',
    version: '1.0',
    chain,
    bondContract: BOND_CONTRACT[chain] ?? (BOND_CONTRACT['base'] as string),
    identityRegistry:
      IDENTITY_REGISTRY[chain] ?? (IDENTITY_REGISTRY['base'] as string),
    senderAddress: address,
    timestamp: Date.now(),
  };
  // btoa is available in both browsers and Node 18+
  return `[VF:${btoa(JSON.stringify(meta))}]`;
}

/**
 * Decode Vaultfire identity metadata from a message string.
 *
 * @returns Parsed metadata object, or `null` if none found / invalid
 */
export function decodeVaultfireMeta(
  message: string,
): VaultfireMessageMeta | null {
  const match = message.match(/\[VF:([A-Za-z0-9+/=]+)\]/);
  if (!match || !match[1]) return null;
  try {
    const decoded = JSON.parse(atob(match[1])) as unknown;
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      'protocol' in decoded &&
      (decoded as Record<string, unknown>)['protocol'] === 'vaultfire'
    ) {
      return decoded as VaultfireMessageMeta;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exported utilities
// ---------------------------------------------------------------------------

/**
 * Format a wei amount to a human-readable ETH string with 4 decimal places.
 *
 * @example
 * formatWei('1000000000000000') // '0.0010'
 * formatWei('1500000000000000000') // '1.5000'
 */
export function formatWei(wei: string | bigint): string {
  const n = typeof wei === 'string' ? BigInt(wei) : wei;
  const whole = n / 10n ** 18n;
  const frac = n % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${fracStr}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Execute a raw eth_call via JSON-RPC.
 * Uses a 10-second timeout to avoid hanging on slow RPC endpoints.
 *
 * @internal
 */
async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      result?: string;
      error?: { message: string };
    };
    if (json.error) throw new Error(json.error.message);
    return json.result ?? '0x';
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// AgentMessageHandler re-export (for consumers who need the type)
// ---------------------------------------------------------------------------
export type { AgentMessageHandler, AgentMiddleware };
