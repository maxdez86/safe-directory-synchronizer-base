import type { Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import type { EntryKind, FileOps, ReadHandle, WriteHandle } from "./types.js";

function kindOf(stats: Stats): EntryKind {
  if (stats.isFile()) {
    return "file";
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  if (stats.isSymbolicLink()) {
    return "symlink";
  }
  return "special";
}

/** Creates the production `FileOps` adapter backed by `node:fs/promises`. */
export function createNodeFileOps(): FileOps {
  return {
    async lstat(path) {
      const stats = await lstat(path);
      return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
    },

    realpath(path) {
      return realpath(path);
    },

    readdir(path) {
      return readdir(path);
    },

    async readFile(path) {
      const bytes = await readFile(path);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },

    async openRead(path): Promise<ReadHandle> {
      const handle = await open(path, "r");
      return {
        async read(maxBytes) {
          const buffer = new Uint8Array(maxBytes);
          const { bytesRead } = await handle.read(buffer, 0, maxBytes, null);
          return buffer.subarray(0, bytesRead);
        },
        close() {
          return handle.close();
        },
      };
    },

    async openWrite(path, mode): Promise<WriteHandle> {
      const handle = await open(path, mode === "exclusive" ? "wx" : "w");
      return {
        async write(bytes) {
          let offset = 0;
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.byteLength - offset,
              null,
            );
            offset += bytesWritten;
          }
        },
        sync() {
          return handle.sync();
        },
        close() {
          return handle.close();
        },
      };
    },

    async mkdir(path) {
      await mkdir(path);
    },

    async rm(path) {
      const stats = await lstat(path);
      if (stats.isDirectory()) {
        await rmdir(path);
      } else {
        await unlink(path);
      }
    },
  };
}
