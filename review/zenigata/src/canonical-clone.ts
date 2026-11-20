import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "./redact.js";

const execFileAsync = promisify(execFile);

async function git(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: opts.cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message: string };
    const detail = err.stderr?.trim() ?? err.message;
    throw new Error(
      redactSecrets(`git ${args.join(" ")} failed: ${detail}`).slice(0, 500),
    );
  }
}

const slugifyRepo = (repo: string): string => repo.replace(/\//g, "-");

export function canonicalCloneDirName(repo: string): string {
  const hash = createHash("sha1").update(repo).digest("hex").slice(0, 8);
  return `${slugifyRepo(repo)}-${hash}`;
}

export function canonicalClonesRoot(stateDir: string): string {
  return join(stateDir, "canonical-clones");
}

export function canonicalCloneDir(stateDir: string, repo: string): string {
  return join(canonicalClonesRoot(stateDir), canonicalCloneDirName(repo));
}

async function isUsableGitDir(dir: string): Promise<boolean> {
  try {
    await git(["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

const cloneInflight = new Map<string, Promise<void>>();

async function withCloneLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  while (cloneInflight.has(key)) {
    try {
      await cloneInflight.get(key);
    } catch {
      // The previous attempt's failure is observed by its own caller.
    }
  }
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  cloneInflight.set(key, gate);
  try {
    return await fn();
  } finally {
    cloneInflight.delete(key);
    release();
  }
}

/**
 * Ensure a persistent canonical clone of `repo` exists under stateDir and
 * return its path. The daemon resolves the memory project/workspace from a
 * cwd's git metadata, so a real checkout (with origin) is the structural
 * carrier for repo-stamped writes outside a per-review worktree, and reviews
 * build their per-PR worktrees from the same clone. Lazily cloned with
 * --no-checkout from the forge-provided clone URL; reused by later reviews
 * and memory-stamping operations. A failed initial clone leaves no unusable
 * directory behind.
 */
export async function ensureCanonicalClone(input: {
  stateDir: string;
  repo: string;
  cloneUrl: string;
}): Promise<string> {
  const root = canonicalClonesRoot(input.stateDir);
  const dir = canonicalCloneDir(input.stateDir, input.repo);
  await mkdir(root, { recursive: true });
  if (await isUsableGitDir(dir)) {
    return dir;
  }
  await withCloneLock(dir, async () => {
    if (await isUsableGitDir(dir)) {
      return;
    }
    await rm(dir, { recursive: true, force: true });
    try {
      await git(["clone", "--no-checkout", "--", input.cloneUrl, dir]);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  });
  return dir;
}

/** Fetch refs into the canonical clone using the (possibly credentialed) URL. */
export async function fetchCanonicalClone(input: {
  dir: string;
  cloneUrl: string;
  refs: string[];
}): Promise<void> {
  await git(["-C", input.dir, "fetch", "--", input.cloneUrl, ...input.refs]);
}

/**
 * Drop the canonical clone's registrations for worktrees whose
 * directories are gone. A registration outlives its directory when a run
 * died between add and cleanup, a failed install, or a manual state-dir
 * tidy removed the directory, and `git worktree add` then refuses the
 * path until this clears the entry.
 */
export async function pruneCanonicalWorktrees(input: {
  canonicalCloneDir: string;
}): Promise<void> {
  await git(["-C", input.canonicalCloneDir, "worktree", "prune"]);
}

/**
 * Add a detached worktree for `sha` at `worktreeDir` from the canonical clone.
 * Any existing path at `worktreeDir` must already be removed by the caller.
 */
export async function addReviewWorktree(input: {
  canonicalCloneDir: string;
  worktreeDir: string;
  sha: string;
}): Promise<void> {
  await git([
    "-C",
    input.canonicalCloneDir,
    "worktree",
    "add",
    "--detach",
    "--",
    input.worktreeDir,
    input.sha,
  ]);
}

/**
 * Remove a per-review worktree: deregister it from the canonical clone (best
 * effort) and remove its directory, refusing paths outside the worktrees root.
 */
export async function removeReviewWorktree(input: {
  worktreesDir: string;
  worktreeDir: string;
  canonicalCloneDir?: string;
}): Promise<void> {
  const root = resolve(input.worktreesDir);
  const target = resolve(input.worktreeDir);
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error(
      `refusing to remove ${input.worktreeDir}: outside ${input.worktreesDir}`,
    );
  }
  if (input.canonicalCloneDir !== undefined) {
    try {
      await git([
        "-C",
        input.canonicalCloneDir,
        "worktree",
        "remove",
        "--force",
        "--",
        target,
      ]);
    } catch {
      // Best effort: the directory may already be gone or unregistered.
    }
    try {
      await git(["-C", input.canonicalCloneDir, "worktree", "prune"]);
    } catch {
      // Best effort.
    }
  }
  await rm(target, { recursive: true, force: true });
}
