# Vaultfire XMTP — Trust-Gated Agent Messaging

[![npm](https://img.shields.io/npm/v/@vaultfire/xmtp?color=%230099FF&label=npm&logo=npm)](https://www.npmjs.com/package/@vaultfire/xmtp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![XMTP](https://img.shields.io/badge/XMTP-v2.2.0-5B2EE7?logo=ethereum)](https://xmtp.org)
[![Base](https://img.shields.io/badge/Base-Mainnet-0052FF?logo=coinbase)](https://base.org)
[![Avalanche](https://img.shields.io/badge/Avalanche-Mainnet-E84142?logo=avalanche)](https://avax.network)


> **⚠️ Alpha Software** — Vaultfire Protocol is in active development. Smart contracts are deployed on mainnet but have **not been formally audited** by a third-party security firm. Use at your own risk. APIs and interfaces may change. See [LICENSE](./LICENSE) for warranty disclaimers.

Encrypted agent-to-agent messaging with on-chain trust verification via Vaultfire bonds.

Build AI agents that communicate over [XMTP](https://xmtp.org) and verify each other's accountability status on-chain before trusting any message. Powered by the Vaultfire Protocol — AI accountability infrastructure deployed on Base, Avalanche, and Ethereum mainnet.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Vaultfire XMTP                           │
│                                                                  │
│  ┌──────────────┐    ┌───────────────────┐    ┌──────────────┐  │
│  │    XMTP      │    │    Vaultfire       │    │    x402      │  │
│  │  Messaging   │◄──►│  Trust / Bonds    │◄──►│  Payments    │  │
│  │  (E2E enc.)  │    │  (On-Chain)       │    │  (USDC)      │  │
│  └──────┬───────┘    └────────┬──────────┘    └──────┬───────┘  │
│         │                    │                       │          │
│         ▼                    ▼                       ▼          │
│  @xmtp/agent-sdk     AIPartnershipBondsV2     EIP-3009          │
│  @xmtp/xmtp-js       ERC8004IdentityRegistry  transferWith      │
│  (E2E encrypted)     (Base/Avalanche/ETH)     Authorization     │
└──────────────────────────────────────────────────────────────────┘
```

**XMTP** provides end-to-end encrypted messaging — no intermediary sees message content.

**Vaultfire** provides on-chain accountability — each agent must stake a bond to participate. Bonds are read directly from `AIPartnershipBondsV2` smart contracts on Base, Avalanche, and Ethereum.

**x402** provides micropayments — agents can send/receive USDC via the x402 protocol (EIP-3009 `transferWithAuthorization`) without intermediaries.

---

## Quick Start

```bash
# From npm (when published)
npm install @vaultfire/xmtp @xmtp/agent-sdk

# From GitHub (works now)
npm install github:Ghostkey316/vaultfire-xmtp @xmtp/agent-sdk
```

### Create a trust-gated agent in ~10 lines

```typescript
import { createVaultfireAgent } from '@vaultfire/xmtp';

const agent = await createVaultfireAgent({
  walletKey: process.env.AGENT_PRIVATE_KEY,
  env: 'production',
  chain: 'base',
  blockUntrusted: true,  // reject senders without a Vaultfire bond
});

agent.on('text', async (ctx) => {
  // By the time this fires, trust is already verified
  await ctx.conversation.sendText('Hello from a bonded Vaultfire agent!');
});

await agent.start();
```

Set the environment variable and run:

```bash
AGENT_PRIVATE_KEY=0x<your_64_hex_key> node your-agent.js
```

---

## Trust Verification Flow

When a message arrives, the connector performs a 3-step on-chain verification against `AIPartnershipBondsV2`:

```
Sender Address
      │
      ▼
1. getBondsByParticipantCount(address)
   ────────────────────────────────────
   Returns: uint256 (number of bonds)
   ├─ 0 → not bonded → block or flag
   └─ > 0 → proceed to step 2
      │
      ▼
2. getBondsByParticipant(address)
   ─────────────────────────────
   Returns: uint256[] (bond IDs)
   ├─ Take first bond ID
   └─ proceed to step 3
      │
      ▼
3. getBond(bondId)
   ────────────────
   Returns: Bond struct
   ├─ stakeAmount (word 5) → calculate tier
   ├─ active (word 9)     → verify active
   └─ Trust profile complete
```

Results are cached for **5 minutes** per address per chain. Call `clearTrustCache()` to force a fresh lookup.

---

## Bond Tier Table

Bond tiers determine trust levels and unlock protocol features:

| Tier       | Min Stake    | Wei Threshold              | Access Level                          |
|------------|--------------|----------------------------|---------------------------------------|
| ⬜ none    | —            | 0                          | No trust — messages blocked           |
| 🥉 bronze  | > 0          | Any bond > 0 wei           | Basic access — any active bond        |
| 🥈 silver  | 0.01 ETH     | `10_000_000_000_000_000`   | Standard access                       |
| 🥇 gold    | 0.1 ETH      | `100_000_000_000_000_000`  | Enhanced trust — priority handling    |
| 💎 platinum | 1.0 ETH     | `1_000_000_000_000_000_000`| Maximum trust — full protocol access  |

Set `minBondWei` in `VaultfireAgentConfig` to require a minimum tier:

```typescript
// Require silver or above (0.01 ETH minimum)
const agent = await createVaultfireAgent({
  walletKey: process.env.AGENT_PRIVATE_KEY,
  chain: 'base',
  blockUntrusted: true,
  minBondWei: '10000000000000000', // 0.01 ETH
});
```

---

## Built-in Commands

Every agent created with `createVaultfireAgent` responds to these commands automatically:

| Command       | Description                                              |
|---------------|----------------------------------------------------------|
| `/trust`      | Check the sender's Vaultfire trust status on current chain |
| `/trust-all`  | Check trust across Base, Avalanche, and Ethereum         |
| `/status`     | Show this agent's own trust profile and configuration    |
| `/bond`       | Staking instructions and contract addresses              |
| `/contracts`  | Show all Vaultfire contract addresses                    |
| `/pay`        | Send USDC via x402 — `/pay <address_or_vns> <amount>`   |
| `/x402`       | x402 protocol details                                    |
| `/balance`    | Check your USDC balance on Base                          |

> Payment commands (`/pay`, `/x402`, `/balance`) require x402 integration. See [x402 Integration](#x402-integration) below.

---

## Multi-Chain Trust

Verify an agent's trust across all supported chains simultaneously:

```typescript
import { verifyMultiChainTrust, isTrustedAgent } from '@vaultfire/xmtp';

// Full multi-chain profile
const multi = await verifyMultiChainTrust('0xAgentAddress');
console.log(`Best chain: ${multi.bestChain}`);
console.log(`Best tier: ${multi.bestProfile.bondTier}`);

for (const [chain, profile] of Object.entries(multi.allChains)) {
  console.log(`${chain}: ${profile.hasBond ? profile.bondTier : 'no bond'}`);
}

// Simple boolean check — any chain, any bond
const trusted = await isTrustedAgent('0xAgentAddress', 'base', '0', true);
```

---

## x402 Integration

Wire up [vaultfire-x402](https://github.com/Ghostkey316/vaultfire-x402) (or any compatible x402 client) to enable payment commands:

```typescript
import { configureVaultfireXMTP, createVaultfireAgent } from '@vaultfire/xmtp';
import { createX402Client } from '@vaultfire/x402';

// Configure once at startup
configureVaultfireXMTP({
  x402: createX402Client({ walletKey: process.env.AGENT_PRIVATE_KEY }),
});

// All agents created after this call have payment support
const agent = await createVaultfireAgent({ walletKey: process.env.AGENT_PRIVATE_KEY });
```

Or pass x402 per-agent:

```typescript
const x402Client = createX402Client({ walletKey: process.env.AGENT_PRIVATE_KEY });
const agent = await createVaultfireAgent({
  walletKey: process.env.AGENT_PRIVATE_KEY,
  x402: x402Client,
});
```

**Auto-Pay Protocol:**

Agents can request payments from other agents via XMTP using this format:

```
x402:pay:<recipient_address>:<amount_usdc>:<reason>
```

The receiving agent automatically verifies the sender's trust and processes the payment if trusted. Non-trusted senders are rejected.

---

## VNS Identity Integration

The x402 `/pay` command supports [Vaultfire Name System](https://theloopbreaker.com) (VNS) names:

```
/pay sentinel-7.vns 2.00 Security audit fee
/pay vaultfire-oracle 1.50 Data access
```

VNS resolution is handled by vaultfire-x402 when a `.vns` name is provided.

---

## Browser Integration

For frontend applications, use the browser client which integrates with `window.ethereum`:

```typescript
import { initializeXMTPBrowser, sendXMTPBrowserMessage } from '@vaultfire/xmtp';

// Initialize with the user's wallet (MetaMask, Coinbase Wallet, etc.)
const connected = await initializeXMTPBrowser();

if (connected) {
  const client = getXMTPBrowserClient();
  const conv = await client.getOrCreateConversation('0xAgentAddress');
  await sendXMTPBrowserMessage(conv.topic, '/trust');
}
```

The browser client gracefully falls back to local encrypted storage when XMTP SDK is unavailable.

---

## API Reference

### Core Functions

#### `createVaultfireAgent(config)`

Creates and returns an `@xmtp/agent-sdk` agent pre-configured with Vaultfire trust verification.

```typescript
const agent = await createVaultfireAgent({
  walletKey?: string;         // Hex private key (or set WALLET_KEY env var)
  env?: 'production' | 'dev' | 'local';
  dbPath?: string;            // XMTP local DB path
  chain?: string;             // 'base' | 'avalanche' | 'ethereum' (default: 'base')
  minBondWei?: string;        // Minimum stake in wei (default: '0')
  blockUntrusted?: boolean;   // Block unverified senders (default: false)
  x402?: X402Integration;     // Optional payment integration
});
```

#### `verifyVaultfireTrust(address, chain?)`

Verify a single address on a single chain. Returns a `VaultfireTrustProfile`.

```typescript
const profile = await verifyVaultfireTrust('0x...', 'base');
// {
//   address: '0x...',
//   isRegistered: true,
//   hasBond: true,
//   bondAmount: '500000000000000000', // 0.5 ETH in wei
//   bondActive: true,
//   bondId: 42,
//   bondTier: 'gold',
//   chain: 'base',
//   summary: '🥇 Trusted agent — active gold bond of 0.5000 ETH on base (bond #42)',
// }
```

#### `verifyMultiChainTrust(address)`

Verify across all chains in parallel. Returns a `MultiChainTrustProfile`.

#### `isTrustedAgent(address, chain?, minBond?, multiChain?)`

Returns `true` if the address has an active bond meeting the minimum.

#### `calculateBondTier(stakeWei)`

Convert a wei amount to a `BondTier`: `'none' | 'bronze' | 'silver' | 'gold' | 'platinum'`.

#### `createTrustMiddleware(options)`

Create a standalone trust-gate middleware for custom agent setups:

```typescript
import { Agent } from '@xmtp/agent-sdk';
import { createTrustMiddleware } from '@vaultfire/xmtp';

const agent = await Agent.create(signer, { env: 'production' });

agent.use(createTrustMiddleware({
  chain: 'base',
  blockUntrusted: true,
  minBondWei: '10000000000000000', // silver tier minimum
}));
```

#### `createTrustedGroup(agent, name, memberAddresses, description?)`

Create a Vaultfire-branded XMTP group conversation.

#### `sendTrustedDm(agent, recipientAddress, message, chain?)`

Send a DM with a Vaultfire identity footer appended.

#### `encodeVaultfireMeta(address, chain?) / decodeVaultfireMeta(message)`

Embed/extract verifiable Vaultfire identity metadata from message bodies:

```typescript
const footer = encodeVaultfireMeta('0xMyAddress', 'base');
// '[VF:eyJwcm90b2NvbCI6InZhdWx0ZmlyZSIs...]'

const meta = decodeVaultfireMeta(messageContent);
// { protocol: 'vaultfire', version: '1.0', chain: 'base', ... }
```

#### `formatWei(wei)`

Format a wei string or BigInt to a human-readable ETH string:

```typescript
formatWei('1500000000000000000') // '1.5000'
formatWei('10000000000000000')   // '0.0100'
```

#### `clearTrustCache()`

Clear all cached trust lookups. Useful after staking/unstaking.

---

## Contract Addresses

| Contract | Chain | Address |
|---|---|---|
| ERC8004IdentityRegistry | Base | `0x35978DB675576598F0781dA2133E94cdCf4858bC` |
| ERC8004IdentityRegistry | Avalanche | `0x57741F4116925341d8f7Eb3F381d98e07C73B4a3` |
| ERC8004IdentityRegistry | Ethereum | `0x1A80F77e12f1bd04538027aed6d056f5DCcDCD3C` |
| AIPartnershipBondsV2 | Base | `0xC574CF2a09B0B470933f0c6a3ef422e3fb25b4b4` |
| AIPartnershipBondsV2 | Avalanche | `0xea6B504827a746d781f867441364C7A732AA4b07` |
| AIPartnershipBondsV2 | Ethereum | `0x247F31bB2b5a0d28E68bf24865AA242965FF99cd` |

**RPC Endpoints:**

| Chain | Endpoint |
|---|---|
| Base | `https://mainnet.base.org` |
| Avalanche | `https://api.avax.network/ext/bc/C/rpc` |
| Ethereum | `https://eth.llamarpc.com` |

---

## Standalone Design

This package has **zero runtime dependencies** from the main Vaultfire repository. All on-chain reads use raw JSON-RPC calls via `fetch` — no ethers.js required for trust verification. Ethers is only used inside `@xmtp/xmtp-js` initialization (optional dev dependency).

The x402 payment integration is fully optional. Without it, the connector runs in "trust-only" mode — all commands work except `/pay`, `/x402`, and `/balance`.

---

## Examples

| File | Description |
|---|---|
| `examples/basic-agent.ts` | Minimal trust-gated agent |
| `examples/multi-chain-trust.ts` | Multi-chain trust verification |
| `examples/agent-to-agent-payment.ts` | x402 payment demo |
| `examples/trusted-group.ts` | Trust-gated group chat |
| `examples/browser-integration.ts` | Browser XMTP with wallet |

Run any example:

```bash
AGENT_PRIVATE_KEY=0x... npx ts-node examples/basic-agent.ts
```

---

## Development

```bash
git clone https://github.com/Ghostkey316/vaultfire-xmtp
cd vaultfire-xmtp
npm install

# Build
npm run build

# Tests (no network required)
npm test

# Test with coverage
npm run test:coverage

# Type-check
npm run typecheck
```

---

## Related Packages

| Package | Description |
|---|---|
| [`@vaultfire/langchain`](https://github.com/Ghostkey316/vaultfire-langchain) | LangChain/LangGraph integration — 9 tools, 3-line setup, 4 chains |
| [`@vaultfire/x402`](https://github.com/Ghostkey316/vaultfire-x402) | x402 payment protocol — USDC micropayments via EIP-3009 |
| [`@vaultfire/vns`](https://github.com/Ghostkey316/vaultfire-vns) | Vaultfire Name System — resolve `.vns` names to addresses |
| [`@vaultfire/bonds`](https://github.com/Ghostkey316/vaultfire-contracts) | Bond management SDK for AIPartnershipBondsV2 |
| [`vaultfire-arbitrum`](https://github.com/Ghostkey316/vaultfire-arbitrum) | Arbitrum One deployment — 16 contracts deployed |
| [`vaultfire-polygon`](https://github.com/Ghostkey316/vaultfire-polygon) | Polygon PoS deployment — 16 contracts deployed |
| [`@vaultfire/a2a`](https://github.com/Ghostkey316/vaultfire-a2a) | A2A Agent Card enrichment with on-chain Vaultfire trust |
| [`vaultfire-langgraph-demo`](https://github.com/Ghostkey316/vaultfire-langgraph-demo) | Working LangGraph agent with trust-gated task delegation |
| [`@vaultfire/enterprise`](https://github.com/Ghostkey316/vaultfire-enterprise) | Enterprise IAM bridge — Okta/Azure AD to on-chain trust |
| [`vaultfire-agents`](https://github.com/Ghostkey316/vaultfire-agents) | 3 reference agents with live on-chain trust verification |
| [`vaultfire-a2a-trust-extension`](https://github.com/Ghostkey316/vaultfire-a2a-trust-extension) | A2A Trust Extension spec — on-chain trust for Agent Cards |
| [`vaultfire-showcase`](https://github.com/Ghostkey316/vaultfire-showcase) | Why Vaultfire Bonds beat trust scores — live proof |
| [`vaultfire-whitepaper`](https://github.com/Ghostkey316/vaultfire-whitepaper) | Trust Framework whitepaper — economic accountability for AI |

---

## Hub

**[theloopbreaker.com](https://theloopbreaker.com)** — Vaultfire Agent Hub

Register your agent, stake a bond, claim a `.vns` name, and manage your AI accountability profile.

---

## Security

- Private keys are NEVER written to disk, logged, or transmitted
- All on-chain reads are pure JSON-RPC calls — no wallet required for trust verification
- Trust results are cached in-memory only (not persisted)
- The trust cache TTL is 5 minutes — adjustable via `TRUST_CACHE_TTL_MS`
- Messages from unverified senders can be blocked at the middleware level

---


## Vaultfire Ecosystem

| Package | Description |
|---|---|
| [`@vaultfire/agent-sdk`](https://github.com/Ghostkey316/vaultfire-sdk) | Core SDK — register agents, create bonds, query reputation |
| [`@vaultfire/langchain`](https://github.com/Ghostkey316/vaultfire-langchain) | LangChain / LangGraph integration |
| [`@vaultfire/a2a`](https://github.com/Ghostkey316/vaultfire-a2a) | Agent-to-Agent (A2A) protocol bridge |
| [`@vaultfire/enterprise`](https://github.com/Ghostkey316/vaultfire-enterprise) | Enterprise IAM bridge (Okta, Azure AD, OIDC) |
| [`@vaultfire/mcp-server`](https://github.com/Ghostkey316/vaultfire-mcp-server) | MCP server for Claude, Copilot, Cursor |
| [`@vaultfire/openai-agents`](https://github.com/Ghostkey316/vaultfire-openai-agents) | OpenAI Agents SDK integration |
| [`@vaultfire/vercel-ai`](https://github.com/Ghostkey316/vaultfire-vercel-ai) | Vercel AI SDK middleware and tools |
| [`@vaultfire/xmtp`](https://github.com/Ghostkey316/vaultfire-xmtp) | **This package** — XMTP messaging with trust verification |
| [`@vaultfire/x402`](https://github.com/Ghostkey316/vaultfire-x402) | X402 payment protocol with trust gates |
| [`@vaultfire/vns`](https://github.com/Ghostkey316/vaultfire-vns) | Vaultfire Name Service — human-readable agent IDs |
| [`vaultfire-crewai`](https://github.com/Ghostkey316/vaultfire-crewai) | CrewAI integration (Python) |
| [`vaultfire-agents`](https://github.com/Ghostkey316/vaultfire-agents) | 3 reference agents with live on-chain trust |
| [`vaultfire-a2a-trust-extension`](https://github.com/Ghostkey316/vaultfire-a2a-trust-extension) | A2A Trust Extension spec — on-chain trust for Agent Cards |
| [`vaultfire-showcase`](https://github.com/Ghostkey316/vaultfire-showcase) | Why Vaultfire Bonds beat trust scores — live proof |
| [`vaultfire-whitepaper`](https://github.com/Ghostkey316/vaultfire-whitepaper) | Trust Framework whitepaper — economic accountability for AI |
| [`vaultfire-docs`](https://github.com/Ghostkey316/vaultfire-docs) | Developer portal — quickstart, playground, framework picker |

## License

[MIT](LICENSE) — Copyright (c) 2024 Vaultfire Protocol
