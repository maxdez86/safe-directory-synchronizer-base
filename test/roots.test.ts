import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SyncError, synchronize, type FatalCode, type SyncOptions } from "../src/index.js";
import { createFixture, isAbsent, useFixtures, writeTree } from "./helpers.js";

useFixtures();

async function expectFatal(options: SyncOptions, code: FatalCode): Promise<void> {
  const outcome = await synchronize(options).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(SyncError);
  expect((outcome as SyncError).code).toBe(code);
}

describe("root validation", () => {
  it("rejects identical roots", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });

    await expectFatal(
      { sourceRoot: fixture.source, destinationRoot: fixture.source, stateRoot: fixture.state },
      "overlapping-roots",
    );
    await expectFatal(
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.source },
      "overlapping-roots",
    );
    await expectFatal(
      {
        sourceRoot: fixture.source,
        destinationRoot: fixture.destination,
        stateRoot: `${fixture.destination}${path.sep}.${path.sep}`,
      },
      "overlapping-roots",
    );

    expect(await isAbsent(fixture.destination)).toBe(true);
    expect(await isAbsent(fixture.state)).toBe(true);
  });

  it("rejects nested roots in every direction", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const outer = path.join(fixture.base, "outer");
    const inner = path.join(outer, "inner");
    const insideSource = path.join(fixture.source, "inner");
    const cases: SyncOptions[] = [
      { sourceRoot: fixture.source, destinationRoot: insideSource, stateRoot: fixture.state },
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: insideSource },
      { sourceRoot: fixture.source, destinationRoot: fixture.base, stateRoot: fixture.state },
      { sourceRoot: fixture.source, destinationRoot: fixture.destination, stateRoot: fixture.base },
      { sourceRoot: fixture.source, destinationRoot: outer, stateRoot: inner },
      { sourceRoot: fixture.source, destinationRoot: inner, stateRoot: outer },
    ];

    for (const options of cases) {
      await expectFatal(options, "overlapping-roots");
    }

    expect(await isAbsent(insideSource)).toBe(true);
    expect(await isAbsent(outer)).toBe(true);
    expect(await isAbsent(fixture.destination)).toBe(true);
    expect(await isAbsent(fixture.state)).toBe(true);
    expect(await isAbsent(path.join(fixture.base, "owner.lock"))).toBe(true);
  });

  it("rejects roots that overlap through a symbolic link", async () => {
    const fixture = await createFixture();
    await writeTree(fixture.source, { "a.txt": "alpha" });
    const alias = path.join(fixture.base, "alias");
    await symlink(fixture.source, alias);

    await expectFatal(
      { sourceRoot: fixture.source, destinationRoot: path.join(alias, "out"), stateRoot: fixture.state },
      "overlapping-roots",
    );
    await expectFatal(
      { sourceRoot: alias, destinationRoot: fixture.destination, stateRoot: fixture.source },
      "overlapping-roots",
    );

    expect(await isAbsent(path.join(fixture.source, "out"))).toBe(true);
    expect(await isAbsent(fixture.destination)).toBe(true);
    expect(await isAbsent(fixture.state)).toBe(true);
  });

  it("reports a missing source as source-unavailable", async () => {
    const fixture = await createFixture();
    const plainFile = path.join(fixture.base, "plain.txt");
    await writeFile(plainFile, "not a directory");

    await expectFatal(
      {
        sourceRoot: path.join(fixture.base, "missing"),
        destinationRoot: fixture.destination,
        stateRoot: fixture.state,
      },
      "source-unavailable",
    );
    await expectFatal(
      { sourceRoot: plainFile, destinationRoot: fixture.destination, stateRoot: fixture.state },
      "source-unavailable",
    );

    expect(await isAbsent(fixture.destination)).toBe(true);
    expect(await isAbsent(fixture.state)).toBe(true);
  });
});
