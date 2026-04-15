/**
 * @file examples/trusted-group.ts
 * @description Trust-Gated XMTP Group Chat
 *
 * Demonstrates:
 *   - Creating a Vaultfire trust-gated group conversation
 *   - Verifying all members' trust before creating the group
 *   - Broadcasting announcements to a group
 *   - Handling group messages with trust context
 *   - The difference between group and DM message handling
 *
 * Use Case:
 *   A multi-agent council where only bonded Vaultfire agents can participate.
 *   The coordinator agent verifies every candidate's trust, then creates
 *   the group only if all members pass verification.
 *
 * Requirements:
 *   npm install @vaultfire/xmtp @xmtp/agent-sdk
 *
 * Environment:
 *   COORDINATOR_KEY=0x<64-hex>       # Coordinator agent's private key
 *   MEMBER_ADDRESSES=0x...,0x...     # Comma-separated member addresses
 *
 * Usage:
 *   npx ts-node examples/trusted-group.ts
 *
 * @see https://theloopbreaker.com
 */

import {
  createVaultfireAgent,
  createTrustedGroup,
  verifyMultiChainTrust,
  isTrustedAgent,
  formatWei,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const COORDINATOR_KEY = process.env['COORDINATOR_KEY'] ?? '';
const MEMBER_ADDRESSES_RAW = process.env['MEMBER_ADDRESSES'] ?? '';

// Example member addresses (replace with real ones)
const MEMBER_ADDRESSES = MEMBER_ADDRESSES_RAW
  ? MEMBER_ADDRESSES_RAW.split(',').map((a) => a.trim())
  : [
      '0xA054f831B562e729F8D268291EBde1B2EDcFb84F', // Example: Embris Agent
      '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', // Example: vitalik.eth
    ];

if (!COORDINATOR_KEY) {
  console.error('[trusted-group] Set COORDINATOR_KEY to run this example.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Trust verification for all candidates
// ---------------------------------------------------------------------------

async function verifyAllCandidates(addresses: string[]): Promise<{
  approved: string[];
  rejected: string[];
}> {
  console.log(`\n[trusted-group] Verifying ${addresses.length} candidates...`);

  const approved: string[] = [];
  const rejected: string[] = [];

  await Promise.all(
    addresses.map(async (address) => {
      const multi = await verifyMultiChainTrust(address);
      const best = multi.bestProfile;

      if (best.hasBond && best.bondActive) {
        console.log(
          `  ✅ ${address.slice(0, 10)}... — ${best.bondTier} tier, ` +
          `${formatWei(best.bondAmount)} ETH on ${multi.bestChain}`,
        );
        approved.push(address);
      } else {
        console.log(
          `  ❌ ${address.slice(0, 10)}... — ${best.summary}`,
        );
        rejected.push(address);
      }
    }),
  );

  return { approved, rejected };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[trusted-group] Starting coordinator agent...');

  const coordinator = await createVaultfireAgent({
    walletKey: COORDINATOR_KEY,
    env: 'production',
    chain: 'base',
    blockUntrusted: false, // coordinator receives all messages
  });

  console.log(`[trusted-group] Coordinator: ${coordinator.address}`);

  // ── Verify all candidates ─────────────────────────────────────────────────

  const { approved, rejected } = await verifyAllCandidates(MEMBER_ADDRESSES);

  console.log(`\n[trusted-group] Verification results:`);
  console.log(`  Approved: ${approved.length}/${MEMBER_ADDRESSES.length}`);
  console.log(`  Rejected: ${rejected.length}/${MEMBER_ADDRESSES.length}`);

  if (approved.length === 0) {
    console.log(
      '[trusted-group] No approved members — skipping group creation.\n' +
      'Register agents at theloopbreaker.com to stake bonds.',
    );
  } else {
    // ── Create the trust-gated group ─────────────────────────────────────────

    console.log(`\n[trusted-group] Creating trust-gated group with ${approved.length} members...`);

    try {
      const group = await createTrustedGroup(
        coordinator,
        'Vaultfire Sentinel Council',
        approved,
        'Bonded Vaultfire agents only — accountability-grade infrastructure',
      );

      console.log(`[trusted-group] Group created!`);
      console.log(`  Group ID: ${group.id ?? 'N/A'}`);

      // Send the welcome announcement
      const rejectedLine =
        rejected.length > 0
          ? `\n\n⚠️ ${rejected.length} candidate(s) were rejected — no active bond found.`
          : '';

      await group.sendMarkdown(
        `**Vaultfire Sentinel Council**\n\n` +
        `Welcome! This group is protected by Vaultfire on-chain trust.\n\n` +
        `**Members:** ${approved.length}\n` +
        `**Chain:** Base\n` +
        `**Standard:** AIPartnershipBondsV2\n\n` +
        `All members have verified active bonds. Use \`/trust\` to check yours.` +
        rejectedLine,
      );

      console.log('[trusted-group] Welcome message sent');
    } catch (err) {
      console.warn('[trusted-group] Group creation failed (SDK may require real keys):', err);
    }
  }

  // ── Group message handler ─────────────────────────────────────────────────

  coordinator.on('text', async (ctx) => {
    const rawText = ctx.message.content as string | { text?: string };
    const text = typeof rawText === 'string' ? rawText : (rawText?.text ?? '');
    if (typeof text === 'string' && text.startsWith('/')) return;

    const senderAddress = await ctx.getSenderAddress();
    if (!senderAddress) return;

    // In a group, verify the sender's trust in real time
    const trusted = await isTrustedAgent(senderAddress, 'base');
    if (!trusted) {
      await ctx.conversation.sendText(
        `⚠️ ${senderAddress.slice(0, 10)}... is not a bonded Vaultfire agent. ` +
        `Messages from non-bonded senders are not processed.`,
      );
      return;
    }

    const multi = await verifyMultiChainTrust(senderAddress);
    const best = multi.bestProfile;

    await ctx.conversation.sendText(
      `[${best.bondTier.toUpperCase()}] Message received from ` +
      `${senderAddress.slice(0, 10)}... ` +
      `(${formatWei(best.bondAmount)} ETH bond on ${multi.bestChain})`,
    );
  });

  console.log('\n[trusted-group] Coordinator listening for group messages...');
  await coordinator.start();
}

main().catch((err) => {
  console.error('[trusted-group] Fatal error:', err);
  process.exit(1);
});
