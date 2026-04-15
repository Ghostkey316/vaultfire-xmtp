/**
 * @file examples/browser-integration.ts
 * @description Browser XMTP Integration with Vaultfire Trust
 *
 * Demonstrates how to use the browser XMTP client in a frontend application:
 *   - Initialize XMTP with window.ethereum (MetaMask / Coinbase Wallet)
 *   - Or use a PrivateKeyWalletProvider for testing / SSR contexts
 *   - Create conversations with Vaultfire agents
 *   - Send and receive encrypted messages
 *   - Display real-time connection status
 *   - Show trust verification alongside messages
 *
 * This file simulates a browser environment — in a real React/Next.js app,
 * import these functions and call them from your components.
 *
 * Requirements:
 *   npm install @vaultfire/xmtp @xmtp/xmtp-js ethers
 *
 * Note: browser-integration.ts uses @xmtp/xmtp-js (browser SDK), not
 * @xmtp/agent-sdk. The browser client is for frontend wallet holders,
 * not server-side agents.
 *
 * @see https://theloopbreaker.com
 */

// NOTE: These imports assume a browser environment. In Node.js, use the
// server-side XMTPClient from xmtp-client.ts instead.
import {
  getXMTPBrowserClient,
  initializeXMTPBrowser,
  getXMTPBrowserState,
  isXMTPBrowserConnected,
  sendXMTPBrowserMessage,
  getXMTPBrowserMessages,
  onXMTPStatusChange,
  onXMTPMessage,
  createAgentRoom,
  createCollaborationRoom,
  PrivateKeyWalletProvider,
} from '../src/xmtp-browser.js';

import {
  verifyVaultfireTrust,
  encodeVaultfireMeta,
  decodeVaultfireMeta,
} from '../src/xmtp-connector.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY = process.env['TEST_PRIVATE_KEY'] ?? '';
const TEST_ADDRESS = process.env['TEST_ADDRESS'] ?? '0x0000000000000000000000000000000000000001';
const AGENT_ADDRESS = '0xA054f831B562e729F8D268291EBde1B2EDcFb84F';

// ---------------------------------------------------------------------------
// Browser environment simulation (Node.js only — in real browser, skip this)
// ---------------------------------------------------------------------------

// In an actual browser environment, window.ethereum is provided by the wallet
// extension. For this demo script, we use PrivateKeyWalletProvider instead.

// ---------------------------------------------------------------------------
// Demo: Status Monitoring
// ---------------------------------------------------------------------------

function setupStatusMonitor(): () => void {
  console.log('[browser] Setting up status monitor...');

  const unsubscribe = onXMTPStatusChange((status) => {
    const icons: Record<string, string> = {
      disconnected: '⚪',
      connecting: '🔄',
      connected: '🟢',
      fallback: '🟡',
      error: '🔴',
    };
    console.log(`[browser] XMTP status: ${icons[status] ?? '?'} ${status}`);
  });

  return unsubscribe;
}

// ---------------------------------------------------------------------------
// Demo: Message Monitoring
// ---------------------------------------------------------------------------

