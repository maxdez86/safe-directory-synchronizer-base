import { describe, expect, it } from "vitest";
import { synchronize } from "../src/index.js";
import { createFixture, patternBytes, readTree, useFixtures, writeTree } from "./helpers.js";

useFixtures();

describe("entry names", () => {
  it("synchronizes directories named dist and build", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, {
      "dist/a.js": "export const a = 1;\n",
      "build/nested/b.txt": patternBytes(70_000, 11),
      "pkg/dist/c.txt": "c\n",
    });

    const result = await synchronize({
      sourceRoot: fixture.source,
      destinationRoot: fixture.destination,
      stateRoot: fixture.state,
    });

    expect(result.outcome).toBe("complete");
    expect(result.counts.skipped).toBe(0);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "build",
      "build/nested",
      "build/nested/b.txt",
      "dist",
      "dist/a.js",
      "pkg",
      "pkg/dist",
      "pkg/dist/c.txt",
    ]);
    expect(await readTree(fixture.destination)).toEqual(await readTree(fixture.source));
  });
});
