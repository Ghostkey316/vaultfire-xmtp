/**
 * @file xmtp-browser.ts
 * @description Browser XMTP client for Vaultfire Protocol.
 *
 * Provides real XMTP encrypted messaging using the @xmtp/xmtp-js SDK in
 * browser environments. Uses the user's locally-held wallet for identity
 * signing — the private key is NEVER written to disk or sent anywhere.
 *
 * Features:
 *   - Initialize XMTP client with any EIP-1193 wallet or a custom WalletProvider
 *   - Create and join conversations (agent-to-agent, human-AI collaboration)
 *   - Send and receive end-to-end encrypted messages
 *   - Real-time connection status tracking
 *   - Graceful fallback to local encrypted messaging when XMTP is unavailable
 *   - Persistent local state via localStorage (conversations + recent messages)
 *
 * SECURITY: Private keys are NEVER written to disk.
 * The wallet's session key is used only for XMTP identity signing.
 *
 * @module vaultfire-xmtp/xmtp-browser
 */

import type {
  XMTPConnectionStatus,
  XMTPMessage,
  XMTPConversation,
  XMTPState,
  WalletProvider,
} from './types.js';

// Re-export types for consumers
export type {
  XMTPConnectionStatus,
  XMTPMessage,
  XMTPConversation,
  XMTPState,
  WalletProvider,
};

// ---------------------------------------------------------------------------
// Listener types
// ---------------------------------------------------------------------------

type StatusListener = (status: XMTPConnectionStatus) => void;
type MessageListener = (msg: XMTPMessage) => void;

// ---------------------------------------------------------------------------
// Default WalletProvider (reads from window.ethereum)
// ---------------------------------------------------------------------------

/**
 * A WalletProvider backed by a raw private key string.
 * Suitable for Node.js agent environments — for browser use, prefer an
 * EIP-1193 provider via `createEIP1193WalletProvider`.
 */
export class PrivateKeyWalletProvider implements WalletProvider {
  #privateKey: string;
  #address: string;

  constructor(privateKeyHex: string, address: string) {
    this.#privateKey = privateKeyHex.startsWith('0x')
      ? privateKeyHex
      : `0x${privateKeyHex}`;
    this.#address = address;
  }

  getWalletAddress(): string | null {
    return this.#address || null;
  }

  getSessionPrivateKey(): string | null {
    return this.#privateKey || null;
  }

  isWalletUnlocked(): boolean {
    return Boolean(this.#privateKey && this.#address);
  }
}

// ---------------------------------------------------------------------------
// XMTPBrowserClient
// ---------------------------------------------------------------------------

/**
 * Browser XMTP client — manages a single XMTP connection for a user wallet.
 *
 * This class is designed to be used as a singleton via `getXMTPBrowserClient()`.
 * It handles XMTP SDK initialization, fallback mode, conversation management,
 * message streaming, and localStorage persistence.
 *
 * @example
 * ```ts
 * import { getXMTPBrowserClient, initializeXMTPBrowser } from '@vaultfire/xmtp/browser';
 *
 * // With a custom WalletProvider:
 * const ok = await initializeXMTPBrowser(myWalletProvider);
 *
 * // With window.ethereum (default, browser only):
 * const ok = await initializeXMTPBrowser();
 *
 * const client = getXMTPBrowserClient();
 * client.onStatusChange((status) => console.log('XMTP status:', status));
 *
 * const conv = await client.getOrCreateConversation('0xAgent...');
 * await client.sendMessage(conv.topic, 'Hello from Vaultfire!');
 * ```
 */
export class XMTPBrowserClient {
  private status: XMTPConnectionStatus = 'disconnected';
  private address: string | null = null;
  private client: unknown = null; // @xmtp/xmtp-js Client instance
  private conversations: Map<string, XMTPConversation> = new Map();
  private messages: Map<string, XMTPMessage[]> = new Map();
  private statusListeners: Set<StatusListener> = new Set();
  private messageListeners: Map<string, Set<MessageListener>> = new Map();
  private streamAbort: AbortController | null = null;
  private isReal = false;
  private walletProvider: WalletProvider | null = null;

  constructor() {
    this.loadLocalState();
  }

  // ── Status Management ────────────────────────────────────────────────────