function setupMessageMonitor(topic: string): () => void {
  return onXMTPMessage(topic, (msg) => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const sender = msg.senderAddress.slice(0, 10);
    const encrypted = msg.isEncrypted ? '🔒' : '🔓';
    console.log(`[browser] ${time} ${encrypted} ${sender}...: ${msg.content.slice(0, 60)}`);

    // Check for Vaultfire metadata footer
    const meta = decodeVaultfireMeta(msg.content);
    if (meta) {
      console.log(`  [VF-Meta] From: ${meta.senderAddress} | Chain: ${meta.chain} | v${meta.version}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Demo: Trust Verification in UI
// ---------------------------------------------------------------------------

async function showTrustBadge(address: string): Promise<void> {
  console.log(`\n[browser] Checking trust for ${address.slice(0, 10)}...`);

  const trust = await verifyVaultfireTrust(address, 'base');

  const badge = trust.bondActive
    ? `🟢 ${trust.bondTier.toUpperCase()} BOND`
    : trust.hasBond
      ? '🟡 INACTIVE BOND'
      : trust.isRegistered
        ? '⚪ REGISTERED (no bond)'
        : '🔴 NOT REGISTERED';

  // In a React component, you'd return JSX. Here we log to console.
  console.log(`  Trust Badge: ${badge}`);
  console.log(`  Summary:     ${trust.summary}`);
}

// ---------------------------------------------------------------------------
// Demo: Conversation flow
// ---------------------------------------------------------------------------

async function conversationDemo(): Promise<void> {
  console.log('\n[browser] Creating conversation with Vaultfire agent...');

  const client = getXMTPBrowserClient();
  const conv = await client.getOrCreateConversation(AGENT_ADDRESS);

  if (!conv) {
    console.log('[browser] Could not create conversation');
    return;
  }

  console.log(`[browser] Conversation topic: ${conv.topic}`);

  // Monitor messages on this conversation
  const unsubscribe = setupMessageMonitor(conv.topic);

  // Encode a Vaultfire metadata footer
  const meta = encodeVaultfireMeta(TEST_ADDRESS, 'base');

  // Send a message with identity metadata
  const msg = await sendXMTPBrowserMessage(
    conv.topic,
    `/trust\n\n${meta}`,
  );

  if (msg) {
    console.log(`[browser] Message sent: ${msg.id}`);
    console.log(`  Content:   ${msg.content.slice(0, 60)}`);
    console.log(`  Encrypted: ${msg.isEncrypted}`);
  }

  // Retrieve all messages
  const messages = getXMTPBrowserMessages(conv.topic);
  console.log(`[browser] Total messages in conversation: ${messages.length}`);

  // Clean up listener
  unsubscribe();
}

// ---------------------------------------------------------------------------
// Demo: Agent coordination room
// ---------------------------------------------------------------------------

async function agentRoomDemo(): Promise<void> {
  console.log('\n[browser] Creating agent coordination room...');

  const topic = await createAgentRoom(
    [AGENT_ADDRESS, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
    'Vaultfire-Sentinel-Council',
  );

  console.log(`[browser] Agent room created: ${topic}`);

  const unsubscribe = setupMessageMonitor(topic);

  await sendXMTPBrowserMessage(
    topic,
    `[Coordinator] All agents: perform trust verification and report status.`,
  );

  unsubscribe();
}

// ---------------------------------------------------------------------------
// Demo: Human-AI collaboration room
// ---------------------------------------------------------------------------

async function collaborationRoomDemo(): Promise<void> {
  console.log('\n[browser] Creating human-AI collaboration room...');

  const topic = await createCollaborationRoom(
    TEST_ADDRESS,
    AGENT_ADDRESS,
    'Security audit of AIPartnershipBondsV2 contract on Base',
  );

  console.log(`[browser] Collaboration room created: ${topic}`);

  await sendXMTPBrowserMessage(
    topic,
    'Please begin the security audit. Focus on bond validation logic and re-entrancy vectors.',
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Vaultfire XMTP — Browser Integration Demo');
  console.log('==========================================');

  // Set up status monitoring
  const unsubStatus = setupStatusMonitor();

  // Initialize with PrivateKeyWalletProvider (server-side simulation)
  // In a real browser: call initializeXMTPBrowser() with no args to use window.ethereum
  let connected = false;

  if (TEST_PRIVATE_KEY && TEST_ADDRESS) {
    const provider = new PrivateKeyWalletProvider(TEST_PRIVATE_KEY, TEST_ADDRESS);
    connected = await initializeXMTPBrowser(provider);
  } else {
    console.log('[browser] No TEST_PRIVATE_KEY set — using fallback mode');
    // Simulate fallback mode
    const fakeProvider = {
      getWalletAddress: () => TEST_ADDRESS,
      getSessionPrivateKey: () => null, // triggers fallback
      isWalletUnlocked: () => true,
    };
    connected = await initializeXMTPBrowser(fakeProvider);
  }

  console.log(`\n[browser] Connected: ${connected}`);

  const state = getXMTPBrowserState();
  console.log('[browser] State:', {
    status: state.status,
    address: state.address?.slice(0, 10) + '...',
    isRealXMTP: state.isRealXMTP,
    conversations: state.conversationCount,
  });

  if (!isXMTPBrowserConnected()) {
    console.log('[browser] Not connected — check wallet configuration');
    unsubStatus();
    return;
  }

  // Run demonstrations
  await showTrustBadge(AGENT_ADDRESS);
  await conversationDemo();
  await agentRoomDemo();
  await collaborationRoomDemo();

  // Final state
  const finalState = getXMTPBrowserState();
  console.log('\n[browser] Final state:');
  console.log(`  Conversations: ${finalState.conversationCount}`);
  console.log(`  Messages: ${finalState.messageCount}`);
  console.log(`  Mode: ${finalState.isRealXMTP ? 'Real XMTP' : 'Local fallback'}`);

  unsubStatus();
  console.log('\n✓ Browser integration demo complete');
}

main().catch((err) => {
  console.error('[browser] Error:', err);
  process.exit(1);
});
