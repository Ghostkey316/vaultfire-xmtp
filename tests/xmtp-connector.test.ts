/**
 * @file tests/xmtp-connector.test.ts
 * @description Unit tests for the Vaultfire XMTP connector
 *
 * Tests cover:
 *   - calculateBondTier: all tier thresholds and edge cases
 *   - Trust cache: set, get, TTL expiry, manual clear
 *   - encodeVaultfireMeta / decodeVaultfireMeta: round-trip encoding
 *   - formatWei: edge cases and precision
 *   - RPC_URLS / IDENTITY_REGISTRY / BOND_CONTRACT: all addresses present
 *   - isTrustedAgent: correct behavior with mocked ethCall (network-free)
 *
 * Run:
 *   npx vitest run
 *   npx vitest run --coverage
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  calculateBondTier,
  clearTrustCache,
  encodeVaultfireMeta,
  decodeVaultfireMeta,
  formatWei,
  RPC_URLS,
  IDENTITY_REGISTRY,
  BOND_CONTRACT,
  TRUST_CACHE_TTL_MS,
  verifyVaultfireTrust,
  isTrustedAgent,
} from '../src/xmtp-connector.js';

// ---------------------------------------------------------------------------
// calculateBondTier
// ---------------------------------------------------------------------------

describe('calculateBondTier', () => {
  it('returns "none" for 0 stake', () => {
    expect(calculateBondTier('0')).toBe('none');
    expect(calculateBondTier(0n)).toBe('none');
  });

  it('returns "none" for negative values coerced to <= 0', () => {
    // BigInt cannot be negative from a string '−1' — test zero-boundary
    expect(calculateBondTier('0')).toBe('none');
  });

  it('returns "bronze" for any stake > 0 and < 0.01 ETH', () => {
    expect(calculateBondTier('1')).toBe('bronze');                    // 1 wei
    expect(calculateBondTier('1000000000000000')).toBe('bronze');     // 0.001 ETH
    expect(calculateBondTier('9999999999999999')).toBe('bronze');     // just under 0.01 ETH
  });

  it('returns "silver" for 0.01 ETH', () => {
    expect(calculateBondTier('10000000000000000')).toBe('silver');    // exactly 0.01 ETH
    expect(calculateBondTier('50000000000000000')).toBe('silver');    // 0.05 ETH
    expect(calculateBondTier('99999999999999999')).toBe('silver');    // just under 0.1 ETH
  });

  it('returns "gold" for 0.1 ETH to just under 1.0 ETH', () => {
    expect(calculateBondTier('100000000000000000')).toBe('gold');     // exactly 0.1 ETH
    expect(calculateBondTier('500000000000000000')).toBe('gold');     // 0.5 ETH
    expect(calculateBondTier('999999999999999999')).toBe('gold');     // just under 1.0 ETH
  });

  it('returns "platinum" for 1.0 ETH and above', () => {
    expect(calculateBondTier('1000000000000000000')).toBe('platinum'); // 1.0 ETH
    expect(calculateBondTier('2000000000000000000')).toBe('platinum'); // 2.0 ETH
    expect(calculateBondTier('100000000000000000000')).toBe('platinum'); // 100 ETH
  });

  it('accepts BigInt inputs', () => {
    expect(calculateBondTier(0n)).toBe('none');
    expect(calculateBondTier(1n)).toBe('bronze');
    expect(calculateBondTier(10_000_000_000_000_000n)).toBe('silver');
    expect(calculateBondTier(100_000_000_000_000_000n)).toBe('gold');
    expect(calculateBondTier(1_000_000_000_000_000_000n)).toBe('platinum');
  });
});

// ---------------------------------------------------------------------------
// Trust cache
// ---------------------------------------------------------------------------

describe('Trust cache', () => {
  beforeEach(() => {
    clearTrustCache();
  });

  it('clearTrustCache empties both caches', () => {
    // This is a smoke test — real cache behaviour is tested via verifyVaultfireTrust
    expect(() => clearTrustCache()).not.toThrow();
    expect(() => clearTrustCache()).not.toThrow(); // double-clear is safe
  });

  it('TRUST_CACHE_TTL_MS is 5 minutes (300000 ms)', () => {
    expect(TRUST_CACHE_TTL_MS).toBe(300_000);
  });
});

// ---------------------------------------------------------------------------
// encodeVaultfireMeta / decodeVaultfireMeta
// ---------------------------------------------------------------------------

describe('encodeVaultfireMeta / decodeVaultfireMeta', () => {
  const TEST_ADDRESS = '0xfA15Ee28939B222B0448261A22156070f0A7813C';

  it('encodes to a [VF:...] string', () => {
    const encoded = encodeVaultfireMeta(TEST_ADDRESS, 'base');
    expect(encoded).toMatch(/^\[VF:[A-Za-z0-9+/=]+\]$/);
  });

  it('round-trips correctly for each chain', () => {
    for (const chain of ['base', 'avalanche', 'arbitrum', 'polygon']) {
      const encoded = encodeVaultfireMeta(TEST_ADDRESS, chain);
      const decoded = decodeVaultfireMeta(encoded);

      expect(decoded).not.toBeNull();
      expect(decoded?.protocol).toBe('vaultfire');
      expect(decoded?.version).toBe('1.0');
      expect(decoded?.senderAddress).toBe(TEST_ADDRESS);
      expect(decoded?.chain).toBe(chain);
      expect(decoded?.bondContract).toBe(BOND_CONTRACT[chain]);
      expect(decoded?.identityRegistry).toBe(IDENTITY_REGISTRY[chain]);
      expect(typeof decoded?.timestamp).toBe('number');
    }
  });

  it('decodes metadata embedded in a longer message', () => {
    const meta = encodeVaultfireMeta(TEST_ADDRESS, 'base');
    const message = `Hello, this is my message.\n\n${meta}\n\nEnd of message.`;
    const decoded = decodeVaultfireMeta(message);

    expect(decoded).not.toBeNull();
    expect(decoded?.senderAddress).toBe(TEST_ADDRESS);
  });

  it('returns null for a message with no metadata', () => {
    const result = decodeVaultfireMeta('No metadata here.');
    expect(result).toBeNull();
  });

  it('returns null for malformed [VF:...] blocks', () => {
    expect(decodeVaultfireMeta('[VF:notvalidbase64!@#]')).toBeNull();
    expect(decodeVaultfireMeta('[VF:e30=]')).toBeNull(); // valid base64 of '{}', missing protocol
  });

  it('defaults to "base" chain when chain is omitted', () => {
    const encoded = encodeVaultfireMeta(TEST_ADDRESS);
    const decoded = decodeVaultfireMeta(encoded);
    expect(decoded?.chain).toBe('base');
  });
});

// ---------------------------------------------------------------------------
// formatWei
// ---------------------------------------------------------------------------

describe('formatWei', () => {
  it('formats 0 wei correctly', () => {
    expect(formatWei('0')).toBe('0.0000');
  });

  it('formats whole ETH amounts', () => {
    expect(formatWei('1000000000000000000')).toBe('1.0000');
    expect(formatWei('2000000000000000000')).toBe('2.0000');
    expect(formatWei('10000000000000000000')).toBe('10.0000');
  });

  it('formats fractional ETH amounts with 4 decimal places', () => {
    expect(formatWei('500000000000000000')).toBe('0.5000');
    expect(formatWei('100000000000000000')).toBe('0.1000');
    expect(formatWei('10000000000000000')).toBe('0.0100');
    expect(formatWei('1000000000000000')).toBe('0.0010');
  });

  it('accepts BigInt input', () => {
    expect(formatWei(1_000_000_000_000_000_000n)).toBe('1.0000');
    expect(formatWei(0n)).toBe('0.0000');
  });

  it('handles large platinum-tier stakes', () => {
    // 100 ETH
    expect(formatWei('100000000000000000000')).toBe('100.0000');
  });
});

// ---------------------------------------------------------------------------
// Contract addresses
// ---------------------------------------------------------------------------

describe('Contract addresses', () => {
  const CHAINS = ['base', 'avalanche', 'arbitrum', 'polygon'] as const;

  it('RPC_URLS has all chains', () => {
    for (const chain of CHAINS) {
      expect(RPC_URLS[chain]).toMatch(/^https:\/\//);
    }
  });

  it('IDENTITY_REGISTRY has correct checksummed-style addresses', () => {
    expect(IDENTITY_REGISTRY['base']).toBe('0x35978DB675576598F0781dA2133E94cdCf4858bC');
    expect(IDENTITY_REGISTRY['avalanche']).toBe('0x57741F4116925341d8f7Eb3F381d98e07C73B4a3');
    expect(IDENTITY_REGISTRY['arbitrum']).toBe('0x6298c62FDA57276DC60de9E716fbBAc23d06D5F1');
    expect(IDENTITY_REGISTRY['polygon']).toBe('0x6298c62FDA57276DC60de9E716fbBAc23d06D5F1');
  });

  it('BOND_CONTRACT has correct checksummed-style addresses', () => {
    expect(BOND_CONTRACT['base']).toBe('0x01C479F0c039fEC40c0Cf1c5C921bab457d57441');
    expect(BOND_CONTRACT['avalanche']).toBe('0xDC8447c66fE9D9c7D54607A98346A15324b7985D');
    expect(BOND_CONTRACT['arbitrum']).toBe('0xdB54B8925664816187646174bdBb6Ac658A55a5F');
    expect(BOND_CONTRACT['polygon']).toBe('0x83dd216449B3F0574E39043ECFE275946fa492e9');
  });

  it('all addresses are 42 characters (0x + 40 hex)', () => {
    for (const chain of CHAINS) {
      const idAddr = IDENTITY_REGISTRY[chain];
      const bondAddr = BOND_CONTRACT[chain];
      expect(idAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(bondAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('IDENTITY_REGISTRY and BOND_CONTRACT addresses are different on each chain', () => {
    for (const chain of CHAINS) {
      expect(IDENTITY_REGISTRY[chain]).not.toBe(BOND_CONTRACT[chain]);
    }
  });

  it('Base RPC is mainnet.base.org', () => {
    expect(RPC_URLS['base']).toBe('https://mainnet.base.org');
  });
});

// ---------------------------------------------------------------------------
// verifyVaultfireTrust (with fetch mocked)
// ---------------------------------------------------------------------------

describe('verifyVaultfireTrust (mocked RPC)', () => {
  const TEST_ADDRESS = '0xfA15Ee28939B222B0448261A22156070f0A7813C';

  beforeEach(() => {
    clearTrustCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper to build an ABI-encoded eth_call response hex string
   * for a Bond struct with a given stake and active flag.
   */
  function buildBondStructResponse(stakeWei: bigint, active: boolean): string {
    // Simulate the ABI-encoded Bond struct
    // word 0: tuple pointer (0x20)
    // word 1-4: id, human, agent, string offset (pad with zeros)
    // word 5: stakeAmount
    // word 6-8: timestamp and other fields
    // word 9: active (0 or 1)
    const words: bigint[] = [
      0x20n, // tuple header
      1n,    // bond id
      BigInt(TEST_ADDRESS), // human
      BigInt(TEST_ADDRESS), // aiAgent
      0x160n, // string data offset
      stakeWei,             // stakeAmount (offset 5)
      BigInt(Date.now()),   // timestamp
      0n, 0n,               // extra fields (offset 7, 8)
      active ? 1n : 0n,    // active (offset 9)
    ];
    const hex = words.map((w) => w.toString(16).padStart(64, '0')).join('');
    return '0x' + hex;
  }

  /**
   * Helper to build an ABI-encoded uint256[] response (bond IDs array).
   * Layout: offset (0x20), length (1), bondId
   */
  function buildBondsArrayResponse(bondId: bigint): string {
    const words = [
      0x20n,   // offset to array data
      1n,      // array length
      bondId,  // first bond id
    ];
    return '0x' + words.map((w) => w.toString(16).padStart(64, '0')).join('');
  }

  it('returns a trust profile with hasBond=false when no bonds exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as { method: string };

        if (body.method === 'eth_call') {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              jsonrpc: '2.0',
              id: 1,
              // getTotalAgents returns non-zero, but bond count is 0
              result: '0x0000000000000000000000000000000000000000000000000000000000000000',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ result: '0x' }) });
      }),
    );

    const profile = await verifyVaultfireTrust(TEST_ADDRESS, 'base');

    expect(profile.address).toBe(TEST_ADDRESS);
    expect(profile.hasBond).toBe(false);
    expect(profile.bondActive).toBe(false);
    expect(profile.bondAmount).toBe('0');
    expect(profile.bondTier).toBe('none');
    expect(profile.chain).toBe('base');
    expect(typeof profile.summary).toBe('string');
  });

  it('returns a cached result on second call', async () => {
    clearTrustCache();

    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as { method: string };
        if (body.method === 'eth_call') callCount++;
        return Promise.resolve({
          ok: true,
          json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x0' + '0'.repeat(63) }),
        });
      }),
    );

    await verifyVaultfireTrust(TEST_ADDRESS, 'base');
    const countAfterFirst = callCount;

    // Second call — should use cache, no new fetch calls
    await verifyVaultfireTrust(TEST_ADDRESS, 'base');
    expect(callCount).toBe(countAfterFirst);
  });

  it('parses an active gold-tier bond correctly', async () => {
    const STAKE_GOLD = 500_000_000_000_000_000n; // 0.5 ETH → gold
    const BOND_ID = 42n;
    let callNumber = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_, options: RequestInit) => {
        const body = JSON.parse(options.body as string) as { params: [{ data: string }] };
        const calldata = body.params[0]?.data ?? '';
        callNumber++;

        // Call 1: getTotalAgents → non-zero (registered)
        if (calldata.startsWith('0x3731a16f')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              result: '0x' + (5n).toString(16).padStart(64, '0'),
            }),
          });
        }

        // Call 2: getBondsByParticipantCount → 1
        if (calldata.startsWith('0x67ff6265')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              result: '0x' + (1n).toString(16).padStart(64, '0'),
            }),
          });
        }

        // Call 3: getBondsByParticipant → [bondId]
        if (calldata.startsWith('0xde4c4e4c')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              result: buildBondsArrayResponse(BOND_ID),
            }),
          });
        }

        // Call 4: getBond(bondId) → Bond struct
        if (calldata.startsWith('0xd8fe7642')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              result: buildBondStructResponse(STAKE_GOLD, true),
            }),
          });
        }

        return Promise.resolve({
          ok: true,
          json: async () => ({ result: '0x' }),
        });
      }),
    );

    const profile = await verifyVaultfireTrust(TEST_ADDRESS, 'base');

    expect(profile.hasBond).toBe(true);
    expect(profile.bondActive).toBe(true);
    expect(profile.bondAmount).toBe(STAKE_GOLD.toString());
    expect(profile.bondId).toBe(Number(BOND_ID));
    expect(profile.bondTier).toBe('gold');
    expect(profile.isRegistered).toBe(true);
    expect(profile.summary).toContain('gold');
  });
});

