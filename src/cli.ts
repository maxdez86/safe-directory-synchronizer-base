#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synchronize } from "./synchronize.js";
import { SyncError, type FatalCode, type SyncDependencies, type SyncResult } from "./types.js";

/** Output streams, collaborators and signal source used by `main`. */
export interface CliContext {
  /** Defaults to `process.stdout`. */
  readonly stdout?: { write(chunk: string): unknown };
  /** Defaults to `process.stderr`. */
  readonly stderr?: { write(chunk: string): unknown };
  /** Passed to `synchronize`. */
  readonly dependencies?: SyncDependencies;
  /** Source of `SIGTERM`. Defaults to `process`. */
  readonly signals?: Pick<NodeJS.Process, "once" | "off">;
}

interface ParsedArguments {
  readonly source: string;
  readonly destination: string;
  readonly state: string;
  readonly json: boolean;
  readonly concurrency: number | undefined;
}

type Writer = { write(chunk: string): unknown };

const VALUE_FLAGS = new Set(["--source", "--destination", "--state", "--concurrency"]);
const SCHEMA_VERSION = 1;

/** Runs the `resync` command line and resolves with the exit code. */
export async function main(argv: readonly string[], context: CliContext = {}): Promise<number> {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;
  const signals = context.signals ?? process;

  const parsed = parseArguments(argv);
  if (parsed === undefined) {
    writeFatal(argv.includes("--json"), stdout, stderr, "usage");
    return 1;
  }

  const controller = new AbortController();
  const onTerminate = (): void => {
    controller.abort();
  };
  signals.once("SIGTERM", onTerminate);

  let result: SyncResult;
  try {
    const cwd = process.cwd();
    result = await synchronize(
      {
        sourceRoot: path.resolve(cwd, parsed.source),
        destinationRoot: path.resolve(cwd, parsed.destination),
        stateRoot: path.resolve(cwd, parsed.state),
        maxConcurrency: parsed.concurrency,
        signal: controller.signal,
      },
      context.dependencies,
    );
  } catch (error) {
    const code: FatalCode = error instanceof SyncError ? error.code : "io-error";
    const entryPath = error instanceof SyncError ? error.path : undefined;
    writeFatal(parsed.json, stdout, stderr, code, entryPath);
    return code === "live-owner" ? 3 : 1;
  } finally {
    signals.off("SIGTERM", onTerminate);
  }

  if (parsed.json) {
    stdout.write(`${JSON.stringify(toJsonReport(result))}\n`);
  } else {
    writeText(stdout, result);
  }
  return result.outcome === "complete" ? 0 : 2;
}

function parseArguments(argv: readonly string[]): ParsedArguments | undefined {
  const [command, ...rest] = argv;
  if (command !== "sync") {
    return undefined;
  }
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--json") {
      if (json) {
        return undefined;
      }
      json = true;
      continue;
    }
    if (token === undefined || !VALUE_FLAGS.has(token) || values.has(token)) {
      return undefined;
    }
    const value = rest[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      return undefined;
    }
    values.set(token, value);
    index += 1;
  }
  const source = values.get("--source");
  const destination = values.get("--destination");
  const state = values.get("--state");
  if (source === undefined || destination === undefined || state === undefined) {
    return undefined;
  }
  const concurrencyValue = values.get("--concurrency");
  const concurrency = concurrencyValue === undefined ? undefined : Number(concurrencyValue);
  if (
    concurrency !== undefined &&
    (!Number.isSafeInteger(concurrency) || concurrency < 1 || String(concurrency) !== concurrencyValue)
  ) {
    return undefined;
  }
  return { source, destination, state, json, concurrency };
}

function toJsonReport(result: SyncResult): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: result.runId,
    outcome: result.outcome,
    counts: {
      copied: result.counts.copied,
      unchanged: result.counts.unchanged,
      skipped: result.counts.skipped,
      failed: result.counts.failed,
      cancelled: result.counts.cancelled,
    },
    entries: result.entries.map((entry) =>
      entry.code === undefined
        ? { path: entry.path, kind: entry.kind, result: entry.result }
        : { path: entry.path, kind: entry.kind, result: entry.result, code: entry.code },
    ),
    warnings: result.warnings.map((warning) =>
      warning.path === undefined
        ? { code: warning.code }
        : { code: warning.code, path: warning.path },
    ),
  };
}

function writeText(stdout: Writer, result: SyncResult): void {
  for (const entry of result.entries) {
    if (entry.result === "unchanged") {
      continue;
    }
    const suffix = entry.code === undefined ? "" : ` (${entry.code})`;
    stdout.write(`${entry.result} ${entry.path}${suffix}\n`);
  }
  const { copied, unchanged, skipped, failed, cancelled } = result.counts;
  stdout.write(
    `${result.outcome}: ${copied} copied, ${unchanged} unchanged, ${skipped} skipped, ` +
      `${failed} failed, ${cancelled} cancelled\n`,
  );
}

function writeFatal(
  json: boolean,
  stdout: Writer,
  stderr: Writer,
  code: FatalCode,
  entryPath?: string,
): void {
  if (json) {
    const report =
      entryPath === undefined
        ? { schemaVersion: SCHEMA_VERSION, outcome: "fatal", code }
        : { schemaVersion: SCHEMA_VERSION, outcome: "fatal", code, path: entryPath };
    stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  stderr.write(entryPath === undefined ? `resync: ${code}\n` : `resync: ${code} ${entryPath}\n`);
}

function isEntryModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
