import { lstat, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { synchronize } from "../src/index.js";
import { createFixture, patternBytes, readTree, useFixtures, writeTree } from "./helpers.js";

useFixtures();

function roots(fixture: { source: string; destination: string; state: string }) {
  return {
    sourceRoot: fixture.source,
    destinationRoot: fixture.destination,
    stateRoot: fixture.state,
  };
}

describe("synchronization", () => {
  it("copies a nested tree into an empty destination", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, {
      "top.txt": "top level\n",
      "docs-like/readme.md": "# heading\n",
      "nested/deeper/deepest/leaf.txt": "leaf\n",
      "nested/large.bin": patternBytes(300_000, 7),
      "nested/empty.txt": "",
    });

    const result = await synchronize(roots(fixture));

    expect(result.outcome).toBe("complete");
    expect(await readTree(fixture.destination)).toEqual(await readTree(fixture.source));
    expect(result.entries.map((entry) => [entry.path, entry.kind, entry.result])).toEqual([
      ["docs-like", "directory", "copied"],
      ["docs-like/readme.md", "file", "copied"],
      ["nested", "directory", "copied"],
      ["nested/deeper", "directory", "copied"],
      ["nested/deeper/deepest", "directory", "copied"],
      ["nested/deeper/deepest/leaf.txt", "file", "copied"],
      ["nested/empty.txt", "file", "copied"],
      ["nested/large.bin", "file", "copied"],
      ["top.txt", "file", "copied"],
    ]);
    expect(result.counts).toEqual({ copied: 9, unchanged: 0, skipped: 0, failed: 0, cancelled: 0 });
    expect(result.warnings).toEqual([]);
  });

  it("rewrites a changed file on the next run", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "one", "b/c.txt": "first version" });
    expect((await synchronize(roots(fixture))).outcome).toBe("complete");

    const sameSize = path.join(fixture.source, "a.txt");
    await writeFile(sameSize, "two");
    const later = new Date(Date.now() + 60_000);
    await utimes(sameSize, later, later);
    await writeFile(path.join(fixture.source, "b", "c.txt"), "a longer second version");

    const result = await synchronize(roots(fixture));

    expect(result.outcome).toBe("complete");
    const byPath = Object.fromEntries(result.entries.map((entry) => [entry.path, entry.result]));
    expect(byPath).toEqual({ "a.txt": "copied", b: "unchanged", "b/c.txt": "copied" });
    expect(await readFile(path.join(fixture.destination, "a.txt"), "utf8")).toBe("two");
    expect(await readFile(path.join(fixture.destination, "b", "c.txt"), "utf8")).toBe(
      "a longer second version",
    );
  });

  it("reports unchanged files without rewriting them", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha", "dir/b.txt": "beta" });
    expect((await synchronize(roots(fixture))).outcome).toBe("complete");

    const past = new Date(1_000_000_000);
    const copies = [path.join(fixture.destination, "a.txt"), path.join(fixture.destination, "dir", "b.txt")];
    for (const copy of copies) {
      await utimes(copy, past, past);
    }

    const result = await synchronize(roots(fixture));

    expect(result.outcome).toBe("complete");
    expect(result.entries.map((entry) => [entry.path, entry.result])).toEqual([
      ["a.txt", "unchanged"],
      ["dir", "unchanged"],
      ["dir/b.txt", "unchanged"],
    ]);
    expect(result.counts).toEqual({ copied: 0, unchanged: 3, skipped: 0, failed: 0, cancelled: 0 });
    for (const copy of copies) {
      expect((await stat(copy)).mtimeMs).toBe(past.getTime());
    }
  });

  it("keeps destination-only files and directories", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "shared/file.txt": "from source" });
    await writeTree(fixture.destination, {
      "extra.txt": "only in destination",
      "extra-dir/nested/keep.txt": "keep me",
      "shared/local.txt": "local addition",
    });

    const result = await synchronize(roots(fixture));

    expect(result.outcome).toBe("complete");
    expect(result.entries.map((entry) => entry.path)).toEqual(["shared", "shared/file.txt"]);
    expect(await readFile(path.join(fixture.destination, "extra.txt"), "utf8")).toBe(
      "only in destination",
    );
    expect(
      await readFile(path.join(fixture.destination, "extra-dir", "nested", "keep.txt"), "utf8"),
    ).toBe("keep me");
    expect(await readFile(path.join(fixture.destination, "shared", "local.txt"), "utf8")).toBe(
      "local addition",
    );
    expect(await readFile(path.join(fixture.destination, "shared", "file.txt"), "utf8")).toBe(
      "from source",
    );
  });

  it("does not modify the source tree", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, {
      "a.txt": "alpha",
      "dir/b.bin": patternBytes(100_000, 3),
      "dir/sub/c.txt": "gamma",
    });
    const describeSource = async () => {
      const tree = await readTree(fixture.source);
      const details: Record<string, [string, number, number]> = {};
      for (const [relative, summary] of Object.entries(tree)) {
        const stats = await lstat(path.join(fixture.source, ...relative.split("/")));
        details[relative] = [summary, stats.mode, stats.isDirectory() ? 0 : stats.mtimeMs];
      }
      return details;
    };
    const before = await describeSource();

    expect((await synchronize(roots(fixture))).outcome).toBe("complete");
    expect((await synchronize(roots(fixture))).outcome).toBe("complete");

    expect(await describeSource()).toEqual(before);
  });
});
