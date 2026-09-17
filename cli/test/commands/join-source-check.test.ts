import { describe, it, expect, vi } from 'vitest';
import { confirmEmptySource, type SourceProbe } from '../../src/tokens/source-probe.js';

const populated: SourceProbe = { key: 'claude', dir: '/p', exists: true, projects: 1, transcripts: 3 };
const empty: SourceProbe = { key: 'claude', dir: '/p', exists: false, projects: 0, transcripts: 0 };

describe('confirmEmptySource', () => {
  it('proceeds silently when the source has transcripts', async () => {
    const warn = vi.fn();
    const ask = vi.fn();
    await expect(confirmEmptySource({ probe: populated, interactive: true, warn, ask })).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });

  it('warns and proceeds when the player confirms', async () => {
    const warn = vi.fn();
    const ask = vi.fn(async () => true);
    await expect(confirmEmptySource({ probe: empty, interactive: true, warn, ask })).resolves.toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('/p');
  });

  it('aborts the join when the player declines', async () => {
    const warn = vi.fn();
    const ask = vi.fn(async () => false);
    await expect(confirmEmptySource({ probe: empty, interactive: true, warn, ask })).resolves.toBe(false);
  });

  it('warns but never blocks a non-interactive join, which has nobody to answer', async () => {
    const warn = vi.fn();
    const ask = vi.fn();
    await expect(confirmEmptySource({ probe: empty, interactive: false, warn, ask })).resolves.toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  });
});
