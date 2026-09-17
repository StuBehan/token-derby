import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceRootMissing } from '../../src/tokens/source-root.js';

const codexTokens = vi.fn();
const geminiTokens = vi.fn();

vi.mock('../../src/tokens/transcripts.js', () => ({
  sumTokens: vi.fn(async () => ({ input: 0, output: 0 })),
  sumTokensByConversation: vi.fn(async () => new Map()),
}));
vi.mock('../../src/tokens/codex.js', () => ({
  sumCodexTokens: (...a: unknown[]) => codexTokens(...a),
  sumCodexByConversation: vi.fn(async () => new Map()),
}));
vi.mock('../../src/tokens/gemini.js', () => ({
  sumGeminiTokens: (...a: unknown[]) => geminiTokens(...a),
  sumGeminiByConversation: vi.fn(async () => new Map()),
}));

const { readAllSources, isStall } = await import('../../src/tokens/race-tokens.js');
const { _resetLoggerForTests } = await import('../../src/log/logger.js');
const { logFile } = await import('../../src/paths.js');

let home: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'td-srclog-'));
  process.env.TOKEN_DERBY_HOME = home;
  _resetLoggerForTests();
  codexTokens.mockReset();
  geminiTokens.mockReset();
  geminiTokens.mockResolvedValue({ input: 0, output: 0 });
});

afterEach(async () => {
  if (home) { await fs.rm(home, { recursive: true, force: true }); home = undefined; }
  delete process.env.TOKEN_DERBY_HOME;
  _resetLoggerForTests();
});

function readLog(): string {
  return fsSync.existsSync(logFile()) ? fsSync.readFileSync(logFile(), 'utf8') : '';
}

describe('secondary source failures', () => {
  it('records a real read error that would otherwise score a silent zero', async () => {
    codexTokens.mockRejectedValue(new Error('EACCES: permission denied'));

    const reading = await readAllSources({}, 'claude');

    expect(isStall(reading)).toBe(false); // secondaries never stall the beat
    const text = readLog();
    expect(text).toContain('scan.source.err');
    expect(text).toContain('"source":"codex"');
    expect(text).toContain('EACCES');
  });

  it('stays quiet when a source is simply not installed', async () => {
    // Most machines have only one of the three tools. A line per missing source
    // per beat would bury the failures that matter.
    codexTokens.mockRejectedValue(new SourceRootMissing('/home/me/.codex'));

    await readAllSources({}, 'claude');

    expect(readLog()).not.toContain('scan.source.err');
  });
});
