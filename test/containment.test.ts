import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeFileOps, synchronize } from "../src/index.js";
import {
  createFixture,
  isAbsent,
  readTree,
  recordingFileOps,
  useFixtures,
  writeTree,
} from "./helpers.js";

useFixtures();

async function listenOnSocket(socketPath: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve();
    });
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

describe("containment", () => {
  it("skips symbolic links without following them", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.base, "outside");
    await writeTree(outside, { "secret.txt": "outside every root" });
    await writeTree(fixture.source, { "real/inner.txt": "inside" });
    await symlink(path.join(outside, "secret.txt"), path.join(fixture.source, "file-link"));
    await symlink(path.join(fixture.source, "real"), path.join(fixture.source, "dir-link"));
    const recorder = recordingFileOps(createNodeFileOps());

    const result = await synchronize(
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.state },
      { fileOps: recorder.fileOps },
    );

    expect(result.outcome).toBe("complete");
    expect(result.entries).toEqual([
      { path: "dir-link", kind: "symlink", result: "skipped", code: "symlink" },
      { path: "file-link", kind: "symlink", result: "skipped", code: "symlink" },
      { path: "real", kind: "directory", result: "copied" },
      { path: "real/inner.txt", kind: "file", result: "copied" },
    ]);
    expect(await isAbsent(path.join(fixture.destination, "file-link"))).toBe(true);
    expect(await isAbsent(path.join(fixture.destination, "dir-link"))).toBe(true);
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside every root");

    const followed = recorder.calls.filter(
      (call) =>
        call.method !== "lstat" &&
        (call.path.startsWith(path.join(fixture.source, "file-link")) ||
          call.path.startsWith(path.join(fixture.source, "dir-link")) ||
          call.path.startsWith(outside)),
    );
    expect(followed).toEqual([]);
  });

  it("skips special files", async () => {
    const fixture = await createFixture();
    const server = await listenOnSocket(path.join(fixture.source, "control.sock"));
    try {
      const result = await synchronize({
        sourceRoot: fixture.source,
        destinationRoot: fixture.destination,
        stateRoot: fixture.state,
      });

      expect(result.outcome).toBe("complete");
      expect(result.entries).toEqual([
        { path: "control.sock", kind: "special", result: "skipped", code: "special" },
      ]);
      expect(result.counts.skipped).toBe(1);
      expect(await isAbsent(path.join(fixture.destination, "control.sock"))).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("copies regular files next to skipped entries", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.source, "mixed"));
    await writeFile(path.join(fixture.source, "mixed", "a.txt"), "first");
    await symlink("a.txt", path.join(fixture.source, "mixed", "b-link"));
    await writeFile(path.join(fixture.source, "mixed", "c.txt"), "third");
    const server = await listenOnSocket(path.join(fixture.source, "mixed", "d.sock"));
    await writeFile(path.join(fixture.source, "mixed", "e.txt"), "fifth");
    try {
      const result = await synchronize({
        sourceRoot: fixture.source,
        destinationRoot: fixture.destination,
        stateRoot: fixture.state,
      });

      expect(result.outcome).toBe("complete");
      expect(result.counts).toEqual({ copied: 4, unchanged: 0, skipped: 2, failed: 0, cancelled: 0 });
      expect(await readTree(fixture.destination)).toEqual({
        mixed: "dir",
        "mixed/a.txt": (await readTree(fixture.source))["mixed/a.txt"],
        "mixed/c.txt": (await readTree(fixture.source))["mixed/c.txt"],
        "mixed/e.txt": (await readTree(fixture.source))["mixed/e.txt"],
      });
    } finally {
      await closeServer(server);
    }
  });
});