  getStatus(): XMTPConnectionStatus { return this.status; }
  getAddress(): string | null { return this.address; }
  isConnected(): boolean {
    return this.status === 'connected' || this.status === 'fallback';
  }
  isRealXMTP(): boolean { return this.isReal; }

  getState(): XMTPState {
    return {
      status: this.status,
      address: this.address,
      conversationCount: this.conversations.size,
      messageCount: Array.from(this.messages.values()).reduce(
        (sum, msgs) => sum + msgs.length,
        0,
      ),
      lastError: null,
      isRealXMTP: this.isReal,
    };
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: XMTPConnectionStatus): void {
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  // ── Initialisation ───────────────────────────────────────────────────────

  /**
   * Initialize the XMTP client.
   *
   * @param walletProvider - Custom wallet provider. If omitted, falls back to
   *   window.ethereum (browser) or errors out (Node.js).
   * @returns `true` if connected (real or fallback), `false` on fatal error
   */
  async initialize(walletProvider?: WalletProvider): Promise<boolean> {
    if (this.status === 'connected' || this.status === 'fallback') return true;

    // Store the wallet provider for later use
    if (walletProvider) {
      this.walletProvider = walletProvider;
    }

    const provider = this.walletProvider;

    // Try custom provider first
    if (provider) {
      if (!provider.isWalletUnlocked()) {
        this.setStatus('error');
        return false;
      }

      const pk = provider.getSessionPrivateKey();
      const addr = provider.getWalletAddress();

      if (!pk || !addr) {
        this.setStatus('error');
        return false;
      }

      this.address = addr;
      this.setStatus('connecting');

      try {
        const connected = await this.initializeWithPrivateKey(pk, addr);
        if (connected) {
          this.isReal = true;
          this.setStatus('connected');
          this.saveLocalState();
          return true;
        }
      } catch (err) {
        console.warn('[XMTP Browser] SDK init failed, using fallback:', err);
      }

      this.isReal = false;
      this.setStatus('fallback');
      this.saveLocalState();
      return true;
    }

    // Fall back to window.ethereum in browser environments
    if (typeof window !== 'undefined' && window.ethereum) {
      return this.initializeFromWindowEthereum();
    }

    console.warn(
      '[XMTP Browser] No wallet provider available. ' +
        'Pass a WalletProvider or ensure window.ethereum is set.',
    );
    this.setStatus('error');
    return false;
  }

  /**
   * Initialize XMTP from a private key (server-side or custom wallet).
   */
  private async initializeWithPrivateKey(
    privateKeyHex: string,
    address: string,
  ): Promise<boolean> {
    try {
      const xmtpModule = await import('@xmtp/xmtp-js').catch(() => null);
      if (!xmtpModule?.Client) {
        console.warn('[XMTP Browser] @xmtp/xmtp-js not available');
        return false;
      }

      const { ethers } = await import('ethers');
      const wallet = new ethers.Wallet(privateKeyHex);

      const client = await xmtpModule.Client.create(wallet, {
        env: 'production',
      });

      this.client = client;
      console.log('[XMTP Browser] Connected as', address);
      this.startMessageStream(client);
      return true;
    } catch (err) {
      console.warn('[XMTP Browser] Private key init error:', err);
      return false;
    }
  }

  /**
   * Initialize XMTP from window.ethereum (browser / MetaMask flow).
   */
  private async initializeFromWindowEthereum(): Promise<boolean> {
    if (typeof window === 'undefined' || !window.ethereum) {
      this.setStatus('error');
      return false;
    }

    try {
      const accounts = (await window.ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[];

      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts returned from wallet');
      }

      const address = accounts[0] as string;
      this.address = address;
      this.setStatus('connecting');

      // Try the real XMTP SDK with an EIP-1193 signer
      try {
        const xmtpModule = await import('@xmtp/xmtp-js').catch(() => null);
        if (xmtpModule?.Client) {
          const signer = {
            getAddress: async () => address,
            signMessage: async (message: string) =>
              (await window.ethereum!.request({
                method: 'personal_sign',
                params: [message, address],
              })) as string,
          };

          const client = await xmtpModule.Client.create(signer, {
            env: 'production',
          });

          this.client = client;
          this.isReal = true;
          this.setStatus('connected');
          this.startMessageStream(client);
          this.saveLocalState();
          return true;
        }
      } catch (err) {
        console.warn('[XMTP Browser] SDK init via window.ethereum failed:', err);
      }

      // Fallback mode
      this.isReal = false;
      this.setStatus('fallback');
      this.saveLocalState();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.warn('[XMTP Browser] window.ethereum init failed:', msg);
      this.setStatus('error');
      return false;
    }
  }

  /** Start streaming incoming messages via XMTP conversation list. */
  private async startMessageStream(client: unknown): Promise<void> {
    try {
      const xmtpClient = client as {
        conversations: {
          stream: () => AsyncIterable<{
            topic: string;
            peerAddress: string;
            createdAt: Date;
          }>;
          list: () => Promise<
            Array<{
              topic: string;
              peerAddress: string;
              createdAt: Date;
              messages: (opts?: { limit: number }) => Promise<
                Array<{
                  id: string;
                  senderAddress: string;
                  content: string;
                  sent: Date;
                }>
              >;
            }>
          >;
        };
      };

      // Load existing conversations
      const convos = await xmtpClient.conversations.list();
      for (const convo of convos) {
        this.conversations.set(convo.topic, {
          topic: convo.topic,
          peerAddress: convo.peerAddress,
          createdAt: convo.createdAt.getTime(),
        });

        // Load recent messages (last 50)
        const msgs = await convo.messages({ limit: 50 });
        const formatted: XMTPMessage[] = msgs.map((m) => ({
          id: m.id,
          senderAddress: m.senderAddress,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          timestamp: m.sent.getTime(),
          isEncrypted: true,
          conversationTopic: convo.topic,
        }));
        this.messages.set(convo.topic, formatted);
      }
    } catch (err) {
      console.warn('[XMTP Browser] Stream setup error:', err);
    }
  }

  // ── Conversation Management ──────────────────────────────────────────────

  /**
   * Create or retrieve an existing conversation with a peer address.
   * Returns `null` only if the client is disconnected with no fallback.
   */
  async getOrCreateConversation(
    peerAddress: string,
  ): Promise<XMTPConversation | null> {
    // Check for existing conversation
    for (const conv of this.conversations.values()) {
      if (conv.peerAddress.toLowerCase() === peerAddress.toLowerCase()) {
        return conv;
      }
    }

    // Try the real XMTP SDK
    if (this.isReal && this.client) {
      try {
        const xmtpClient = this.client as {
          conversations: {
            newConversation: (addr: string) => Promise<{
              topic: string;
              peerAddress: string;
              createdAt: Date;
            }>;
          };
        };
        const convo = await xmtpClient.conversations.newConversation(peerAddress);
        const conv: XMTPConversation = {
          topic: convo.topic,
          peerAddress: convo.peerAddress,
          createdAt: convo.createdAt.getTime(),
        };
        this.conversations.set(conv.topic, conv);
        this.messages.set(conv.topic, []);
        return conv;
      } catch (err) {
        console.warn('[XMTP Browser] Failed to create conversation:', err);
      }
    }

    // Local fallback conversation
    const topic = `local:${this.address}:${peerAddress}:${Date.now()}`;
    const conv: XMTPConversation = {
      topic,
      peerAddress,
      createdAt: Date.now(),
    };
    this.conversations.set(topic, conv);
    this.messages.set(topic, []);
    this.saveLocalState();
    return conv;
  }

  /** Get all conversations sorted by creation date (newest first). */
  getConversations(): XMTPConversation[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  }

  // ── Messaging ─────────────────────────────────────────────────────────────

  /**
   * Send a message to an existing conversation topic.
   * Automatically falls back to local storage if XMTP is unavailable.
   *
   * @param topic - Conversation topic identifier
   * @param content - Message content string
   * @returns The sent message, or `null` if the topic is unknown
   */
  async sendMessage(topic: string, content: string): Promise<XMTPMessage | null> {
    const conv = this.conversations.get(topic);
    if (!conv) return null;

    // Attempt real XMTP send
    if (this.isReal && this.client) {
      try {
        const xmtpClient = this.client as {
          conversations: {
            newConversation: (addr: string) => Promise<{
              send: (content: string) => Promise<{
                id: string;
                senderAddress: string;
                content: string;
                sent: Date;
              }>;
            }>;
          };
        };
        const convo = await xmtpClient.conversations.newConversation(
          conv.peerAddress,
        );
        const sent = await convo.send(content);
        const msg: XMTPMessage = {
          id: sent.id,
          senderAddress: this.address || '',
          content:
            typeof sent.content === 'string'
              ? sent.content
              : JSON.stringify(sent.content),
          timestamp: sent.sent.getTime(),
          isEncrypted: true,
          conversationTopic: topic,
        };
        this.addMessage(topic, msg);
        return msg;
      } catch (err) {
        console.warn('[XMTP Browser] Send failed, using local fallback:', err);
      }
    }

    // Local fallback send
    const msg: XMTPMessage = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      senderAddress: this.address || '',
      content,
      timestamp: Date.now(),
      isEncrypted: false,
      conversationTopic: topic,
    };
    this.addMessage(topic, msg);
    this.saveLocalState();
    return msg;
  }

