import { MODEL_KEYS, type ModelKey } from '@token-derby/shared';
import { sumTokens, sumTokensByConversation, type TokenTotals } from './transcripts.js';
import { sumCodexTokens, sumCodexByConversation } from './codex.js';
import { sumGeminiTokens, sumGeminiByConversation } from './gemini.js';
import type { ScanProgress } from './scan-progress.js';
import { SourceRootMissing } from './source-root.js';
import { logWarn, logError } from '../log/logger.js';

/** Per-source reading for one beat: the two secondary scalars + the primary, per conversation. */
export type AllSources = {
  secondary: Record<ModelKey, number>; // scored scalar; only the 2 non-primary keys are meaningful
  primaryByConv: Map<string, number>;  // convId → scored value, for the primary source
};

/** A beat that could not be read. `stall` is a human-readable cause for the UI. */
export type StallReading = { stall: string };

/** The result of one scan: either usable numbers or a stall carrying its cause. */
export type BeatReading = AllSources | StallReading;

export function isStall(r: BeatReading): r is StallReading {
  return 'stall' in r;
}

const TIMED_OUT = Symbol('scan-timeout');

/**
 * Run a scan under a time budget. Exceeding it resolves to a stall rather than
 * throwing, so a genuine read error still surfaces its own cause to the caller.
 * `describeTimeout` supplies the stall text, letting the caller name whichever
 * source was still running when the budget ran out.
 */
export async function scanWithTimeout(
  scan: () => Promise<BeatReading>,
  timeoutMs: number,
  describeTimeout?: () => Promise<string> | string,
): Promise<BeatReading> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const startedAt = Date.now();
  try {
    const result = await Promise.race([scan(), budget]);
    if (result !== TIMED_OUT) {
      // Only abnormal beats are logged; the loop already records every beat's duration.
      if (isStall(result)) logWarn('scan.stall', { reason: result.stall, ms: Date.now() - startedAt });
      return result;
    }
    const detail = describeTimeout ? await describeTimeout() : null;
    const stall = detail ?? `Token scan timed out after ${Math.round(timeoutMs / 1000)}s`;
    logWarn('scan.timeout', { budget_ms: timeoutMs, reason: stall });
    return { stall };
  } catch (err) {
    // The caller turns this into a stall reading, which would otherwise leave the
    // log showing a healthy beat while the racer sees a failure on screen.
    logError('scan.error', {
      message: (err as Error)?.message ?? String(err),
      stack: (err as Error)?.stack,
      ms: Date.now() - startedAt,
    });
    throw err;
  } finally {
    clearTimeout(timer); // never let the budget timer outlive the beat
  }
}

const SCALAR_READERS: Record<ModelKey, () => Promise<TokenTotals>> = {
  claude: sumTokens,
  codex: sumCodexTokens,
  gemini: sumGeminiTokens,
};

const BY_CONVERSATION_READERS: Record<ModelKey, () => Promise<Map<string, TokenTotals>>> = {
  claude: sumTokensByConversation,
  codex: sumCodexByConversation,
  gemini: sumGeminiByConversation,
};

/** Collapse a source's totals to a single number in the race's mode. */
export function scoreFor(race: { counts_input?: boolean }, t: TokenTotals): number {
  return race.counts_input ? t.input + t.output : t.output;
}

/**
 * Read all sources for a beat. The PRIMARY source is read per-conversation and is
 * the critical path — a genuine read failure stalls the whole beat and reports its
 * cause. The one exception is a MISSING ROOT (SourceRootMissing): choosing a primary
 * CLI you've never run means it has simply produced 0 tokens, so it reads as empty
 * and must NOT freeze the race. The two secondary sources are scalar and resilient:
 * a failure of any kind contributes 0.
 */
export async function readAllSources(
  race: { counts_input?: boolean },
  primary: ModelKey,
  progress?: ScanProgress,
): Promise<BeatReading> {
  // Every source is kicked off together, so a beat costs the SLOWEST source
  // rather than the sum of all of them. The primary's outcome is captured
  // rather than thrown so a failure there doesn't abandon the secondaries.
  progress?.begin(primary);
  const primaryScan = BY_CONVERSATION_READERS[primary]().then(
    map => ({ ok: true as const, map }),
    (err: any) => ({ ok: false as const, err }),
  ).finally(() => progress?.end(primary));
  const secondaryKeys = MODEL_KEYS.filter(k => k !== primary);
  const secondaryScans = secondaryKeys.map((k) => {
    progress?.begin(k);
    return SCALAR_READERS[k]()
      .then(t => scoreFor(race, t))
      .catch((err) => {
        // An absent root is the normal case — few machines have all three tools —
        // so only a real read error earns a line, or a missing source would write
        // one every beat and bury the failures that matter.
        if (!(err instanceof SourceRootMissing)) {
          logWarn('scan.source.err', { source: k, message: err?.message ?? String(err) });
        }
        return 0;
      })
      .finally(() => progress?.end(k));
  });

  const [primaryResult, secondaryValues] = await Promise.all([
    primaryScan,
    Promise.all(secondaryScans),
  ]);

  const primaryByConv = new Map<string, number>();
  if (primaryResult.ok) {
    for (const [id, totals] of primaryResult.map) primaryByConv.set(id, scoreFor(race, totals));
  } else if (!(primaryResult.err instanceof SourceRootMissing)) {
    // An ABSENT ROOT → treat as empty (0), never a stall. Every other failure is
    // a real read error → stall, carrying the cause so the UI can show it. The
    // distinction matters: a bare ENOENT can come from a dangling symlink deep in
    // the tree, and swallowing that scores 0 for the whole race without a word.
    const err = primaryResult.err;
    return { stall: `Can't read ${primary} token usage: ${err?.message ?? String(err)}` };
  }

  const secondary: Record<ModelKey, number> = { claude: 0, codex: 0, gemini: 0 };
  secondaryKeys.forEach((k, i) => { secondary[k] = secondaryValues[i] ?? 0; });
  return { secondary, primaryByConv };
}
