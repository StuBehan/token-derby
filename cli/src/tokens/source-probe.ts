// Answers "can this machine see any transcripts for this source?" without
// parsing a byte of token data. A scan that finds no history is indistinguishable
// from one that finds no WORK, so the race reports 0 either way; probing the
// directory up front turns that silent 0 into something a player can act on.

import type { ModelKey } from '@token-derby/shared';
import * as fs from 'node:fs/promises';
import { claudeProjectsDir, codexSessionsDir, geminiTmpDir } from '../paths.js';
import { listJsonlFiles } from './transcripts.js';
import { listCodexRollouts } from './codex.js';
import { listChatFiles } from './gemini.js';

export type SourceProbe = {
  key: ModelKey;
  dir: string;         // the root that was searched
  exists: boolean;     // whether that root is a directory at all
  projects: number;    // project directories directly beneath it
  transcripts: number; // transcript files found anywhere beneath it
};

const ROOTS: Record<ModelKey, () => string> = {
  claude: claudeProjectsDir,
  codex: codexSessionsDir,
  gemini: geminiTmpDir,
};

// The scanners' own discovery rules, reused rather than restated — a probe that
// disagreed with the scan about what counts would be worse than no probe.
const LISTERS: Record<ModelKey, (root: string) => Promise<string[]>> = {
  claude: listJsonlFiles,
  codex: listCodexRollouts,
  gemini: listChatFiles,
};

const LABELS: Record<ModelKey, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

/** Directory a source reads from, for messages that need to name it. */
export function sourceDir(key: ModelKey): string {
  return ROOTS[key]();
}

/**
 * Look for a source's transcripts. Never throws — an unreadable root reads as
 * empty. `projects` is counted separately so "nothing here" and "plenty here,
 * none of it readable" produce different advice.
 */
export async function probeSource(key: ModelKey): Promise<SourceProbe> {
  const dir = ROOTS[key]();
  const exists = await fs.stat(dir).then(st => st.isDirectory()).catch(() => false);
  if (!exists) return { key, dir, exists: false, projects: 0, transcripts: 0 };
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const projects = entries.filter(e => e.isDirectory() || e.isSymbolicLink()).length;
  const files = await LISTERS[key](dir).catch(() => [] as string[]);
  return { key, dir, exists: true, projects, transcripts: files.length };
}

/** Env var that repoints a source's history directory. */
function overrideVar(key: ModelKey): string {
  return `TOKEN_DERBY_${key.toUpperCase()}_DIR`;
}

/**
 * The join-time gate: warn when the primary source has nothing to count, and let
 * the player decide. Returns whether to go ahead with the join. A non-interactive
 * caller is warned but never blocked — there is nobody there to answer.
 */
export async function confirmEmptySource(opts: {
  probe: SourceProbe;
  interactive: boolean;
  warn: (text: string) => void;
  ask: () => Promise<boolean>;
}): Promise<boolean> {
  if (opts.probe.transcripts > 0) return true;
  opts.warn(describeEmptySource(opts.probe));
  if (!opts.interactive) return true;
  return opts.ask();
}

/** What to tell a player whose primary source has no transcripts to count. */
export function describeEmptySource(probe: SourceProbe): string {
  const label = LABELS[probe.key];
  // A root full of projects that yields no transcripts is a different problem
  // from a root with nothing in it, and wants different advice.
  const populated = probe.exists && probe.projects > 0;
  const reason = !probe.exists
    ? 'does not exist'
    : populated
      ? `holds ${probe.projects} project ${probe.projects === 1 ? 'directory' : 'directories'}, none of which could be read`
      : 'exists, but holds no transcripts';
  const lines = [
    `⚠ No ${label} transcripts found — your horse will not move.`,
    ``,
    `  Looked in: ${probe.dir}`,
    `             (${reason})`,
    ``,
  ];
  if (populated) {
    lines.push(
      `  The directory is there and has history in it, so this is usually a`,
      `  dangling symlink or a permissions problem on one of those projects.`,
      `  To find dangling links:`,
      `    find ${probe.dir} -type l ! -exec test -e {} \\; -print`,
      ``,
    );
  }
  lines.push(
    `  Token Derby counts ${label} usage from this machine's own filesystem.`,
    `  If ${label} runs in a container, over SSH, or on another machine, join`,
    `  the race from there instead.`,
  );
  if (probe.key === 'claude') {
    lines.push(
      `  If CLAUDE_CONFIG_DIR relocated your config, Token Derby follows it —`,
      `  check it points at the config root, not the projects directory.`,
    );
  }
  lines.push(``, `  To read them from somewhere else: export ${overrideVar(probe.key)}=<dir>`);
  return lines.join('\n');
}
