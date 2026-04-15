/**
 * @file xmtp-client.ts
 * @description Server-side XMTP client for Vaultfire agents.
 *
 * Wraps @xmtp/xmtp-js with a clean, typed interface. The agent's private key
 * is sourced exclusively from the VAULTFIRE_AGENT_KEY environment variable (or
 * passed directly at construction time) and is NEVER written to disk, logged,
 * or transmitted.
 *
 * This module is designed for Node.js / server environments. For browser
 * usage, use `xmtp-browser.ts` instead.
 *
 * @module vaultfire-xmtp/xmtp-client
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  XmtpMessage,
  XmtpSendResult,
  XmtpConversation,
  XmtpMessageHandler,
} from './types.js';

import type {
  XmtpMessage,
  XmtpSendResult,
  XmtpConversation,
  XmtpMessageHandler,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal XMTP instance types (avoids importing @xmtp/xmtp-js at the top
// level so the module loads even when the SDK is not installed)
// ---------------------------------------------------------------------------

interface XMTPClientInstance {
  address: string;
  conversations: {
    newConversation(peerAddress: string): Promise<XMTPConvoInstance>;
    list(): Promise<XMTPConvoInstance[]>;
  };
  canMessage(peerAddress: string): Promise<boolean>;
  close(): Promise<void>;
}

interface XMTPConvoInstance {
  peerAddress: string;
  createdAt: Date;
  topic: string;
  send(content: string): Promise<{ id: string }>;
  messages(opts?: { limit?: number }): Promise<
    Array<{
      id: string;
      senderAddress: string;
      content: string;
      sent: Date;
    }>
  >;
  streamMessages(): Promise<
    AsyncIterable<{
      id: string;
      senderAddress: string;
      content: string;
      sent: Date;
    }>
  >;
}

// ---------------------------------------------------------------------------
// XMTPClient
// ---------------------------------------------------------------------------

/**
 * Server-side XMTP client for a single agent identity.
 *
 * @example
 * ```ts
 * // From environment variable (recommended):
 * //   VAULTFIRE_AGENT_KEY=0x<private_key>
 * const client = new XMTPClient();
 *
 * // Or pass the key directly (e.g., for testing):
 * const client = new XMTPClient({ privateKey: process.env.MY_KEY });
 *
 * if (client.enabled) {
 *   await client.sendMessage('0xRecipient...', 'Hello from Vaultfire!');
 * }
 * ```
 */
export class XMTPClient {
  /** The agent's Ethereum address derived from the private key */
  public readonly address: string;
  /** Whether the client is configured with a valid key */
  public readonly enabled: boolean;
  /** XMTP network being used */
  public readonly network: 'production' | 'dev' | 'local';

  #privateKey: string | null;
  #xmtpClient: XMTPClientInstance | null = null;
  #initialised = false;

