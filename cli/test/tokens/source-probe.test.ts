import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeSource, describeEmptySource } from '../../src/tokens/source-probe.js';

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  delete process.env.TOKEN_DERBY_CLAUDE_DIR;
  delete process.env.TOKEN_DERBY_CODEX_DIR;
  delete process.env.TOKEN_DERBY_GEMINI_DIR;
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('probeSource', () => {
  it('reports a missing claude directory as absent with no transcripts', async () => {
    const gone = path.join(os.tmpdir(), 'td-probe-missing-' + Math.random());
    process.env.TOKEN_DERBY_CLAUDE_DIR = gone;
    const probe = await probeSource('claude');
    expect(probe).toMatchObject({ key: 'claude', dir: gone, exists: false, projects: 0, transcripts: 0 });
  });

  it('distinguishes an existing but empty claude directory from a missing one', async () => {
    process.env.TOKEN_DERBY_CLAUDE_DIR = await tmp('td-probe-empty-');
    const probe = await probeSource('claude');
    expect(probe.exists).toBe(true);
    expect(probe.transcripts).toBe(0);
  });

  it('counts claude transcripts nested under a project directory', async () => {
    const root = await tmp('td-probe-claude-');
    process.env.TOKEN_DERBY_CLAUDE_DIR = root;
    await fs.mkdir(path.join(root, 'proj1'), { recursive: true });
    await fs.writeFile(path.join(root, 'proj1', 'session-a.jsonl'), '');
    await fs.writeFile(path.join(root, 'proj1', 'session-b.jsonl'), '');
    const probe = await probeSource('claude');
    expect(probe.transcripts).toBe(2);
  });

  it('counts codex rollouts under the dated sessions tree', async () => {
    const root = await tmp('td-probe-codex-');
    process.env.TOKEN_DERBY_CODEX_DIR = root;
    const day = path.join(root, 'sessions', '2026', '09', '16');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(path.join(day, 'rollout-abc.jsonl'), '');
    const probe = await probeSource('codex');
    expect(probe).toMatchObject({ key: 'codex', exists: true, transcripts: 1 });
  });

  it('counts gemini chats under a project hash directory', async () => {
    const root = await tmp('td-probe-gemini-');
    process.env.TOKEN_DERBY_GEMINI_DIR = root;
    const chats = path.join(root, 'hash1', 'chats');
    await fs.mkdir(chats, { recursive: true });
    await fs.writeFile(path.join(chats, 'session-1.json'), '');
    const probe = await probeSource('gemini');
    expect(probe).toMatchObject({ key: 'gemini', exists: true, transcripts: 1 });
  });

  it('does not throw when the source root is missing', async () => {
    process.env.TOKEN_DERBY_GEMINI_DIR = path.join(os.tmpdir(), 'td-probe-nope-' + Math.random());
    await expect(probeSource('gemini')).resolves.toMatchObject({ exists: false, projects: 0, transcripts: 0 });
  });
});

describe('describeEmptySource', () => {
  it('names the directory it looked in and says it is missing', () => {
    const text = describeEmptySource({ key: 'claude', dir: '/home/y/.claude/projects', exists: false, projects: 0, transcripts: 0 });
    expect(text).toContain('/home/y/.claude/projects');
    expect(text).toContain('does not exist');
  });

  it('says the directory is empty when it exists but holds no transcripts', () => {
    const text = describeEmptySource({ key: 'claude', dir: '/home/y/.claude/projects', exists: true, projects: 0, transcripts: 0 });
    expect(text).toContain('no transcripts');
    expect(text).not.toContain('does not exist');
  });

  it("names the source's own override variable, not another source's", () => {
    const text = describeEmptySource({ key: 'codex', dir: '/x', exists: false, projects: 0, transcripts: 0 });
    expect(text).toContain('TOKEN_DERBY_CODEX_DIR');
    expect(text).not.toContain('TOKEN_DERBY_CLAUDE_DIR');
  });

  it('points Claude users at CLAUDE_CONFIG_DIR, the usual cause of a relocated config', () => {
    const text = describeEmptySource({ key: 'claude', dir: '/x', exists: false, projects: 0, transcripts: 0 });
    expect(text).toContain('CLAUDE_CONFIG_DIR');
  });

  it('warns that a container or remote machine needs its own join', () => {
    const text = describeEmptySource({ key: 'claude', dir: '/x', exists: false, projects: 0, transcripts: 0 });
    expect(text).toMatch(/container|SSH|machine/i);
  });
});

describe('probeSource — a tree with projects but no transcripts', () => {
  it('counts the project directories it found alongside the transcripts', async () => {
    const root = await tmp('td-probe-projects-');
    process.env.TOKEN_DERBY_CLAUDE_DIR = root;
    await fs.mkdir(path.join(root, 'proj1'), { recursive: true });
    await fs.writeFile(path.join(root, 'proj1', 'a.jsonl'), '');
    await fs.mkdir(path.join(root, 'proj2'), { recursive: true });
    const probe = await probeSource('claude');
    expect(probe.projects).toBe(2);
    expect(probe.transcripts).toBe(1);
  });

  it('reports projects whose contents cannot be listed, so 0 transcripts is explicable', async () => {
    const root = await tmp('td-probe-locked-');
    process.env.TOKEN_DERBY_CLAUDE_DIR = root;
    const proj = path.join(root, 'proj1');
    await fs.mkdir(proj, { recursive: true });
    await fs.writeFile(path.join(proj, 'a.jsonl'), '');
    await fs.chmod(proj, 0o000); // listable as an entry, not as a directory
    const probe = await probeSource('claude');
    await fs.chmod(proj, 0o755); // restore so the fixture can be removed
    expect(probe.projects).toBe(1);
    expect(probe.transcripts).toBe(0);
  });

  it('reports a genuinely empty root as having no projects at all', async () => {
    process.env.TOKEN_DERBY_CLAUDE_DIR = await tmp('td-probe-bare-');
    const probe = await probeSource('claude');
    expect(probe.projects).toBe(0);
    expect(probe.transcripts).toBe(0);
  });
});

describe('describeEmptySource — wording matches the cause', () => {
  const withProjects = { key: 'claude' as const, dir: '/p', exists: true, projects: 7, transcripts: 0 };

  it('does not claim a tree full of projects simply holds no transcripts', () => {
    const text = describeEmptySource(withProjects);
    expect(text).not.toContain('holds no transcripts');
    expect(text).toContain('7 project');
  });

  it('names dangling symlinks and permissions as the reason those projects read as empty', () => {
    const text = describeEmptySource(withProjects);
    expect(text).toMatch(/symlink/i);
    expect(text).toMatch(/permission/i);
  });

  it('still says "holds no transcripts" for a root with no projects in it', () => {
    const text = describeEmptySource({ key: 'claude', dir: '/p', exists: true, projects: 0, transcripts: 0 });
    expect(text).toContain('holds no transcripts');
  });
});
