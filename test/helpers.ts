import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import type { FileOps, LifecycleEvent, LifecycleObserver } from "../src/index.js";

export interface Fixture {
  /** Directory holding every root of one test. */
  readonly base: string;
  readonly source: string;
  readonly destination: string;
  readonly state: string;
}

const createdBases: string[] = [];

/** Registers removal of every fixture directory created by the current test file. */
export function useFixtures(): void {
  afterEach(async () => {
    const bases = createdBases.splice(0);
    await Promise.all(bases.map((base) => rm(base, { recursive: true, force: true })));
  });
}

/** Creates a fixture directory with an existing, empty source root. */
export async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "resync-test-"));
  createdBases.push(base);
  const fixture = {
    base,
    source: path.join(base, "source"),
    destination: path.join(base, "destination"),
    state: path.join(base, "state"),
  };
  await mkdir(fixture.source);
  return fixture;
}

/** Writes files (POSIX relative paths) beneath `root`, creating parent directories. */
export async function writeTree(
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

/**
 * Describes every entry beneath `root`: `dir`, `file:<sha256>`, `symlink:<target>` or `special`.
 */
export async function readTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(relative: string): Promise<void> {
    const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const entryPath = relative === "" ? name : `${relative}/${name}`;
      const absolute = path.join(directory, name);
      const stats = await lstat(absolute);
      if (stats.isDirectory()) {
        out[entryPath] = "dir";
        await walk(entryPath);
      } else if (stats.isFile()) {
        out[entryPath] = `file:${sha256(await readFile(absolute))}`;
      } else if (stats.isSymbolicLink()) {
        out[entryPath] = `symlink:${await readlink(absolute)}`;
      } else {
        out[entryPath] = "special";
      }
    }
  }
  await walk("");
  return out;
}

/** Returns `true` when `target` does not exist (without following a final symbolic link). */
export async function isAbsent(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic bytes of `size` length derived from `seed`. */
export function patternBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + seed) % 251;
  }
  return bytes;
}

export interface Gate {
  /** Resolves once `open` is called. */
  readonly wait: Promise<void>;
  readonly open: () => void;
}

export function createGate(): Gate {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * Observer that pauses the run at the first `discovery` pending event until `release` is called.
 * `reached` resolves once the pause has begun.
 */
export function holdAtDiscovery(): {
  readonly observer: LifecycleObserver;
  readonly reached: Promise<void>;
  readonly release: () => void;
} {
  const reachedGate = createGate();
  const releaseGate = createGate();
  let held = false;
  const observer = async (event: LifecycleEvent): Promise<void> => {
    if (!held && event.phase === "discovery" && event.state === "pending") {
      held = true;
      reachedGate.open();
      await releaseGate.wait;
    }
  };
  return { observer, reached: reachedGate.wait, release: releaseGate.open };
}

export interface RecordedCall {
  readonly method: string;
  readonly path: string;
}

type AnyMethod = (...args: unknown[]) => unknown;

/**
 * Builds a `FileOps` that forwards every own method of `inner`, including operations beyond the
 * required ones, through `intercept`.
 */
function forwardingFileOps(
  inner: FileOps,
  intercept: (method: string, args: unknown[], invoke: () => unknown) => unknown,
): FileOps {
  const source = inner as unknown as Record<string, unknown>;
  const wrapper: Record<string, AnyMethod> = {};
  for (const name of Object.getOwnPropertyNames(source)) {
    const value = source[name];
    if (typeof value !== "function") {
      continue;
    }
    const method = value as AnyMethod;
    wrapper[name] = (...args: unknown[]) =>
      intercept(name, args, () => method.apply(inner, args));
  }
  return wrapper as unknown as FileOps;
}

function firstPath(args: readonly unknown[]): string {
  const found = args.find((arg): arg is string => typeof arg === "string");
  return found ?? "";
}

/** Wraps `inner` so that every call is recorded with its method name and first path argument. */
export function recordingFileOps(inner: FileOps): {
  readonly fileOps: FileOps;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fileOps = forwardingFileOps(inner, (method, args, invoke) => {
    calls.push({ method, path: firstPath(args) });
    return invoke();
  });
  return { fileOps, calls };
}

/** Collects written chunks. */
export function captureStream(): { readonly write: (chunk: string) => boolean; text: () => string } {
  let buffer = "";
  return {
    write: (chunk: string) => {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}
