/** Inputs of a synchronization run. */
export interface SyncOptions {
  /** Directory whose regular files and directories are copied. Must exist. */
  readonly sourceRoot: string;
  /** Directory that receives the copy. Created when missing. */
  readonly destinationRoot: string;
  /** Directory that holds restart state and ownership. Created when missing. */
  readonly stateRoot: string;
  /**
   * Maximum number of regular files processed at once. Defaults to `1`.
   *
   * Reports remain in source-path order. Lifecycle events for different entries may interleave,
   * while the events of each individual entry remain ordered.
   */
  readonly maxConcurrency?: number;
  /**
   * Requests cancellation of the run.
   *
   * Cancellation requested through `signal` makes the run finish with outcome `cancelled`.
   */
  readonly signal?: AbortSignal;
}

/** Collaborators used by `synchronize`. Every field is optional. */
export interface SyncDependencies {
  /** Filesystem access. Defaults to `createNodeFileOps()`. */
  readonly fileOps?: FileOps;
  /** Time source. Defaults to `{ now: () => Date.now() }`. */
  readonly clock?: Clock;
  /** Run identifier source. Defaults to `crypto.randomUUID`. */
  readonly ids?: IdFactory;
  /** Receives lifecycle events. */
  readonly observer?: LifecycleObserver;
}

/** Time source returning milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

/** Produces the identifier of a run. */
export type IdFactory = () => string;

/**
 * A run reports each phase as `pending` before the work that implements it and `complete` after
 * that work has finished. Filesystem mutations that implement a phase happen between its two
 * events.
 *
 * - `lock`: ownership of the state root is being acquired / is held.
 * - `discovery`: the source tree is being enumerated / has been enumerated.
 * - `admission`: per entry; `complete` once the run has durably recorded, under the state root, that
 *   it will replace this entry. From that point the entry is admitted.
 * - `replacement-write`: per entry; `pending` before the first byte of the entry's new content is
 *   written, `complete` after the last byte.
 * - `replacement-durable`: per entry; `complete` once the new content has been flushed with
 *   `WriteHandle.sync`.
 * - `publication`: per entry; `complete` once the destination path presents the entry's new
 *   content.
 * - `checkpoint`: per entry; `complete` once state under the state root durably records the entry as
 *   synchronized.
 * - `settlement`: per entry; `complete` once the entry has its final result for the run and the run
 *   holds no resource for it.
 * - `release`: ownership of the state root is being released / has been released.
 */
export type Phase =
  | "lock"
  | "discovery"
  | "admission"
  | "replacement-write"
  | "replacement-durable"
  | "publication"
  | "checkpoint"
  | "settlement"
  | "release";

/** One lifecycle observation. */
export interface LifecycleEvent {
  readonly runId: string;
  /** Normalized source-relative POSIX path; present only for per-entry phases. */
  readonly path?: string;
  readonly phase: Phase;
  readonly state: "pending" | "complete";
}

/**
 * Awaited before the run continues.
 *
 * Events carry no file content and no absolute paths.
 */
export type LifecycleObserver = (event: LifecycleEvent) => void | Promise<void>;

/** Kind of a source entry, or `unknown` when the entry could not be inspected. */
export type EntryKind = "file" | "directory" | "symlink" | "special" | "unknown";

/** Final result of a source entry. */
export type EntryResult = "copied" | "unchanged" | "skipped" | "failed" | "cancelled";

/**
 * Stable reason attached to an entry.
 *
 * - `symlink`: the source entry is a symbolic link; it is not followed or copied.
 * - `special`: the source entry is a socket, FIFO or device; it is not copied.
 * - `unreadable`: the source entry could not be opened or read due to permissions.
 * - `vanished`: the entry was enumerated but no longer existed when read.
 * - `source-changed`: the source file changed while a stable copy was being prepared.
 * - `io-error`: another filesystem error affected the entry.
 * - `destination-conflict`: the destination path or one of its parents is not of the required
 *   kind.
 * - `cancelled`: the run was cancelled before the entry finished.
 */
export type EntryCode =
  | "symlink"
  | "special"
  | "unreadable"
  | "vanished"
  | "source-changed"
  | "io-error"
  | "destination-conflict"
  | "cancelled";

/**
 * Non-fatal condition reported by a run.
 *
 * - `cleanup-failed`: a resource the run created could not be removed.
 * - `release-failed`: ownership could not be released.
 *
 * Warnings do not change entry results.
 */
export type WarningCode = "cleanup-failed" | "release-failed";

/** Final outcome of a run. */
export type Outcome = "complete" | "partial" | "cancelled";

/** Code of an error that stops a run. */
export type FatalCode =
  | "usage"
  | "overlapping-roots"
  | "source-unavailable"
  | "live-owner"
  | "io-error"
  | EntryCode;

/** Per-entry line of a result. */
export interface EntryReport {
  readonly path: string;
  readonly kind: EntryKind;
  readonly result: EntryResult;
  readonly code?: EntryCode;
}

/** Number of entries per result. */
export interface SyncCounts {
  readonly copied: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly cancelled: number;
}

/** Warning attached to a result. */
export interface SyncWarning {
  readonly code: WarningCode;
  readonly path?: string;
}

/** Result of a run that was not stopped by a fatal error. */
export interface SyncResult {
  readonly runId: string;
  readonly outcome: Outcome;
  readonly counts: SyncCounts;
  readonly entries: readonly EntryReport[];
  readonly warnings: readonly SyncWarning[];
}

/** Error that stops a run. */
export class SyncError extends Error {
  readonly code: FatalCode;
  /** Source-relative POSIX path, when the error concerns one entry. */
  readonly path?: string;

  constructor(code: FatalCode, path?: string) {
    super(path === undefined ? code : `${code} ${path}`);
    this.name = "SyncError";
    this.code = code;
    this.path = path;
  }
}

/** Metadata returned by `FileOps.lstat`. */
export interface FileStat {
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Sequential reader over an open file. */
export interface ReadHandle {
  /** Resolves an empty array at end of file. */
  read(maxBytes: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Sequential writer over an open file. */
export interface WriteHandle {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Every filesystem access performed by `synchronize` goes through this interface. Implementations
 * may add operations; `createNodeFileOps` is the production adapter. Paths are absolute.
 *
 * Errors are Node-style errors that carry `code` (`ENOENT`, `EACCES`, `EPERM`, `EEXIST`, `EIO`, …).
 */
export interface FileOps {
  lstat(path: string): Promise<FileStat>;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  openRead(path: string): Promise<ReadHandle>;
  /** `truncate` creates or empties the file; `exclusive` fails with `EEXIST` when it exists. */
  openWrite(path: string, mode: "truncate" | "exclusive"): Promise<WriteHandle>;
  /** Creates a single directory level; parents are not created. */
  mkdir(path: string): Promise<void>;
  /** Removes a file or an empty directory. */
  rm(path: string): Promise<void>;
}