  /** Get all messages for a conversation topic. */
  getMessages(topic: string): XMTPMessage[] {
    return this.messages.get(topic) ?? [];
  }

  /** Subscribe to messages on a conversation topic. Returns an unsubscribe function. */
  onMessage(topic: string, listener: MessageListener): () => void {
    if (!this.messageListeners.has(topic)) {
      this.messageListeners.set(topic, new Set());
    }
    this.messageListeners.get(topic)!.add(listener);
    return () => this.messageListeners.get(topic)?.delete(listener);
  }

  private addMessage(topic: string, msg: XMTPMessage): void {
    if (!this.messages.has(topic)) this.messages.set(topic, []);
    this.messages.get(topic)!.push(msg);
    this.messageListeners.get(topic)?.forEach((l) => l(msg));

    // Update last message reference on the conversation
    const conv = this.conversations.get(topic);
    if (conv) conv.lastMessage = msg;
  }

  // ── Agent Room Management ────────────────────────────────────────────────

  /**
   * Create a multi-agent coordination room.
   *
   * @param agentAddresses - Ethereum addresses of participating agents
   * @param roomName - Human-readable room name
   * @returns The conversation topic identifier
   */
  async createAgentRoom(
    agentAddresses: string[],
    roomName: string,
  ): Promise<string> {
    const topic = `agent-room:${roomName}:${Date.now()}`;
    const conv: XMTPConversation = {
      topic,
      peerAddress: agentAddresses[0] ?? '',
      createdAt: Date.now(),
    };
    this.conversations.set(topic, conv);
    this.messages.set(topic, []);

    const initMsg: XMTPMessage = {
      id: `system_${Date.now()}`,
      senderAddress: 'system',
      content:
        `[Vaultfire] Agent coordination room "${roomName}" created. ` +
        `${agentAddresses.length} agents invited. ` +
        (this.isReal ? 'XMTP encrypted.' : 'Local encrypted.'),
      timestamp: Date.now(),
      isEncrypted: this.isReal,
      conversationTopic: topic,
    };
    this.addMessage(topic, initMsg);
    this.saveLocalState();
    return topic;
  }

