import { describe, it, expect } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { putClaim, getClaim, markClaimRedeemed, listClaims } from '../../src/db/claims.js';
import { generateClaimCode } from '../../src/lib/claim-code.js';
import { ddb, TABLE } from '../../src/db/client.js';
import { claimKey } from '../../src/db/keys.js';

function future(days = 30): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function putRawLegacyClaim(code: string, fields: Record<string, unknown>) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...claimKey(code),
      code,
      item_type: 'hat',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'admin',
      expires_at: future(),
      ...fields,
    },
  }));
}

async function seed(overrides: Partial<Parameters<typeof putClaim>[0]> = {}) {
  return putClaim({
    code: generateClaimCode(),
    item_type: 'hat',
    entries: [{ hat_id: 'flat_cap', variant: 0 }],
    max_redemptions: 1,
    expires_at: future(),
    created_by: 'admin',
    ...overrides,
  });
}

describe('claim persistence', () => {
  it('round-trips a claim', async () => {
    const created = await seed();
    const read = await getClaim(created.code);
    expect(read?.entries[0]).toEqual({ hat_id: 'flat_cap', variant: 0 });
    expect(read?.item_type).toBe('hat');
    expect(read?.redeemed_at).toBeUndefined();
  });

  it('omits variant entirely for a legendary claim', async () => {
    const created = await seed({ entries: [{ hat_id: 'rainbow_crown' }] });
    const read = await getClaim(created.code);
    expect(read).not.toBeNull();
    expect('variant' in (read?.entries[0] as object)).toBe(false);
  });

  it('returns null for an unknown code', async () => {
    expect(await getClaim(generateClaimCode())).toBeNull();
  });

  it('stamps a redemption and reports success', async () => {
    const created = await seed();
    const ok = await markClaimRedeemed(created.code, {
      redeemed_by: 'u-1',
      redeemed_by_name: 'Omar',
      redeemed_horse_id: 'sh-1',
      redeemed_horse_name: 'Gary',
      outcome: 'hat',
    });
    expect(ok).toBe(true);
    const read = await getClaim(created.code);
    expect(read?.redeemed_by).toBe('u-1');
    expect(read?.redeemed_horse_name).toBe('Gary');
    expect(read?.outcome).toBe('hat');
    expect(read?.redeemed_at).toBeTruthy();
  });

  it('refuses a second redemption', async () => {
    const created = await seed();
    const first = await markClaimRedeemed(created.code, {
      redeemed_by: 'u-1', redeemed_horse_id: 'sh-1', outcome: 'hat',
    });
    const second = await markClaimRedeemed(created.code, {
      redeemed_by: 'u-2', redeemed_horse_id: 'sh-2', outcome: 'hat',
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    const read = await getClaim(created.code);
    expect(read?.redeemed_by).toBe('u-1');
  });

  it('lets exactly one of ten concurrent redemptions win', async () => {
    const created = await seed();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        markClaimRedeemed(created.code, {
          redeemed_by: `u-${i}`, redeemed_horse_id: `sh-${i}`, outcome: 'hat',
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('reports false for an unknown code', async () => {
    const ok = await markClaimRedeemed(generateClaimCode(), {
      redeemed_by: 'u-1', redeemed_horse_id: 'sh-1', outcome: 'hat',
    });
    expect(ok).toBe(false);
  });

  it('lists created claims', async () => {
    const a = await seed();
    const b = await seed();
    const codes = (await listClaims()).map(c => c.code);
    expect(codes).toContain(a.code);
    expect(codes).toContain(b.code);
  });
});

describe('pack claims', () => {
  it('round-trips entries and a redemption limit', async () => {
    const created = await putClaim({
      code: generateClaimCode(),
      item_type: 'hat',
      entries: [{ hat_id: 'flat_cap', variant: 0 }, { hat_id: 'beanie' }],
      max_redemptions: 10,
      expires_at: future(),
      created_by: 'admin',
    });
    const read = await getClaim(created.code);
    expect(read?.entries).toEqual([{ hat_id: 'flat_cap', variant: 0 }, { hat_id: 'beanie' }]);
    expect(read?.max_redemptions).toBe(10);
    expect(read?.redeemed_count).toBe(0);
  });

  it('normalises an unredeemed legacy row into a one-entry pack', async () => {
    const code = generateClaimCode();
    await putRawLegacyClaim(code, { hat_id: 'flat_cap', variant: 2 });
    const read = await getClaim(code);
    expect(read?.entries).toEqual([{ hat_id: 'flat_cap', variant: 2 }]);
    expect(read?.max_redemptions).toBe(1);
    expect(read?.redeemed_count).toBe(0);
  });

  it('normalises an already-redeemed legacy row as fully spent', async () => {
    const code = generateClaimCode();
    await putRawLegacyClaim(code, { hat_id: 'flat_cap', variant: 0, redeemed_at: '2026-01-01T00:00:00.000Z' });
    const read = await getClaim(code);
    expect(read?.redeemed_count).toBe(1);
    expect(read?.max_redemptions).toBe(1);
  });

  it('normalises a legacy row with no variant', async () => {
    const code = generateClaimCode();
    await putRawLegacyClaim(code, { hat_id: 'rainbow_crown' });
    const read = await getClaim(code);
    expect(read?.entries).toEqual([{ hat_id: 'rainbow_crown' }]);
  });
});
