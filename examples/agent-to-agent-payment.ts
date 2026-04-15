/**
 * @file examples/agent-to-agent-payment.ts
 * @description Agent-to-Agent USDC Payment via x402 Protocol
 *
 * Demonstrates:
 *   - Configuring x402 integration with vaultfire-x402
 *   - Creating a payment-enabled XMTP agent
 *   - Sending USDC to another agent via the /pay command
 *   - Auto-pay handling for x402:pay: protocol messages
 *   - Verifying payment signatures on receipt
 *
 * x402 Protocol:
 *   - Token: USDC on Base (6 decimals)
 *   - Method: EIP-3009 transferWithAuthorization
 *   - Signing: EIP-712 typed data
 *   - Trigger: "x402:pay:<address>:<amount>:<reason>" XMTP message
 *
 * Requirements:
 *   npm install @vaultfire/xmtp @vaultfire/x402 @xmtp/agent-sdk
 *
 * Environment:
 *   AGENT_PRIVATE_KEY=0x<64-hex>    # Sending agent wallet key
 *   RECIPIENT_ADDRESS=0x<40-hex>    # Recipient agent/wallet address
 *
 * Usage:
 *   npx ts-node examples/agent-to-agent-payment.ts
 *
 * @see https://theloopbreaker.com
 */

import {
  createVaultfireAgent,
  configureVaultfireXMTP,
  isTrustedAgent,
  sendTrustedDm,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENT_PRIVATE_KEY = process.env['AGENT_PRIVATE_KEY'] ?? '';
const RECIPIENT_ADDRESS = process.env['RECIPIENT_ADDRESS'] ?? '0xA054f831B562e729F8D268291EBde1B2EDcFb84F';

if (!AGENT_PRIVATE_KEY) {
  console.error('[payment-demo] Set AGENT_PRIVATE_KEY to run this example.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mock x402 integration (replace with @vaultfire/x402 for real payments)
// ---------------------------------------------------------------------------

/**
 * This mock demonstrates the X402Integration interface.
 * In production, import createX402Client from @vaultfire/x402.
 *
 * @example Real usage:
 * ```ts
 * import { createX402Client } from '@vaultfire/x402';
 * const x402 = createX402Client({ walletKey: process.env.AGENT_PRIVATE_KEY });
 * configureVaultfireXMTP({ x402 });
 * ```
 */
const mockX402 = {
  async initiatePayment(recipient: string, amount: string, reason = '') {
    const id = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const amountMicro = String(Math.floor(parseFloat(amount) * 1_000_000));

    console.log(`[x402] Signing payment: ${amount} USDC → ${recipient} (${reason})`);

    return {
      payload: {
        x402Version: 1,
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: amountMicro,
          resource: `https://api.vaultfire.io/pay/${id}`,
          description: reason,
        },
        payload: {
          signature: '0x' + 'a'.repeat(130),
          authorization: {
            from: '0xSenderAddress',
            to: recipient,
            value: amountMicro,
            validAfter: '0',
            validBefore: String(Math.floor(Date.now() / 1000) + 3600),
            nonce: '0x' + id,
          },
        },
      },
      record: {
        id,
        payTo: recipient,
        amount: amountMicro,
        amountFormatted: amount,
        reason,
        timestamp: Date.now(),
        status: 'pending' as const,
      },
    };
  },

  async verifyPaymentSignature(_payload: unknown) {
    return {
      valid: true,
      recoveredAddress: '0xSenderAddress',
    };
  },

  formatUsdc(micro: string): string {
    const n = BigInt(micro);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    return `${whole}.${frac.toString().padStart(6, '0')}`;
  },

  async getUsdcBalance(_address: string): Promise<string> {
    // Mock: return 100 USDC (100_000_000 micro-USDC)
    return '100000000';
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[payment-demo] Starting x402-enabled Vaultfire agent...');

  // Configure x402 at the module level (affects all agents created after this)
  configureVaultfireXMTP({ x402: mockX402 });

  const agent = await createVaultfireAgent({
    walletKey: AGENT_PRIVATE_KEY,
    env: 'production',
    chain: 'base',
    blockUntrusted: false, // allow untrusted senders for demo
    x402: mockX402,        // also pass per-agent for explicit binding
  });

  console.log(`[payment-demo] Agent address: ${agent.address}`);

  // ── Custom text handler ───────────────────────────────────────────────────

  agent.on('text', async (ctx) => {
    const rawText = ctx.message.content as string | { text?: string };
    const text = typeof rawText === 'string' ? rawText : (rawText?.text ?? '');

    // Skip commands (handled by built-in router)
    if (typeof text === 'string' && text.startsWith('/')) return;

    // Auto-pay protocol messages are handled internally — skip them here
    if (typeof text === 'string' && text.startsWith('x402:pay:')) return;

    const senderAddress = await ctx.getSenderAddress();
    if (!senderAddress) return;

    await ctx.conversation.sendMarkdown(
      '**x402 Payment Demo Agent**\n\n' +
      'Available payment commands:\n\n' +
      '| Command | Description |\n' +
      '|---------|-------------|\n' +
      '| `/pay <addr> <amount>` | Send USDC via x402 |\n' +
      '| `/balance` | Check your USDC balance |\n' +
      '| `/x402` | x402 protocol info |\n\n' +
      '**Auto-Pay Protocol**\n\n' +
      'Send a message in this format to trigger auto-pay:\n' +
      '```\nx402:pay:<recipient_address>:<amount_usdc>:<reason>\n```\n\n' +
      '> Auto-pay is only processed from trusted (bonded) agents.',
    );
  });

  // ── Demonstrate sending a payment DM ─────────────────────────────────────

  if (RECIPIENT_ADDRESS && RECIPIENT_ADDRESS.startsWith('0x')) {
    console.log(`\n[payment-demo] Checking trust for recipient: ${RECIPIENT_ADDRESS}`);
    const trusted = await isTrustedAgent(RECIPIENT_ADDRESS, 'base');
    console.log(`[payment-demo] Recipient trusted: ${trusted}`);

    console.log(`[payment-demo] Sending payment-request DM to ${RECIPIENT_ADDRESS}...`);
    try {
      await sendTrustedDm(
        agent,
        RECIPIENT_ADDRESS,
        '**Payment Request**\n\nI am initiating a 1.00 USDC payment via x402.\n\n' +
        'Automated x402 message: `x402:pay:' + RECIPIENT_ADDRESS + ':1.00:Demo payment`',
        'base',
      );
      console.log('[payment-demo] DM sent successfully');
    } catch (err) {
      console.warn('[payment-demo] DM send failed (expected if recipient is not on XMTP):', err);
    }
  }

  // ── Start listening ───────────────────────────────────────────────────────

  console.log('\n[payment-demo] Agent listening for XMTP messages...');
  console.log('[payment-demo] Send /pay or x402:pay: messages to interact');

  await agent.start();
}

main().catch((err) => {
  console.error('[payment-demo] Fatal error:', err);
  process.exit(1);
});