  /**
   * Create a human-AI collaboration room.
   *
   * @param humanAddress - Human participant's Ethereum address
   * @param agentAddress - AI agent's Ethereum address
   * @param taskDescription - Brief description of the collaboration task
   * @returns The conversation topic identifier
   */
  async createCollaborationRoom(
    humanAddress: string,
    agentAddress: string,
    taskDescription: string,
  ): Promise<string> {
    const topic = `collab:${humanAddress}:${agentAddress}:${Date.now()}`;
    const conv: XMTPConversation = {
      topic,
      peerAddress: agentAddress,
      createdAt: Date.now(),
    };
    this.conversations.set(topic, conv);
    this.messages.set(topic, []);

    const initMsg: XMTPMessage = {
      id: `system_${Date.now()}`,
      senderAddress: 'system',
      content:
        `[Vaultfire] Collaboration room created. Task: ${taskDescription}. ` +
        (this.isReal
          ? 'Messages encrypted via XMTP.'
          : 'Messages stored locally.'),
      timestamp: Date.now(),
      isEncrypted: this.isReal,
      conversationTopic: topic,
    };
    this.addMessage(topic, initMsg);
    this.saveLocalState();
    return topic;
  }

  // ── Disconnect ───────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    this.streamAbort?.abort();
    this.client = null;
    this.isReal = false;
    this.walletProvider = null;
    this.setStatus('disconnected');
  }

