import { symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main, synchronize, type SyncCounts } from "../src/index.js";
import {
  captureStream,
  createFixture,
  holdAtDiscovery,
  isAbsent,
  useFixtures,
  writeTree,
  type Fixture,
} from "./helpers.js";

useFixtures();

function syncArgs(fixture: Fixture, ...extra: string[]): string[] {
  return [
    "sync",
    "--source",
    fixture.source,
    "--destination",
    fixture.destination,
    "--state",
    fixture.state,
    ...extra,
  ];
}

interface JsonEntry {
  path: string;
  kind: string;
  result: keyof SyncCounts;
  code?: string;
}

interface JsonReport {
  schemaVersion: number;
  runId: string;
  outcome: string;
  counts: SyncCounts;
  entries: JsonEntry[];
  warnings: unknown[];
}

async function runCli(argv: string[]) {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(argv, { stdout, stderr });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function parseSingleLine(text: string): unknown {
  expect(text.endsWith("\n")).toBe(true);
  const lines = text.slice(0, -1).split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
}

describe("command line", () => {
  it("prints a JSON report and exits 0 on success", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, {
      "a.txt": "content-marker-alpha",
      "dir/b.txt": "content-marker-beta",
    });
    await symlink("a.txt", path.join(fixture.source, "link"));

    const run = await runCli(syncArgs(fixture, "--json"));

    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const report = parseSingleLine(run.stdout) as JsonReport;
    expect(Object.keys(report)).toEqual([
      "schemaVersion",
      "runId",
      "outcome",
      "counts",
      "entries",
      "warnings",
    ]);
    expect(Object.keys(report.counts)).toEqual([
      "copied",
      "unchanged",
      "skipped",
      "failed",
      "cancelled",
    ]);
    expect(report.schemaVersion).toBe(1);
    expect(typeof report.runId).toBe("string");
    expect(report.outcome).toBe("complete");
    expect(report.warnings).toEqual([]);
    expect(report.entries).toEqual([
      { path: "a.txt", kind: "file", result: "copied" },
      { path: "dir", kind: "directory", result: "copied" },
      { path: "dir/b.txt", kind: "file", result: "copied" },
      { path: "link", kind: "symlink", result: "skipped", code: "symlink" },
    ]);
    for (const entry of report.entries) {
      expect(Object.keys(entry)).toEqual(
        entry.code === undefined ? ["path", "kind", "result"] : ["path", "kind", "result", "code"],
      );
    }
    const tallies: Record<keyof SyncCounts, number> = {
      copied: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const entry of report.entries) {
      tallies[entry.result] += 1;
    }
    expect(report.counts).toEqual(tallies);
    expect(run.stdout).not.toContain(fixture.base);
    expect(run.stdout).not.toContain("content-marker");

    const rerun = await runCli(syncArgs(fixture, "--json"));
    expect(rerun.code).toBe(0);
    const rerunReport = parseSingleLine(rerun.stdout) as JsonReport;
    expect(rerunReport.counts).toEqual({ copied: 0, unchanged: 3, skipped: 1, failed: 0, cancelled: 0 });
  });

  it("orders JSON entries by path segments", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, {
      "a.txt": "1",
      "a-b.txt": "2",
      "a/z.txt": "3",
      "a/b/c.txt": "4",
      "B.txt": "5",
    });

    const run = await runCli(syncArgs(fixture, "--json"));

    expect(run.code).toBe(0);
    const report = parseSingleLine(run.stdout) as JsonReport;
    expect(report.entries.map((entry) => entry.path)).toEqual([
      "B.txt",
      "a",
      "a/b",
      "a/b/c.txt",
      "a/z.txt",
      "a-b.txt",
      "a.txt",
    ]);
  });

  it("exits 3 with live-owner when the state root is owned", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const hold = holdAtDiscovery();
    const first = synchronize(
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.state },
      { observer: hold.observer },
    );
    await hold.reached;

    const jsonRun = await runCli(syncArgs(fixture, "--json"));
    const textRun = await runCli(syncArgs(fixture));

    hold.release();
    expect((await first).outcome).toBe("complete");

    expect(jsonRun.code).toBe(3);
    expect(jsonRun.stderr).toBe("");
    expect(jsonRun.stdout).toBe('{"schemaVersion":1,"outcome":"fatal","code":"live-owner"}\n');
    expect(textRun.code).toBe(3);
    expect(textRun.stdout).toBe("");
    expect(textRun.stderr).toBe("resync: live-owner\n");

    const after = await runCli(syncArgs(fixture, "--json"));
    expect(after.code).toBe(0);
  });

  it("exits 1 with usage for invalid arguments", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const invalid: string[][] = [
      [],
      ["copy", "--source", fixture.source, "--destination", fixture.destination, "--state", fixture.state],
      ["sync", "--source", fixture.source, "--destination", fixture.destination],
      ["sync", "--source", fixture.source, "--destination", fixture.destination, "--state"],
      ["sync", "--source", "--destination", fixture.destination, "--state", fixture.state],
      [...syncArgs(fixture), "--source", fixture.source],
      [...syncArgs(fixture), "--verbose"],
      [...syncArgs(fixture), "--concurrency", "0"],
      [...syncArgs(fixture), "--concurrency", "1.5"],
      [...syncArgs(fixture), "--concurrency", "01"],
      [...syncArgs(fixture), "extra"],
    ];

    for (const argv of invalid) {
      const textRun = await runCli(argv);
      expect(textRun.code).toBe(1);
      expect(textRun.stdout).toBe("");
      expect(textRun.stderr).toBe("resync: usage\n");

      const jsonRun = await runCli([...argv, "--json"]);
      expect(jsonRun.code).toBe(1);
      expect(jsonRun.stderr).toBe("");
      expect(jsonRun.stdout).toBe('{"schemaVersion":1,"outcome":"fatal","code":"usage"}\n');
    }

    expect(await isAbsent(fixture.destination)).toBe(true);
    expect(await isAbsent(fixture.state)).toBe(true);

    const missingSource = await runCli([
      "sync",
      "--source",
      path.join(fixture.base, "missing"),
      "--destination",
      fixture.destination,
      "--state",
      fixture.state,
      "--json",
    ]);
    expect(missingSource.code).toBe(1);
    expect(missingSource.stdout).toBe(
      '{"schemaVersion":1,"outcome":"fatal","code":"source-unavailable"}\n',
    );
  });

  it("accepts a positive concurrency limit", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha", "b.txt": "beta" });

    const run = await runCli(syncArgs(fixture, "--concurrency", "2", "--json"));

    expect(run.code).toBe(0);
    expect((parseSingleLine(run.stdout) as JsonReport).counts.copied).toBe(2);
  });

  it("prints a text summary without --json", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha", "dir/b.txt": "beta" });
    await symlink("a.txt", path.join(fixture.source, "link"));

    const first = await runCli(syncArgs(fixture));

    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(
      [
        "copied a.txt",
        "copied dir",
        "copied dir/b.txt",
        "skipped link (symlink)",
        "complete: 3 copied, 0 unchanged, 1 skipped, 0 failed, 0 cancelled",
        "",
      ].join("\n"),
    );

    const second = await runCli(syncArgs(fixture));
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(
      [
        "skipped link (symlink)",
        "complete: 0 copied, 3 unchanged, 1 skipped, 0 failed, 0 cancelled",
        "",
      ].join("\n"),
    );
  });
});