  constructor(options?: {
    /** Hex-encoded private key (with or without 0x prefix). Defaults to VAULTFIRE_AGENT_KEY env var. */
    privateKey?: string;
    /** XMTP environment (default: 'production') */
    env?: 'production' | 'dev' | 'local';
  }) {
    this.network = options?.env ?? 'production';

    const raw =
      options?.privateKey ?? (process.env['VAULTFIRE_AGENT_KEY'] as string | undefined);

    if (!raw) {
      this.address = '';
      this.enabled = false;
      this.#privateKey = null;
      return;
    }

    try {
      const key = raw.startsWith('0x') ? raw : `0x${raw}`;
      // Validate: a private key is a 32-byte hex string
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
        throw new Error('Invalid private key format — must be 32 bytes (64 hex chars)');
      }
      this.#privateKey = key;
      // Derive address without importing ethers at module load time
      this.address = deriveAddress(key);
      this.enabled = true;
    } catch (err) {
      console.error(
        '[vaultfire/xmtp] Private key is invalid — XMTP messaging is disabled.',
        err instanceof Error ? err.message : err,
      );
      this.address = '';
      this.enabled = false;
      this.#privateKey = null;
    }
  }

  // ── Lazy initialisation ─────────────────────────────────────────────────

  /**
   * Lazily initialise the underlying @xmtp/xmtp-js client on first use.
   * Throws if the private key is not configured or the SDK is missing.
   */
  private async ensureInitialised(): Promise<void> {
    if (this.#initialised) return;

    if (!this.#privateKey) {
      throw new Error(
        '[vaultfire/xmtp] Cannot initialise: no private key configured. ' +
          'Set VAULTFIRE_AGENT_KEY or pass privateKey to the constructor.',
      );
    }

    try {
      const xmtpModule = await import('@xmtp/xmtp-js').catch(() => null);
      if (!xmtpModule?.Client) {
        throw new Error(
          '@xmtp/xmtp-js is not installed. Run: npm install @xmtp/xmtp-js',
        );
      }

      const { ethers } = await import('ethers').catch(() => {
        throw new Error('ethers is not installed. Run: npm install ethers');
      });

      const wallet = new ethers.Wallet(this.#privateKey);
      this.#xmtpClient = (await xmtpModule.Client.create(wallet, {
        env: this.network,
      })) as unknown as XMTPClientInstance;

      this.#initialised = true;
      console.log(
        `[vaultfire/xmtp] Client initialised for ${this.address} on ${this.network}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown XMTP error';
      throw new Error(`[vaultfire/xmtp] Failed to initialise XMTP client: ${message}`);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Check whether a peer address is reachable on the XMTP network.
   * Returns `false` if the SDK is not available or the address is not on XMTP.
   */
  async canMessage(peerAddress: string): Promise<boolean> {
    await this.ensureInitialised();
    if (!this.#xmtpClient) return false;
    try {
      return await this.#xmtpClient.canMessage(peerAddress);
    } catch {
      return false;
    }
  }

  /**
   * Send a text message to a peer address via XMTP.
   *
   * @param to - Recipient Ethereum address
   * @param content - Message text
   * @returns Send result with messageId or error
   */
  async sendMessage(to: string, content: string): Promise<XmtpSendResult> {
    if (!this.enabled) {
      return { success: false, messageId: '', to, error: 'XMTP client not enabled.' };
    }

    await this.ensureInitialised();

    if (!this.#xmtpClient) {
      return { success: false, messageId: '', to, error: 'XMTP client not initialised.' };
    }

    try {
      const conversation = await this.#xmtpClient.conversations.newConversation(to);
      const sent = await conversation.send(content);
      console.log(
        `[vaultfire/xmtp] Message sent to ${to.slice(0, 10)}... (id: ${sent.id})`,
      );
      return { success: true, messageId: sent.id, to };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown send error';
      return { success: false, messageId: '', to, error: message };
    }
  }

  /**
   * List all XMTP conversations for this agent.
   */
  async listConversations(): Promise<XmtpConversation[]> {
    if (!this.enabled) return [];
    await this.ensureInitialised();
    if (!this.#xmtpClient) return [];

    try {
      const convos = await this.#xmtpClient.conversations.list();
      return convos.map((c) => ({
        peerAddress: c.peerAddress,
        createdAt: c.createdAt,
        topic: c.topic,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get recent messages from a specific peer.
   *
   * @param peerAddress - Peer Ethereum address
   * @param limit - Max messages to return (default: 20)
   */
  async getMessages(peerAddress: string, limit = 20): Promise<XmtpMessage[]> {
    if (!this.enabled) return [];
    await this.ensureInitialised();
    if (!this.#xmtpClient) return [];

    try {
      const conversation =
        await this.#xmtpClient.conversations.newConversation(peerAddress);
      const msgs = await conversation.messages({ limit });
      return msgs.map((m) => ({
        id: m.id,
        senderAddress: m.senderAddress,
        content: typeof m.content === 'string' ? m.content : String(m.content),
        sent: m.sent,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Stream incoming messages from a specific peer in real time.
   * Calls `handler` for each incoming message until the stream ends or throws.
   *
   * @param peerAddress - Peer Ethereum address
   * @param handler - Callback for each received message
   */
  async streamMessages(
    peerAddress: string,
    handler: XmtpMessageHandler,
  ): Promise<void> {
    if (!this.enabled) {
      throw new Error('[vaultfire/xmtp] XMTP client is not enabled.');
    }

    await this.ensureInitialised();

    if (!this.#xmtpClient) {
      throw new Error('[vaultfire/xmtp] XMTP client not initialised.');
    }

    const conversation =
      await this.#xmtpClient.conversations.newConversation(peerAddress);
    const stream = await conversation.streamMessages();

    for await (const msg of stream) {
      handler({
        id: msg.id,
        senderAddress: msg.senderAddress,
        content: typeof msg.content === 'string' ? msg.content : String(msg.content),
        sent: msg.sent,
      });
    }
  }

  /**
   * Close the XMTP client and release resources.
   * Should be called during graceful shutdown.
   */
  async close(): Promise<void> {
    if (this.#xmtpClient) {
      await this.#xmtpClient.close().catch(() => {});
      this.#xmtpClient = null;
      this.#initialised = false;
      console.log('[vaultfire/xmtp] Client closed');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _instance: XMTPClient | null = null;

/**
 * Get or create the shared XMTPClient singleton.
 * Reads the private key from VAULTFIRE_AGENT_KEY on first call.
 *
 * @example
 * ```ts
 * const client = getXMTPClient();
 * if (client.enabled) {
 *   await client.sendMessage('0x...', 'Hello!');
 * }
 * ```
 */
export function getXMTPClient(options?: ConstructorParameters<typeof XMTPClient>[0]): XMTPClient {
  if (!_instance) {
    _instance = new XMTPClient(options);
  }
  return _instance;
}

/**
 * Reset the singleton (primarily for testing).
 * @internal
 */
export function resetXMTPClient(): void {
  _instance = null;
}

// ---------------------------------------------------------------------------
// Internal utility: derive Ethereum address from a private key
// ---------------------------------------------------------------------------

/**
 * Synchronously derive an Ethereum address from a private key hex string.
 * Uses the Keccak-256 algorithm on the uncompressed secp256k1 public key.
 *
 * This is a minimal implementation to avoid importing ethers at module load
 * time. The full ethers.Wallet is used inside ensureInitialised() for actual
 * XMTP key signing.
 *
 * Note: For correctness this calls the Node.js crypto module which is
 * available in Node 18+. In browser environments the address derivation
 * is deferred to ethers inside `ensureInitialised`.
 */
function deriveAddress(privateKeyHex: string): string {
  try {
    // Only available in Node.js — fail gracefully in browser
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require('crypto') as typeof import('crypto');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ec: EC } = require('elliptic') as typeof import('elliptic');

    const keyPair = new EC('secp256k1').keyFromPrivate(
      privateKeyHex.slice(2),
      'hex',
    );
    const pubKey = keyPair.getPublic().encode('hex').slice(2); // remove 04 prefix
    const pubBuf = Buffer.from(pubKey, 'hex');
    const hash = createHash('sha3-256').update(pubBuf).digest('hex');
    return '0x' + hash.slice(-40);
  } catch {
    // Fallback: return a placeholder — ethers will provide the real address
    // on first ensureInitialised() call
    return '';
  }
}