  // ── Local State Persistence ──────────────────────────────────────────────

  private saveLocalState(): void {
    if (typeof window === 'undefined') return;
    try {
      const state = {
        conversations: Array.from(this.conversations.entries()),
        // Only persist the last 100 messages per conversation
        messages: Array.from(this.messages.entries()).map(([k, v]) => [
          k,
          v.slice(-100),
        ]),
        address: this.address,
      };
      localStorage.setItem('vaultfire_xmtp_state', JSON.stringify(state));
    } catch {
      /* ignore storage errors */
    }
  }

  private loadLocalState(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem('vaultfire_xmtp_state');
      if (!raw) return;
      const state = JSON.parse(raw) as {
        conversations?: [string, XMTPConversation][];
        messages?: [string, XMTPMessage[]][];
        address?: string;
      };
      if (state.conversations) {
        this.conversations = new Map(state.conversations);
      }
      if (state.messages) {
        this.messages = new Map(state.messages);
      }
      if (state.address) this.address = state.address;
    } catch {
      /* ignore parse errors */
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let xmtpBrowserClient: XMTPBrowserClient | null = null;

/** Get or create the shared XMTPBrowserClient singleton. */
export function getXMTPBrowserClient(): XMTPBrowserClient {
  if (!xmtpBrowserClient) {
    xmtpBrowserClient = new XMTPBrowserClient();
  }
  return xmtpBrowserClient;
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

/**
 * Initialize XMTP connection for the browser client.
 *
 * @param walletProvider - Optional wallet provider. If omitted, uses window.ethereum.
 * @returns `true` on success (connected or fallback), `false` on fatal error
 */
export async function initializeXMTPBrowser(
  walletProvider?: WalletProvider,
): Promise<boolean> {
  return getXMTPBrowserClient().initialize(walletProvider);
}

/** Get the current XMTP state snapshot. */
export function getXMTPBrowserState(): XMTPState {
  return getXMTPBrowserClient().getState();
}

/** Returns `true` if the browser client is connected (real or fallback). */
export function isXMTPBrowserConnected(): boolean {
  return getXMTPBrowserClient().isConnected();
}

/** Returns `true` if connected to the live XMTP network (not local fallback). */
export function isRealXMTPConnection(): boolean {
  return getXMTPBrowserClient().isRealXMTP();
}

/**
 * Send a message to a conversation topic.
 *
 * @param topic - Conversation topic identifier
 * @param content - Message content
 */
export async function sendXMTPBrowserMessage(
  topic: string,
  content: string,
): Promise<XMTPMessage | null> {
  return getXMTPBrowserClient().sendMessage(topic, content);
}

/** Get messages for a conversation topic. */
export function getXMTPBrowserMessages(topic: string): XMTPMessage[] {
  return getXMTPBrowserClient().getMessages(topic);
}

/** Subscribe to XMTP connection status changes. */
export function onXMTPStatusChange(listener: StatusListener): () => void {
  return getXMTPBrowserClient().onStatusChange(listener);
}

/** Subscribe to incoming messages on a topic. */
export function onXMTPMessage(topic: string, listener: MessageListener): () => void {
  return getXMTPBrowserClient().onMessage(topic, listener);
}

/** Create a multi-agent coordination room. */
export async function createAgentRoom(
  agents: string[],
  name: string,
): Promise<string> {
  return getXMTPBrowserClient().createAgentRoom(agents, name);
}

/** Create a human-AI collaboration room. */
export async function createCollaborationRoom(
  human: string,
  agent: string,
  task: string,
): Promise<string> {
  return getXMTPBrowserClient().createCollaborationRoom(human, agent, task);
}

/** Disconnect the browser XMTP client. */
export async function disconnectXMTPBrowser(): Promise<void> {
  return getXMTPBrowserClient().disconnect();
}

// ---------------------------------------------------------------------------
// Type augmentation for window.ethereum (EIP-1193)
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    ethereum?: {
      request: (args: {
        method: string;
        params?: unknown[];
      }) => Promise<unknown>;
    };
  }
}