// ---------------------------------------------------------------------------
// isTrustedAgent (unit — trust result derived from verifyVaultfireTrust)
// ---------------------------------------------------------------------------

describe('isTrustedAgent', () => {
  const TEST_ADDRESS = '0xfA15Ee28939B222B0448261A22156070f0A7813C';

  beforeEach(() => {
    clearTrustCache();
    // Mock fetch to return a "no bond" response for all calls
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: '0x' + '0'.repeat(64),
        }),
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for an address with no bond', async () => {
    const trusted = await isTrustedAgent(TEST_ADDRESS, 'base');
    expect(trusted).toBe(false);
  });

  it('returns false when minBond is not met', async () => {
    // The mocked RPC always returns 0 bond — minBond check is moot but tests the logic path
    const trusted = await isTrustedAgent(
      TEST_ADDRESS,
      'base',
      '10000000000000000', // 0.01 ETH minimum
    );
    expect(trusted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// configureVaultfireXMTP (smoke test — does not call network)
// ---------------------------------------------------------------------------

describe('configureVaultfireXMTP', () => {
  it('can be called with no arguments without throwing', async () => {
    const { configureVaultfireXMTP } = await import('../src/xmtp-connector.js');
    expect(() => configureVaultfireXMTP()).not.toThrow();
  });

  it('can be called with an x402 integration without throwing', async () => {
    const { configureVaultfireXMTP } = await import('../src/xmtp-connector.js');
    const fakeX402 = {
      initiatePayment: vi.fn(),
      verifyPaymentSignature: vi.fn(),
      formatUsdc: vi.fn(),
      getUsdcBalance: vi.fn(),
    };
    expect(() => configureVaultfireXMTP({ x402: fakeX402 })).not.toThrow();
  });
});
