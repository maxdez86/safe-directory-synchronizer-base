# resync

`resync` copies the regular-file bytes and directory topology of a source root into a destination
root. It is a single-package ESM Node 24 / strict TypeScript library and command-line tool, and it
keeps its own bookkeeping under a separate state root.

## Requirements

- Node.js 24
- pnpm 9.12.1

## Usage

```text
resync sync --source <path> --destination <path> --state <path> [--concurrency <n>] [--json]
```

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js sync --source ./photos --destination /mnt/backup/photos --state ~/.resync/photos
```

Relative paths are resolved against the current working directory.

## What is synchronized

- Regular files and directories are synchronized recursively. File bytes are copied, and missing
  directories are created.
- A source file is reported as `unchanged` only when its content still has the recorded identity and
  the destination contains that same content. Metadata-preserving source changes, missing
  destinations and destination corruption are detected and repaired.
- File copying may be bounded with `maxConcurrency` in the library or `--concurrency <n>` at the
  command line. The default is `1`. Reports remain in source-path order; lifecycle events for
  different entries may interleave.
- Destination-only paths are retained. Nothing is deleted.
- Source symbolic links and special files (sockets, FIFOs, devices) are never followed or copied.
  They are reported as `skipped` with a stable code and do not affect other entries.
- The source, destination and state roots must be mutually disjoint after symbolic links are
  resolved; overlapping roots are rejected with `overlapping-roots` before anything is written.
  Writes happen only beneath the destination and state roots, and the source is never modified.
- Only one running synchronizer owns a state root at a time (see [Ownership](#ownership)).
- Names such as `dist` and `build` are ordinary data.

`resync` does **not** preserve permissions, ownership or timestamps, and it does not provide
power-loss durability, general coordination with other programs writing to the same trees, watch
mode, deletion, or case-folding semantics. A source file observed changing while it is copied is
not published as a successful copy. Behavior when the roots span different filesystems is not
defined.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | outcome `complete` |
| `2` | outcome `partial` or `cancelled` |
| `3` | fatal `live-owner`: another synchronizer owns the state root |
| `1` | any other fatal error, a usage error, or an unexpected error |

## JSON report

With `--json`, exactly one line is written to standard output and nothing to standard error.

A run that finishes prints:

```json
{"schemaVersion":1,"runId":"…","outcome":"complete","counts":{"copied":0,"unchanged":0,"skipped":0,"failed":0,"cancelled":0},"entries":[{"path":"a.txt","kind":"file","result":"copied"}],"warnings":[]}
```

Keys appear in exactly this order. Each entry has `path`, `kind`, `result` and, when relevant,
`code`. Each warning has `code` and, when relevant, `path`.

A fatal error prints `{"schemaVersion":1,"outcome":"fatal","code":"<FatalCode>"}`, with an
additional `path` when the error concerns one entry.

Reports never contain file bytes, absolute paths, the configured root strings, stack traces or host
error messages. Without `--json`, one line `<result> <path>[ (<code>)]` is printed for every entry
that is not `unchanged`, followed by
`<outcome>: N copied, N unchanged, N skipped, N failed, N cancelled`. Fatal errors are printed to
standard error as `resync: <code>[ <path>]`.

`entries` lists every enumerated source entry (directories, files, symbolic links and special files)
and never a destination-only path. Paths are source-relative POSIX paths, ordered by comparing path
segments one at a time, so a directory precedes its descendants and `a/z` precedes `a-b`.

**Entry results** (`EntryResult`): `copied` (written or created by this run), `unchanged` (already
synchronized), `skipped` (not a regular file or directory), `failed` (an error affected the entry),
`cancelled` (the run was cancelled before the entry finished).

**Entry codes** (`EntryCode`):

- `symlink`: the source entry is a symbolic link.
- `special`: the source entry is a socket, FIFO or device.
- `unreadable`: the source entry could not be opened or read due to permissions.
- `vanished`: the entry was enumerated but no longer existed when read.
- `source-changed`: the source file changed while a stable copy was being prepared.
- `io-error`: another filesystem error affected the entry.
- `destination-conflict`: the destination path or one of its parents is not of the required kind.
- `cancelled`: the run was cancelled before the entry finished.

**Warning codes** (`WarningCode`): `cleanup-failed` means a resource the run created could not be
removed; `release-failed` means ownership could not be released. Warnings do not change entry
results.

**Fatal codes** (`FatalCode`): `usage` (invalid arguments), `overlapping-roots`,
`source-unavailable` (the source is missing or not a directory), `live-owner`, `io-error`, or any
entry code together with the affected `path`.

## Library

```ts
import { synchronize, createNodeFileOps, main } from "resync";

