import { randomUUID } from "node:crypto";
import path from "node:path";
import { createNodeFileOps } from "./node-file-ops.js";
import {
  SyncError,
  type Clock,
  type EntryCode,
  type EntryKind,
  type EntryReport,
  type EntryResult,
  type FileOps,
  type LifecycleObserver,
  type Phase,
  type ReadHandle,
  type SyncCounts,
  type SyncDependencies,
  type SyncOptions,
  type SyncResult,
  type WriteHandle,
} from "./types.js";

const CHUNK_SIZE = 65536;
const LOCK_FILE = "owner.lock";
const MANIFEST_FILE = "manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;

interface DiscoveredEntry {
  readonly path: string;
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ManifestRecord {
  readonly size: number;
  readonly mtimeMs: number;
}

type ManifestRecords = Map<string, ManifestRecord>;

interface PlannedRoot {
  /** Resolved absolute path of the root. */
  readonly resolved: string;
  /** Resolved nearest existing ancestor (or the root itself). */
  readonly existing: string;
  /** Segments to create beneath `existing`. */
  readonly missing: readonly string[];
}

interface RunContext {
  readonly runId: string;
  readonly fileOps: FileOps;
  readonly clock: Clock;
  readonly observer: LifecycleObserver | undefined;
  readonly signal: AbortSignal | undefined;
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly stateRoot: string;
}

interface OpenHandles {
  reader?: ReadHandle;
  writer?: WriteHandle;
}

/**
 * Synchronizes the regular files and directories of `options.sourceRoot` into
 * `options.destinationRoot`.
 *
 * Resolves with a result for outcomes `complete`, `partial` and `cancelled`; rejects with
 * `SyncError` for fatal conditions.
 */
export async function synchronize(
  options: SyncOptions,
  dependencies: SyncDependencies = {},
): Promise<SyncResult> {
  if (
    options.maxConcurrency !== undefined &&
    (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1)
  ) {
    throw new SyncError("usage");
  }
  const fileOps = dependencies.fileOps ?? createNodeFileOps();
  const clock = dependencies.clock ?? { now: () => Date.now() };
  const ids = dependencies.ids ?? (() => randomUUID());
  const runId = ids();

  const sourceRoot = await resolveSourceRoot(fileOps, path.resolve(options.sourceRoot));
  const destination = await planRoot(fileOps, path.resolve(options.destinationRoot));
  const state = await planRoot(fileOps, path.resolve(options.stateRoot));
  assertDisjoint([sourceRoot, destination.resolved, state.resolved]);
  await createRoot(fileOps, destination);
  await createRoot(fileOps, state);

  const context: RunContext = {
    runId,
    fileOps,
    clock,
    observer: dependencies.observer,
    signal: options.signal,
    sourceRoot,
    destinationRoot: destination.resolved,
    stateRoot: state.resolved,
  };

  await emit(context, "lock", "pending");
  const lockPath = path.join(context.stateRoot, LOCK_FILE);
  let lockHandle: WriteHandle;
  try {
    lockHandle = await fileOps.openWrite(lockPath, "exclusive");
  } catch (error) {
    throw new SyncError(errorCode(error) === "EEXIST" ? "live-owner" : "io-error");
  }

  try {
    await writeOwnerRecord(context, lockHandle);
    await emit(context, "lock", "complete");
    return await runOwned(context);
  } finally {
    await releaseOwnership(context, lockPath);
  }
}

async function writeOwnerRecord(context: RunContext, handle: WriteHandle): Promise<void> {
  const record = JSON.stringify({ runId: context.runId, acquiredAt: context.clock.now() });
  try {
    await handle.write(new TextEncoder().encode(record));
    await handle.sync();
  } catch {
    await closeQuietly(handle);
    throw new SyncError("io-error");
  }
  try {
    await handle.close();
  } catch {
    throw new SyncError("io-error");
  }
}

async function releaseOwnership(context: RunContext, lockPath: string): Promise<void> {
  await emit(context, "release", "pending");
  try {
    await context.fileOps.rm(lockPath);
  } catch {
    throw new SyncError("io-error");
  }
  await emit(context, "release", "complete");
}

async function runOwned(context: RunContext): Promise<SyncResult> {
  await emit(context, "discovery", "pending");
  const discovered: DiscoveredEntry[] = [];
  await discover(context, "", discovered);
  await emit(context, "discovery", "complete");

  const previous = await readManifest(context);
  const records: ManifestRecords = new Map();
  const reports = new Map<string, EntryReport>();
  const changed = new Set<string>();

  for (const entry of discovered) {
    if (entry.kind === "symlink" || entry.kind === "special") {
      reports.set(entry.path, report(entry, "skipped", entry.kind));
    } else if (entry.kind === "file") {
      const prior = previous.get(entry.path);
      if (prior !== undefined && prior.size === entry.size && prior.mtimeMs === entry.mtimeMs) {
        records.set(entry.path, prior);
        reports.set(entry.path, report(entry, "unchanged"));
      } else {
        records.set(entry.path, { size: entry.size, mtimeMs: entry.mtimeMs });
        changed.add(entry.path);
      }
    }
  }

  if (changed.size > 0) {
    for (const entryPath of changed) {
      await emit(context, "admission", "pending", entryPath);
    }
    await writeManifest(context, records);
    for (const entryPath of changed) {
      await emit(context, "admission", "complete", entryPath);
    }
  }

  let cancelled = false;
  for (const entry of discovered) {
    if (reports.has(entry.path)) {
      continue;
    }
    if (cancelled) {
      reports.set(entry.path, report(entry, "cancelled", "cancelled"));
      continue;
    }
    if (entry.kind === "directory") {
      const created = await ensureDestinationDirectory(context, entry.path, entry.path);
      reports.set(entry.path, report(entry, created ? "copied" : "unchanged"));
      continue;
    }
    const result = await publishFile(context, entry.path, records);
    if (result === "cancelled") {
      cancelled = true;
      reports.set(entry.path, report(entry, "cancelled", "cancelled"));
    } else {
      reports.set(entry.path, report(entry, "copied"));
    }
  }

  const entries = discovered.map((entry) => {
    const entryReport = reports.get(entry.path);
    if (entryReport === undefined) {
      throw new SyncError("io-error", entry.path);
    }
    return entryReport;
  });
  const counts = countResults(entries);
  const outcome =
    counts.cancelled > 0 ? "cancelled" : counts.failed > 0 ? "partial" : "complete";
  return { runId: context.runId, outcome, counts, entries, warnings: [] };
}

async function discover(
  context: RunContext,
  relativeDirectory: string,
  out: DiscoveredEntry[],
): Promise<void> {
  const absoluteDirectory = sourcePath(context, relativeDirectory);
  let names: string[];
  try {
    names = await context.fileOps.readdir(absoluteDirectory);
  } catch (error) {
    throw sourceFailure(error, relativeDirectory === "" ? undefined : relativeDirectory);
  }
  names.sort(compareStrings);
  for (const name of names) {
    const entryPath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
    let stat;
    try {
      stat = await context.fileOps.lstat(sourcePath(context, entryPath));
    } catch (error) {
      throw sourceFailure(error, entryPath);
    }
    out.push({ path: entryPath, kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs });
    if (stat.kind === "directory") {
      await discover(context, entryPath, out);
    }
  }
}

async function publishFile(
  context: RunContext,
  entryPath: string,
  records: ManifestRecords,
): Promise<"copied" | "cancelled"> {
  const { fileOps } = context;
  const parent = path.posix.dirname(entryPath);
  if (parent !== ".") {
    await ensureDestinationDirectory(context, parent, entryPath);
  }

  const target = destinationPath(context, entryPath);
  try {
    const existing = await fileOps.lstat(target);
    if (existing.kind !== "file") {
      throw new SyncError("destination-conflict", entryPath);
    }
  } catch (error) {
    if (error instanceof SyncError) {
      throw error;
    }
    if (errorCode(error) !== "ENOENT") {
      throw new SyncError("io-error", entryPath);
    }
  }

  if (isAborted(context)) {
    return "cancelled";
  }

  const handles: OpenHandles = {};
  try {
    await emit(context, "replacement-write", "pending", entryPath);
    try {
      handles.reader = await fileOps.openRead(sourcePath(context, entryPath));
    } catch (error) {
      throw sourceFailure(error, entryPath);
    }
    try {
      handles.writer = await fileOps.openWrite(target, "truncate");
    } catch {
      throw new SyncError("io-error", entryPath);
    }

    for (;;) {
      if (isAborted(context)) {
        await closeHandlesQuietly(handles);
        return "cancelled";
      }
      let chunk: Uint8Array;
      try {
        chunk = await handles.reader.read(CHUNK_SIZE);
      } catch (error) {
        throw sourceFailure(error, entryPath);
      }
      if (chunk.byteLength === 0) {
        break;
      }
      try {
        await handles.writer.write(chunk);
      } catch {
        throw new SyncError("io-error", entryPath);
      }
    }
    await emit(context, "replacement-write", "complete", entryPath);

    await emit(context, "replacement-durable", "pending", entryPath);
    try {
      await handles.writer.sync();
    } catch {
      throw new SyncError("io-error", entryPath);
    }
    await emit(context, "replacement-durable", "complete", entryPath);

    await emit(context, "publication", "pending", entryPath);
    const { reader, writer } = handles;
    delete handles.reader;
    delete handles.writer;
    try {
      await reader.close();
    } catch (error) {
      await closeQuietly(writer);
      throw sourceFailure(error, entryPath);
    }
    try {
      await writer.close();
    } catch {
      throw new SyncError("io-error", entryPath);
    }
    await emit(context, "publication", "complete", entryPath);
  } catch (error) {
    await closeHandlesQuietly(handles);
    throw error;
  }

  await emit(context, "checkpoint", "pending", entryPath);
  await writeManifest(context, records, entryPath);
  await emit(context, "checkpoint", "complete", entryPath);

  await emit(context, "settlement", "pending", entryPath);
  await emit(context, "settlement", "complete", entryPath);
  return "copied";
}

/**
 * Ensures every component of `relativeDirectory` exists as a directory beneath the destination.
 * Resolves `true` when the final component was created by this call.
 */
async function ensureDestinationDirectory(
  context: RunContext,
  relativeDirectory: string,
  entryPath: string,
): Promise<boolean> {
  const segments = relativeDirectory.split("/");
  let current = context.destinationRoot;
  let created = false;
  for (const segment of segments) {
    current = path.join(current, segment);
    created = false;
    try {
      const stat = await context.fileOps.lstat(current);
      if (stat.kind !== "directory") {
        throw new SyncError("destination-conflict", entryPath);
      }
      continue;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      if (errorCode(error) !== "ENOENT") {
        throw new SyncError("io-error", entryPath);
      }
    }
    try {
      await context.fileOps.mkdir(current);
    } catch {
      throw new SyncError("io-error", entryPath);
    }
    created = true;
  }
  return created;
}

async function readManifest(context: RunContext): Promise<ManifestRecords> {
  let bytes: Uint8Array;
  try {
    bytes = await context.fileOps.readFile(path.join(context.stateRoot, MANIFEST_FILE));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return new Map();
    }
    throw new SyncError("io-error");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SyncError("io-error");
  }
  if (
    !isObject(parsed) ||
    parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    !isObject(parsed.entries)
  ) {
    throw new SyncError("io-error");
  }
  const records: ManifestRecords = new Map();
  for (const [entryPath, value] of Object.entries(parsed.entries)) {
    if (!isObject(value) || typeof value.size !== "number" || typeof value.mtimeMs !== "number") {
      throw new SyncError("io-error");
    }
    records.set(entryPath, { size: value.size, mtimeMs: value.mtimeMs });
  }
  return records;
}

