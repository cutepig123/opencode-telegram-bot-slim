import { promises as fs } from "node:fs";
import path from "node:path";
import {
  getParentPath,
  isAllowedRoot,
  isWithinAllowedRoot,
  joinPath,
  pathToDisplayPath,
} from "./file-browser-service.js";

export interface RemoteFileEntry {
  name: string;
  fullPath: string;
  type: "file" | "directory";
  size: number;
}

export interface RemoteDirectoryScan {
  entries: RemoteFileEntry[];
  totalCount: number;
  directoryCount: number;
  fileCount: number;
  page: number;
  totalPages: number;
  currentPath: string;
  displayPath: string;
  hasParent: boolean;
  parentPath: string | null;
}

export interface RemoteFileDetails {
  name: string;
  fullPath: string;
  displayPath: string;
  size: number;
  modified: Date;
}

export const REMOTE_FILES_PAGE_SIZE = 10;

const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_MAX_LINES = 200;

function sortEntries(entries: RemoteFileEntry[]): void {
  entries.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

export async function scanRemoteDirectory(
  dirPath: string,
  page: number = 0,
): Promise<RemoteDirectoryScan | { error: string }> {
  let dirents;
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }

  const entries: RemoteFileEntry[] = [];
  let directoryCount = 0;
  let fileCount = 0;

  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      entries.push({
        name: dirent.name,
        fullPath: joinPath(dirPath, dirent.name),
        type: "directory",
        size: 0,
      });
      directoryCount += 1;
      continue;
    }

    entries.push({
      name: dirent.name,
      fullPath: joinPath(dirPath, dirent.name),
      type: "file",
      size: 0,
    });
    fileCount += 1;
  }

  sortEntries(entries);

  const totalPages = Math.max(1, Math.ceil(entries.length / REMOTE_FILES_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * REMOTE_FILES_PAGE_SIZE;
  const visible = entries.slice(start, start + REMOTE_FILES_PAGE_SIZE);

  // Only the visible page is stat'ed: a symlink to a directory and a file of unknown
  // size both need the real answer, but doing it for every entry would be wasteful.
  for (const entry of visible) {
    try {
      const stat = await fs.stat(entry.fullPath);
      if (stat.isDirectory()) {
        entry.type = "directory";
        entry.size = 0;
      } else {
        entry.type = "file";
        entry.size = stat.size;
      }
    } catch {
      // Keep the dirent-based guess for broken links and permission errors.
    }
  }

  const atRoot = isAllowedRoot(dirPath);

  return {
    entries: visible,
    totalCount: entries.length,
    directoryCount,
    fileCount,
    page: safePage,
    totalPages,
    currentPath: dirPath,
    displayPath: pathToDisplayPath(dirPath),
    hasParent: !atRoot,
    parentPath: atRoot ? null : getParentPath(dirPath),
  };
}

export async function getRemoteFileDetails(
  filePath: string,
): Promise<RemoteFileDetails | { error: string }> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { error: "Path is not a file" };
    }

    return {
      name: filePath.split(/[\\/]/).pop() ?? filePath,
      fullPath: filePath,
      displayPath: pathToDisplayPath(filePath),
      size: stat.size,
      modified: stat.mtime,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export interface TextFilePreview {
  text: string;
  truncated: boolean;
}

/**
 * Reads the head of a text file for an in-chat preview. Binary files are refused by
 * looking for a NUL byte, which is the same heuristic Git uses.
 */
export async function readTextFilePreview(
  filePath: string,
): Promise<TextFilePreview | { error: string }> {
  let handle;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return { error: "Path is not a file" };
    }

    handle = await fs.open(filePath, "r");
    const length = Math.min(stat.size, PREVIEW_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const chunk = buffer.subarray(0, bytesRead);

    if (chunk.includes(0)) {
      return { error: "Binary file" };
    }

    const lines = chunk.toString("utf8").split(/\r\n|\r|\n/);
    return {
      text: lines.slice(0, PREVIEW_MAX_LINES).join("\n"),
      truncated: stat.size > bytesRead || lines.length > PREVIEW_MAX_LINES,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

const lastDirectories = new Map<number, string>();

export function rememberRemoteDirectory(userId: number | undefined, directory: string): void {
  if (userId) {
    lastDirectories.set(userId, directory);
  }
}

export function clearRemoteDirectory(userId: number | undefined): void {
  if (userId) {
    lastDirectories.delete(userId);
  }
}

export function resolveRemoteDirectory(userId: number | undefined): string | null {
  if (!userId) {
    return null;
  }

  const remembered = lastDirectories.get(userId);
  if (remembered && isWithinAllowedRoot(remembered)) {
    return remembered;
  }

  return null;
}

export type RemoteDeleteTarget = "file" | "directory";

export interface RemoteDeleteResult {
  name: string;
  fullPath: string;
  target: RemoteDeleteTarget;
}

/**
 * Removes a file, or a directory only when it is empty.
 *
 * A recursive delete is deliberately not offered: one mis-tap in a chat should not
 * be able to wipe a tree, and the caller only ever confirms a single visible name.
 */
export async function deleteRemoteEntry(
  entryPath: string,
): Promise<RemoteDeleteResult | { error: string }> {
  let stat;
  try {
    stat = await fs.lstat(entryPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }

  const name = path.basename(entryPath);

  if (stat.isDirectory()) {
    try {
      const children = await fs.readdir(entryPath);
      if (children.length > 0) {
        return { error: "Directory is not empty" };
      }
      await fs.rmdir(entryPath);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Unknown error" };
    }
    return { name, fullPath: entryPath, target: "directory" };
  }

  if (!stat.isFile() && !stat.isSymbolicLink()) {
    return { error: "Path is not a file or directory" };
  }

  try {
    await fs.unlink(entryPath);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }

  return { name, fullPath: entryPath, target: "file" };
}

export async function getRemoteDeleteTarget(entryPath: string): Promise<RemoteDeleteTarget | null> {
  try {
    const stat = await fs.lstat(entryPath);
    if (stat.isDirectory()) {
      return "directory";
    }
    if (stat.isFile() || stat.isSymbolicLink()) {
      return "file";
    }
    return null;
  } catch {
    return null;
  }
}

export function __resetRemoteDirectoriesForTests(): void {
  lastDirectories.clear();
}
