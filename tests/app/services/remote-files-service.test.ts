import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  initBrowserRoots,
  __resetBrowserRootsForTests,
} from "../../../src/app/services/file-browser-service.js";
import {
  readTextFilePreview,
  resolveRemoteDirectory,
  rememberRemoteDirectory,
  clearRemoteDirectory,
  REMOTE_FILES_PAGE_SIZE,
  __resetRemoteDirectoriesForTests,
  scanRemoteDirectory,
} from "../../../src/app/services/remote-files-service.js";

describe("remote-files-service", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "remote-files-test-")));
    __resetBrowserRootsForTests();
    initBrowserRoots(rootDir);
    __resetRemoteDirectoriesForTests();
  });

  afterEach(async () => {
    __resetBrowserRootsForTests();
    __resetRemoteDirectoriesForTests();
    await rm(rootDir, { recursive: true, force: true });
  });

  describe("scanRemoteDirectory", () => {
    it("lists directories before files and counts both", async () => {
      const workDir = path.join(rootDir, "work");
      await fs.mkdir(workDir);
      await fs.mkdir(path.join(workDir, "zeta"));
      await fs.writeFile(path.join(workDir, "alpha.txt"), "a");
      await fs.writeFile(path.join(workDir, "beta.txt"), "bb");

      const result = await scanRemoteDirectory(workDir);
      expect("error" in result).toBe(false);
      if ("error" in result) {
        return;
      }

      expect(result.entries.map((entry) => entry.name)).toEqual(["zeta", "alpha.txt", "beta.txt"]);
      expect(result.directoryCount).toBe(1);
      expect(result.fileCount).toBe(2);
      expect(result.totalCount).toBe(3);
      expect(result.hasParent).toBe(true);
    });

    it("reports file sizes for the visible page only", async () => {
      await fs.writeFile(path.join(rootDir, "sized.txt"), "x".repeat(2048));

      const result = await scanRemoteDirectory(rootDir);
      if ("error" in result) {
        throw new Error(result.error);
      }

      const entry = result.entries.find((candidate) => candidate.name === "sized.txt");
      expect(entry?.size).toBe(2048);
      expect(entry?.type).toBe("file");
    });

    it("treats the configured root as having no parent", async () => {
      const result = await scanRemoteDirectory(rootDir);
      if ("error" in result) {
        throw new Error(result.error);
      }

      expect(result.hasParent).toBe(false);
      expect(result.parentPath).toBeNull();
    });

    it("paginates large directories", async () => {
      const names = Array.from(
        { length: REMOTE_FILES_PAGE_SIZE + 3 },
        (_, index) => `f${index}.txt`,
      );
      await Promise.all(names.map((name) => fs.writeFile(path.join(rootDir, name), "x")));

      const first = await scanRemoteDirectory(rootDir, 0);
      if ("error" in first) {
        throw new Error(first.error);
      }

      expect(first.entries).toHaveLength(REMOTE_FILES_PAGE_SIZE);
      expect(first.totalPages).toBe(2);

      const second = await scanRemoteDirectory(rootDir, 1);
      if ("error" in second) {
        throw new Error(second.error);
      }

      expect(second.entries).toHaveLength(3);
      expect(second.page).toBe(1);
    });

    it("clamps an out-of-range page instead of failing", async () => {
      const result = await scanRemoteDirectory(rootDir, 99);
      if ("error" in result) {
        throw new Error(result.error);
      }

      expect(result.page).toBe(0);
    });

    it("returns an error for a missing directory", async () => {
      const result = await scanRemoteDirectory(path.join(rootDir, "nope"));
      expect("error" in result).toBe(true);
    });
  });

  describe("readTextFilePreview", () => {
    it("returns the head of a text file", async () => {
      const filePath = path.join(rootDir, "note.txt");
      await fs.writeFile(filePath, "line one\nline two\n", "utf-8");

      const preview = await readTextFilePreview(filePath);
      if ("error" in preview) {
        throw new Error(preview.error);
      }

      expect(preview.text).toBe("line one\nline two\n");
      expect(preview.truncated).toBe(false);
    });

    it("refuses binary files", async () => {
      const filePath = path.join(rootDir, "blob.bin");
      await fs.writeFile(filePath, Buffer.from([0x01, 0x00, 0x02]));

      const preview = await readTextFilePreview(filePath);
      expect(preview).toEqual({ error: "Binary file" });
    });

    it("refuses a directory", async () => {
      const preview = await readTextFilePreview(rootDir);
      expect("error" in preview).toBe(true);
    });
  });

  describe("remembered directories", () => {
    it("returns a directory inside the allowed roots", () => {
      rememberRemoteDirectory(7, rootDir);
      expect(resolveRemoteDirectory(7)).toBe(rootDir);
    });

    it("drops a directory that fell outside the roots", () => {
      rememberRemoteDirectory(7, path.join(os.tmpdir(), "elsewhere"));
      expect(resolveRemoteDirectory(7)).toBeNull();
    });

    it("forgets the directory when cleared", () => {
      rememberRemoteDirectory(7, rootDir);
      clearRemoteDirectory(7);
      expect(resolveRemoteDirectory(7)).toBeNull();
    });

    it("ignores an unknown user", () => {
      expect(resolveRemoteDirectory(undefined)).toBeNull();
    });
  });
});