async function writeManifest(
  context: RunContext,
  records: ManifestRecords,
  entryPath?: string,
): Promise<void> {
  const entries: Record<string, ManifestRecord> = {};
  for (const [recordPath, record] of records) {
    entries[recordPath] = { size: record.size, mtimeMs: record.mtimeMs };
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({ schemaVersion: MANIFEST_SCHEMA_VERSION, entries }),
  );
  let handle: WriteHandle | undefined;
  try {
    handle = await context.fileOps.openWrite(
      path.join(context.stateRoot, MANIFEST_FILE),
      "truncate",
    );
    await handle.write(bytes);
    await handle.sync();
    const opened = handle;
    handle = undefined;
    await opened.close();
  } catch {
    if (handle !== undefined) {
      await closeQuietly(handle);
    }
    throw new SyncError("io-error", entryPath);
  }
}

async function resolveSourceRoot(fileOps: FileOps, root: string): Promise<string> {
  try {
    const resolved = await fileOps.realpath(root);
    const stat = await fileOps.lstat(resolved);
    if (stat.kind === "directory") {
      return resolved;
    }
  } catch {
    // Reported below.
  }
  throw new SyncError("source-unavailable");
}

async function planRoot(fileOps: FileOps, root: string): Promise<PlannedRoot> {
  const missing: string[] = [];
  let current = root;
  for (;;) {
    try {
      const existing = await fileOps.realpath(current);
      return { resolved: path.join(existing, ...missing), existing, missing };
    } catch (error) {
      const code = errorCode(error);
      const parent = path.dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) {
        throw new SyncError("io-error");
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function assertDisjoint(roots: readonly string[]): void {
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const first = roots[i];
      const second = roots[j];
      if (
        first !== undefined &&
        second !== undefined &&
        (containsPath(first, second) || containsPath(second, first))
      ) {
        throw new SyncError("overlapping-roots");
      }
    }
  }
}

/** True when `candidate` equals `ancestor` or lies beneath it, compared segment by segment. */
function containsPath(ancestor: string, candidate: string): boolean {
  if (ancestor === candidate) {
    return true;
  }
  const prefix = ancestor.endsWith(path.sep) ? ancestor : `${ancestor}${path.sep}`;
  return candidate.startsWith(prefix);
}

async function createRoot(fileOps: FileOps, root: PlannedRoot): Promise<void> {
  let current = root.existing;
  if (root.missing.length === 0) {
    await assertDirectory(fileOps, current);
    return;
  }
  for (const segment of root.missing) {
    current = path.join(current, segment);
    try {
      await fileOps.mkdir(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw new SyncError("io-error");
      }
      await assertDirectory(fileOps, current);
    }
  }
}

async function assertDirectory(fileOps: FileOps, directory: string): Promise<void> {
  let kind: EntryKind;
  try {
    kind = (await fileOps.lstat(directory)).kind;
  } catch {
    throw new SyncError("io-error");
  }
  if (kind !== "directory") {
    throw new SyncError("io-error");
  }
}

async function emit(
  context: RunContext,
  phase: Phase,
  state: "pending" | "complete",
  entryPath?: string,
): Promise<void> {
  if (context.observer === undefined) {
    return;
  }
  const event =
    entryPath === undefined
      ? { runId: context.runId, phase, state }
      : { runId: context.runId, path: entryPath, phase, state };
  await context.observer(event);
}

function report(entry: DiscoveredEntry, result: EntryResult, code?: EntryCode): EntryReport {
  return code === undefined
    ? { path: entry.path, kind: entry.kind, result }
    : { path: entry.path, kind: entry.kind, result, code };
}

function countResults(entries: readonly EntryReport[]): SyncCounts {
  const counts = { copied: 0, unchanged: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const entry of entries) {
    counts[entry.result] += 1;
  }
  return counts;
}

function sourcePath(context: RunContext, entryPath: string): string {
  return entryPath === "" ? context.sourceRoot : path.join(context.sourceRoot, ...entryPath.split("/"));
}

function destinationPath(context: RunContext, entryPath: string): string {
  return path.join(context.destinationRoot, ...entryPath.split("/"));
}

function sourceFailure(error: unknown, entryPath: string | undefined): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return new SyncError("unreadable", entryPath);
  }
  if (code === "ENOENT") {
    return new SyncError("vanished", entryPath);
  }
  return new SyncError("io-error", entryPath);
}

async function closeHandlesQuietly(handles: OpenHandles): Promise<void> {
  const { reader, writer } = handles;
  delete handles.reader;
  delete handles.writer;
  if (reader !== undefined) {
    await closeQuietly(reader);
  }
  if (writer !== undefined) {
    await closeQuietly(writer);
  }
}

async function closeQuietly(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    // The handle is abandoned; the original condition is reported instead.
  }
}

function isAborted(context: RunContext): boolean {
  return context.signal?.aborted === true;
}

function errorCode(error: unknown): string | undefined {
  if (isObject(error) && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareStrings(first: string, second: string): number {
  if (first < second) {
    return -1;
  }
  return first > second ? 1 : 0;
}
