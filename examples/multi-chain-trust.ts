/**
 * @file examples/multi-chain-trust.ts
 * @description Multi-Chain Trust Verification
 *
 * Demonstrates how to:
 *   - Verify an agent's trust across all supported chains simultaneously
 *   - Build a ranked trust report with per-chain bond details
 *   - Use isTrustedAgent() with multiChain: true for a single boolean result
 *   - Access raw VaultfireTrustProfile data for custom logic
 *
 * This is useful for applications that want maximum trust coverage — an agent
 * with a bond on any chain is considered trusted, with the highest-value bond
 * winning.
 *
 * Requirements:
 *   npm install @vaultfire/xmtp
 *
 * Usage:
 *   npx ts-node examples/multi-chain-trust.ts
 *
 * @see https://theloopbreaker.com
 */

import {
  verifyVaultfireTrust,
  verifyMultiChainTrust,
  isTrustedAgent,
  calculateBondTier,
  formatWei,
  clearTrustCache,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Example agent addresses to check
// (Replace with real addresses from your deployment)
// ---------------------------------------------------------------------------

const ADDRESSES_TO_CHECK = [
  '0xfA15Ee28939B222B0448261A22156070f0A7813C', // Embris Agent (example)
  '0x0000000000000000000000000000000000000001', // No-bond address (example)
];

// ---------------------------------------------------------------------------
// Single-chain verification
// ---------------------------------------------------------------------------

async function singleChainDemo(address: string): Promise<void> {
  console.log(`\n── Single-Chain Verification (Base) ──`);
  console.log(`Address: ${address}`);

  const profile = await verifyVaultfireTrust(address, 'base');

  console.log(`  Registered:  ${profile.isRegistered}`);
  console.log(`  Has Bond:    ${profile.hasBond}`);
  console.log(`  Bond ID:     #${profile.bondId}`);
  console.log(`  Stake:       ${formatWei(profile.bondAmount)} ETH`);
  console.log(`  Active:      ${profile.bondActive}`);
  console.log(`  Tier:        ${profile.bondTier.toUpperCase()}`);
  console.log(`  Summary:     ${profile.summary}`);
}

// ---------------------------------------------------------------------------
// Multi-chain verification
// ---------------------------------------------------------------------------

async function multiChainDemo(address: string): Promise<void> {
  console.log(`\n── Multi-Chain Verification ──`);
  console.log(`Address: ${address}`);

  const multi = await verifyMultiChainTrust(address);

  console.log(`\n  Best Chain:  ${multi.bestChain}`);
  console.log(`  Best Tier:   ${multi.bestProfile.bondTier.toUpperCase()}`);
  console.log(`  Best Stake:  ${formatWei(multi.bestProfile.bondAmount)} ETH`);

  console.log('\n  Per-Chain Results:');
  console.log('  Chain       | Bond? | Tier     | Amount     | Active');
  console.log('  ------------|-------|----------|------------|--------');

  for (const [chain, profile] of Object.entries(multi.allChains)) {
    const tier = profile.bondTier.padEnd(8);
    const amount = profile.hasBond
      ? formatWei(profile.bondAmount).padEnd(10)
      : '—'.padEnd(10);
    const bond = profile.hasBond ? `#${profile.bondId}` : 'No ';
    const active = profile.bondActive ? 'Yes' : 'No ';
    console.log(`  ${chain.padEnd(11)} | ${bond.padEnd(5)} | ${tier} | ${amount} | ${active}`);
  }
}

// ---------------------------------------------------------------------------
// isTrustedAgent — simple boolean check
// ---------------------------------------------------------------------------

async function trustedAgentDemo(address: string): Promise<void> {
  console.log(`\n── isTrustedAgent Checks ──`);
  console.log(`Address: ${address}`);

  // Single chain
  const trustedBase = await isTrustedAgent(address, 'base');
  const trustedAvax = await isTrustedAgent(address, 'avalanche');

  // Multi-chain (any chain)
  const trustedAny = await isTrustedAgent(address, 'base', '0', true);

  // Silver tier on any chain (0.01 ETH minimum)
  const trustedSilver = await isTrustedAgent(
    address,
    'base',
    '10000000000000000', // 0.01 ETH
    true,
  );

  console.log(`  Trusted on Base:           ${trustedBase}`);
  console.log(`  Trusted on Avalanche:      ${trustedAvax}`);
  console.log(`  Trusted on any chain:      ${trustedAny}`);
  console.log(`  Trusted (silver+, any):    ${trustedSilver}`);
}

// ---------------------------------------------------------------------------
// Bond tier calculation
// ---------------------------------------------------------------------------

function tierCalculationDemo(): void {
  console.log('\n── Bond Tier Thresholds ──');

  const examples = [
    { wei: '0', label: 'No bond' },
    { wei: '1000000000000000', label: '0.001 ETH' },
    { wei: '10000000000000000', label: '0.01 ETH (silver)' },
    { wei: '100000000000000000', label: '0.1 ETH (gold)' },
    { wei: '1000000000000000000', label: '1.0 ETH (platinum)' },
    { wei: '5000000000000000000', label: '5.0 ETH (platinum)' },
  ];

  console.log('  Wei Amount           | Label              | Tier');
  console.log('  ---------------------|--------------------|---------');
  for (const { wei, label } of examples) {
    const tier = calculateBondTier(wei);
    console.log(
      `  ${formatWei(wei)} ETH`.padEnd(22) +
      `| ${label.padEnd(19)}| ${tier}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Vaultfire XMTP — Multi-Chain Trust Verification Demo');
  console.log('=====================================================');

  tierCalculationDemo();

  for (const address of ADDRESSES_TO_CHECK) {
    console.log(`\n${'='.repeat(60)}`);

    // Clear cache to get fresh data for each demo run
    clearTrustCache();

    await singleChainDemo(address);
    await multiChainDemo(address);
    await trustedAgentDemo(address);
  }

  console.log('\n✓ Done');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
