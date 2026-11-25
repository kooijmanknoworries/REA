import { createHash } from "node:crypto";
import type { PathLike } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Models a macOS virtiofs share (Apple container, Colima vz): after a
// directory chmod, lstat through its path reports a new inode number while
// open handles keep the old one. Files are unaffected.
const mount = vi.hoisted(() => ({
  restrictedDirectories: new Set<string>(),
  renumbered: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const renumberDirectory = async (path: PathLike) => {
    if ((await actual.lstat(path)).isDirectory())
      mount.renumbered.add(String(path));
  };
  return {
    ...actual,
    // A umask that removes owner bits leaves a directory REA must repair.
    mkdir: async (...arguments_: Parameters<typeof actual.mkdir>) => {
      const created = await actual.mkdir(...arguments_);
      const path = String(arguments_[0]);
      if (mount.restrictedDirectories.has(path))
        await actual.chmod(path, 0o500);
      return created;
    },
    lstat: (async (path: PathLike, options?: { bigint?: boolean }) => {
      const metadata = await actual.lstat(path, options);
      if (metadata.isDirectory() && mount.renumbered.has(String(path)))
        metadata.ino =
          typeof metadata.ino === "bigint"
            ? metadata.ino + 1n
            : metadata.ino + 1;
      return metadata;
    }) as typeof actual.lstat,
    chmod: async (path: PathLike, mode: string | number) => {
      await actual.chmod(path, mode);
      await renumberDirectory(path);
    },
    open: (async (path: PathLike, ...rest: unknown[]) => {
      const handle = await (
        actual.open as (
          ...arguments_: unknown[]
        ) => ReturnType<typeof actual.open>
      )(path, ...rest);
      const chmod = handle.chmod.bind(handle);
      handle.chmod = async (mode) => {
        await chmod(mode);
        await renumberDirectory(path);
      };
      return handle;
    }) as typeof actual.open,
  };
});

const { SafeOutputTree } =
  await import("../../../src/resources/SafeOutputTree.js");

const content = (text: string) => ({
  sha256: createHash("sha256").update(text).digest("hex"),
  bytes: Buffer.byteLength(text),
});

describe("safe artifact output on a mount that renumbers directories on chmod", () => {
  it.skipIf(process.platform === "win32")(
    "publishes a nested tree whose directories already have owner-only access",
    async () => {
      const parent = await createTestTempDirectory("rea-renumbered-output-");
      const output = join(parent, "published");
      const tree = await SafeOutputTree.create(output);
      await tree.write(
        "squashfs-root/etc/hostname",
        Readable.from(Buffer.from("device")),
        content("device"),
      );
      await tree.commit();
      expect(mount.renumbered).toEqual(new Set());
      expect(
        await readFile(join(output, "squashfs-root/etc/hostname"), "utf8"),
      ).toBe("device");
      await tree.closeHandles();
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "still refuses a directory whose identity changes after REA repairs its mode",
    async () => {
      const parent = await createTestTempDirectory("rea-renumbered-repair-");
      const output = join(parent, "published");
      const nested = join(output, "restricted");
      mount.restrictedDirectories.add(nested);
      try {
        const tree = await SafeOutputTree.create(output);
        const failure = await tree
          .write(
            "restricted/file",
            Readable.from(Buffer.from("x")),
            content("x"),
          )
          .catch((cause: unknown) => cause);
        expect(failure).toMatchObject({
          message: `Extraction directory identity changed: ${nested}`,
        });
        await tree.rollback().catch(() => undefined);
        await tree.closeHandles();
      } finally {
        mount.restrictedDirectories.clear();
        mount.renumbered.clear();
      }
    },
  );
});
