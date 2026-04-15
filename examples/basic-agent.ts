/**
 * @file examples/basic-agent.ts
 * @description Basic Trust-Gated Vaultfire XMTP Agent
 *
 * Demonstrates the minimal setup to run a trust-gated XMTP agent that:
 *   - Verifies incoming sender bonds via AIPartnershipBondsV2
 *   - Responds to /trust, /status, /bond, /contracts commands automatically
 *   - Adds a custom text handler on top of Vaultfire defaults
 *
 * Requirements:
 *   npm install @vaultfire/xmtp @xmtp/agent-sdk
 *
 * Environment:
 *   AGENT_PRIVATE_KEY=0x<64-hex-chars>   # Agent wallet private key
 *   NODE_ENV=development                  # Enables debug logging
 *
 * Usage:
 *   npx ts-node examples/basic-agent.ts
 *
 * @see https://theloopbreaker.com
 */

import { createVaultfireAgent, verifyVaultfireTrust } from '../src/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_PRIVATE_KEY = process.env['AGENT_PRIVATE_KEY'] ?? '';

if (!AGENT_PRIVATE_KEY) {
  console.error('[basic-agent] Set AGENT_PRIVATE_KEY env var to run this example.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[basic-agent] Starting Vaultfire XMTP agent...');

  /**
   * Create a trust-gated agent.
   *
   * blockUntrusted: true → senders without a Vaultfire bond are automatically
   * rejected with an informative message. They never reach your handlers.
   *
   * chain: 'base' → trust is verified against AIPartnershipBondsV2 on Base.
   *
   * minBondWei: '0' → any active bond qualifies. Set to
   * '10000000000000000' for silver (0.01 ETH) or higher.
   */
  const agent = await createVaultfireAgent({
    walletKey: AGENT_PRIVATE_KEY,
    env: 'production',
    chain: 'base',
    blockUntrusted: true,
    minBondWei: '0',
  });

  // ── Custom handlers ───────────────────────────────────────────────────────

  /**
   * Handle plain text messages.
   *
   * By the time this handler fires, the trust-gate middleware has already
   * confirmed the sender has an active Vaultfire bond.
   */
  agent.on('text', async (ctx) => {
    const senderAddress = await ctx.getSenderAddress();
    if (!senderAddress) return;

    const text = ctx.message.content as string | { text?: string };
    const content =
      typeof text === 'string' ? text : (text?.text ?? '');

    // Skip command messages (handled by the built-in router)
    if (typeof content === 'string' && content.startsWith('/')) return;

    // Look up the sender's trust profile
    const trust = await verifyVaultfireTrust(senderAddress, 'base');

    const greeting = trust.hasBond && trust.bondActive
      ? `Hello, bonded agent! Your ${trust.bondTier} tier bond (#${trust.bondId}) is verified.`
      : `Hello! Register at theloopbreaker.com to stake a bond and unlock full access.`;

    await ctx.conversation.sendMarkdown(
      `**Vaultfire Agent**\n\n${greeting}\n\n` +
      `Try these commands:\n` +
      `- \`/trust\` — your trust status\n` +
      `- \`/trust-all\` — multi-chain trust\n` +
      `- \`/status\` — this agent's status\n` +
      `- \`/bond\` — staking instructions\n` +
      `- \`/contracts\` — contract addresses`,
    );
  });

  // ── Start the agent ───────────────────────────────────────────────────────

  console.log(`[basic-agent] Agent address: ${agent.address}`);
  console.log('[basic-agent] Listening for XMTP messages...');

  await agent.start();
}

main().catch((err) => {
  console.error('[basic-agent] Fatal error:', err);
  process.exit(1);
});
