import type { ApiHandler } from '../lib/http.js';
import type { ClaimEntry, CreateClaimRequest, CreateClaimResponse } from '@token-derby/shared';
import {
  hatById,
  isAnimatedHat,
  DEFAULT_CLAIM_EXPIRY_DAYS,
  MAX_CLAIM_EXPIRY_DAYS,
  MAX_PACK_ENTRIES,
  MAX_CLAIM_REDEMPTIONS,
} from '@token-derby/shared';
import { requireAdmin } from '../lib/admin-auth.js';
import { loadAdminConfig } from '../lib/admin-config.js';
import { generateClaimCode } from '../lib/claim-code.js';
import { putClaim } from '../db/claims.js';
import { ok, err, parseJson } from '../lib/http.js';

export const handler: ApiHandler = async (event) => {
  const cfg = await loadAdminConfig();
  const auth = requireAdmin(event, cfg.sessionSecret);
  if (!auth.ok) return err('UNAUTHENTICATED', 'Admin session required');

  const body = parseJson<CreateClaimRequest>(event.body);
  if (!body) return err('BAD_REQUEST', 'JSON body required');
  if (body.item_type !== 'hat') return err('BAD_REQUEST', "item_type must be 'hat'");

  // Legacy callers send a single hat; lift it so there is one code path below.
  const entries: ClaimEntry[] = Array.isArray(body.entries)
    ? body.entries
    : body.hat_id
      ? [body.variant !== undefined ? { hat_id: body.hat_id, variant: body.variant } : { hat_id: body.hat_id }]
      : [];

  if (entries.length === 0) return err('BAD_REQUEST', 'entries must contain at least one hat');
  if (entries.length > MAX_PACK_ENTRIES) {
    return err('BAD_REQUEST', `entries may contain at most ${MAX_PACK_ENTRIES} hats`);
  }

  for (const entry of entries) {
    const hat = hatById(entry.hat_id);
    if (!hat) return err('BAD_REQUEST', `Unknown hat_id: ${entry.hat_id}`);
    if (isAnimatedHat(hat)) {
      if (entry.variant !== undefined) {
        return err('BAD_REQUEST', `${entry.hat_id} is a single-design hat and has no variants`);
      }
    } else if (entry.variant !== undefined) {
      if (!Number.isInteger(entry.variant) || entry.variant < 0 || entry.variant >= hat.variants.length) {
        return err('BAD_REQUEST', `variant out of range for ${entry.hat_id} (have ${hat.variants.length})`);
      }
    }
  }

  const max_redemptions = body.max_redemptions ?? 1;
  if (!Number.isInteger(max_redemptions) || max_redemptions < 1 || max_redemptions > MAX_CLAIM_REDEMPTIONS) {
    return err('BAD_REQUEST', `max_redemptions must be an integer 1..${MAX_CLAIM_REDEMPTIONS}`);
  }

  const days = body.expires_in_days ?? DEFAULT_CLAIM_EXPIRY_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_CLAIM_EXPIRY_DAYS) {
    return err('BAD_REQUEST', `expires_in_days must be an integer 1..${MAX_CLAIM_EXPIRY_DAYS}`);
  }

  const record = await putClaim({
    code: generateClaimCode(),
    item_type: 'hat',
    entries,
    max_redemptions,
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
    created_by: 'admin',
  });

  const response: CreateClaimResponse = {
    code: record.code,
    item_type: record.item_type,
    entries: record.entries,
    max_redemptions: record.max_redemptions,
    expires_at: record.expires_at,
  };
  return ok(response);
};
