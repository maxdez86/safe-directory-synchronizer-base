import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeFileOps, main, synchronize, type LifecycleEvent } from "../src/index.js";
import {
  captureStream,
  createFixture,
  recordingFileOps,
  useFixtures,
  writeTree,
} from "./helpers.js";

useFixtures();

describe("lifecycle events", () => {
  it("reports ordered phases for a changed file", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const events: LifecycleEvent[] = [];

    const result = await synchronize(
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.state },
      { observer: (event) => void events.push(event) },
    );

    expect(result.outcome).toBe("complete");
    const perEntry = events
      .filter((event) => event.path === "a.txt")
      .map((event) => `${event.phase}:${event.state}`);
    expect(perEntry).toEqual([
      "admission:pending",
      "admission:complete",
      "replacement-write:pending",
      "replacement-write:complete",
      "replacement-durable:pending",
      "replacement-durable:complete",
      "publication:pending",
      "publication:complete",
      "checkpoint:pending",
      "checkpoint:complete",
      "settlement:pending",
      "settlement:complete",
    ]);

    const indexOf = (phase: string, state: string) =>
      events.findIndex((event) => event.phase === phase && event.state === state);
    expect(indexOf("lock", "complete")).toBeGreaterThanOrEqual(0);
    expect(indexOf("lock", "complete")).toBeLessThan(indexOf("discovery", "pending"));
    expect(indexOf("discovery", "pending")).toBeLessThan(indexOf("discovery", "complete"));
    const last = events.at(-1);
    expect(last?.phase).toBe("release");
    expect(last?.state).toBe("complete");
  });

  it("events carry only run id, relative path, phase and state", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, {
      "a.txt": "content-marker-alpha",
      "dir/b.txt": "content-marker-beta",
    });
    const events: LifecycleEvent[] = [];

    const result = await synchronize(
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.state },
      {
        observer: async (event) => {
          await Promise.resolve();
          events.push(event);
        },
      },
    );

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      for (const key of Object.keys(event)) {
        expect(["runId", "path", "phase", "state"]).toContain(key);
      }
      expect(event.runId).toBe(result.runId);
      expect(["pending", "complete"]).toContain(event.state);
      if (event.path !== undefined) {
        expect(path.isAbsolute(event.path)).toBe(false);
        expect(event.path.includes("\\")).toBe(false);
        expect(["a.txt", "dir", "dir/b.txt"]).toContain(event.path);
      }
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(fixture.base);
      expect(serialized).not.toContain("content-marker");
    }
  });

  it("uses the injected file operations, clock and id factory", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const recorder = recordingFileOps(createNodeFileOps());
    const dependencies = {
      fileOps: recorder.fileOps,
      clock: { now: () => 1_700_000_000_000 },
      ids: () => "run-fixed",
    };

    const result = await synchronize(
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.state },
      dependencies,
    );

    expect(result.runId).toBe("run-fixed");
    expect(
      recorder.calls.some(
        (call) =>
          call.method === "openWrite" &&
          (call.path.startsWith(`${fixture.destination}${path.sep}`) ||
            call.path.startsWith(`${fixture.state}${path.sep}`)),
      ),
    ).toBe(true);

    const stdout = captureStream();
    const stderr = captureStream();
    await writeTree(fixture.source, { "b.txt": "beta" });
    const code = await main(
      [
        "sync",
        "--source",
        fixture.source,
        "--destination",
        fixture.destination,
        "--state",
        fixture.state,
        "--json",
      ],
      { stdout, stderr, dependencies },
    );
    expect(code).toBe(0);
    expect(stderr.text()).toBe("");
    expect((JSON.parse(stdout.text()) as { runId: string }).runId).toBe("run-fixed");
  });
});
