import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SyncError, synchronize } from "../src/index.js";
import { createFixture, holdAtDiscovery, useFixtures, writeTree } from "./helpers.js";

useFixtures();

describe("state root ownership", () => {
  it("refuses a second run while the first owns the state root", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const options = {
      sourceRoot: fixture.source,
      destinationRoot: fixture.destination,
      stateRoot: fixture.state,
    };
    const hold = holdAtDiscovery();

    const first = synchronize(options, { observer: hold.observer });
    await hold.reached;

    const second = await synchronize(options).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(second).toBeInstanceOf(SyncError);
    expect((second as SyncError).code).toBe("live-owner");

    const otherDestination = await synchronize({
      ...options,
      destinationRoot: path.join(fixture.base, "other-destination"),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((otherDestination as SyncError).code).toBe("live-owner");

    hold.release();
    const firstResult = await first;
    expect(firstResult.outcome).toBe("complete");
    expect(firstResult.counts.copied).toBe(1);
    expect(await readFile(path.join(fixture.destination, "a.txt"), "utf8")).toBe("alpha");

    const third = await synchronize(options);
    expect(third.outcome).toBe("complete");
  });

  it("allows a new run after the owner finishes", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const options = {
      sourceRoot: fixture.source,
      destinationRoot: fixture.destination,
      stateRoot: fixture.state,
    };

    const first = await synchronize(options);
    expect(first.outcome).toBe("complete");

    await writeTree(fixture.source, { "b.txt": "beta" });
    const second = await synchronize(options);
    expect(second.outcome).toBe("complete");
    expect(second.entries.map((entry) => [entry.path, entry.result])).toEqual([
      ["a.txt", "unchanged"],
      ["b.txt", "copied"],
    ]);

    const third = await synchronize(options);
    expect(third.outcome).toBe("complete");
    expect(third.counts.unchanged).toBe(2);
  });
});