const result = await synchronize(
  { sourceRoot: "/data/in", destinationRoot: "/data/out", stateRoot: "/data/state" },
  { observer: (event) => console.log(event.phase, event.state, event.path ?? "") },
);
```

- `synchronize(options: SyncOptions, dependencies?: SyncDependencies): Promise<SyncResult>` resolves
  for outcomes `complete`, `partial` and `cancelled`, and rejects with `SyncError` (carrying `code`
  and an optional relative `path`) for fatal conditions.
- `SyncOptions`: `sourceRoot` (must exist), `destinationRoot` and `stateRoot` (created when
  missing), optional positive integer `maxConcurrency` (default `1`), and an optional `signal`.
  Cancellation requested through `signal` makes the run finish with outcome `cancelled`.
- `SyncDependencies`: optional `fileOps` (default `createNodeFileOps()`), `clock` (default
  `Date.now`), `ids` (default `crypto.randomUUID`) and `observer`.
- `main(argv: readonly string[], context?: CliContext): Promise<number>` runs the command line and
  resolves with the exit code. `CliContext` may supply `stdout`, `stderr`, `dependencies` and the
  `signals` source (default `process`). Importing `main` does not run the command line.

## Lifecycle events

An `observer` receives `{ runId, path?, phase, state }` events and is awaited before the run
continues. Events carry no file content and no absolute paths; `path` is present only for per-entry
phases.

A run reports each phase as `pending` before the work that implements it and `complete` after that
work has finished. Filesystem mutations that implement a phase happen between its two events.
Events belonging to different entries may interleave, but each entry's events retain this order.

| Phase | Meaning |
|---|---|
| `lock` | ownership of the state root is being acquired / is held |
| `discovery` | the source tree is being enumerated / has been enumerated |
| `admission` | per entry; `complete` once the run has durably recorded, under the state root, that it will replace this entry. From that point the entry is admitted |
| `replacement-write` | per entry; `pending` before the first byte of the entry's new content is written, `complete` after the last byte |
| `replacement-durable` | per entry; `complete` once the new content has been flushed with `WriteHandle.sync` |
| `publication` | per entry; `complete` once the destination path presents the entry's new content |
| `checkpoint` | per entry; `complete` once state under the state root durably records the entry as synchronized |
| `settlement` | per entry; `complete` once the entry has its final result for the run and the run holds no resource for it |
| `release` | ownership of the state root is being released / has been released |

## FileOps

Every filesystem access performed by `synchronize` goes through the `FileOps` interface
(`lstat`, `realpath`, `readdir`, `readFile`, `openRead`, `openWrite`, `mkdir`, `rm`).
Implementations may add operations; `createNodeFileOps` is the production adapter. Paths are
absolute. Errors are Node-style errors carrying `code` (`ENOENT`, `EACCES`, `EPERM`, `EEXIST`,
`EIO`, …).

## Cancellation

`SIGTERM` requests cancellation; the run finishes with outcome `cancelled` and exit code 2.

When `resync` runs under a process supervisor (systemd, a container runtime, a job scheduler), stop
it with `SIGTERM` and let the process exit on its own; the exit code then reports the outcome.

## Concurrency and content integrity

`maxConcurrency` and `--concurrency` are positive integers limiting the number of regular files
processed simultaneously. Durable admission and checkpoint updates for concurrent entries must not
overwrite or roll back one another. One entry's failure does not stop other admitted entries.

Cancellation starts no new admissions. Every entry already durably admitted is published,
checkpointed and settled before the run returns. Interrupted runs may therefore leave several
admitted entries for a successor to reconcile independently.

Restart state includes a content identity, not just size and modification time. Before reporting a
file `unchanged`, the synchronizer verifies that both source and destination have that content. If a
source changes while its replacement is prepared, the entry fails with `source-changed`, its
previous destination remains intact, and other entries continue.

## Ownership

A state root is owned by one running synchronizer at a time; another invocation against the same
state root exits with code 3. Use one state root per destination.

## Development

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## License

Apache-2.0
