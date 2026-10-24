import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "@grammyjs/types";
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
  clearFilesPathIndex,
  decodeFilesDeleteCallback,
  decodeFilesDownloadCallback,
  decodeFilesFileCallback,
  decodeFilesNavCallback,
  FILES_CALLBACK_DOWNLOAD_PREFIX,
  FILES_CALLBACK_FILE_PREFIX,
  buildFilesPreviewKeyboard,
  buildFilesPreviewText,
  renderFilesBrowseView,
  renderFilesFileDetailsView,
} from "../../../src/bot/menus/remote-files-menu.js";

function callbackDataOf(view: { keyboard: InlineKeyboard }): string[] {
  return view.keyboard.inline_keyboard.flat().map((button) => callbackData(button));
}

// grammY types the button union with GameButton, which has no callback_data field.
function callbackData(button: InlineKeyboardButton): string {
  return "callback_data" in button ? (button.callback_data ?? "") : "";
}

function buttonTexts(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard.flat().map((button) => button.text);
}

describe("bot/menus/remote-files-menu", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "remote-menu-test-")));
    __resetBrowserRootsForTests();
    initBrowserRoots(rootDir);
    clearFilesPathIndex();
  });

  afterEach(async () => {
    __resetBrowserRootsForTests();
    clearFilesPathIndex();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("offers directories and files, and round-trips their callbacks", async () => {
    await fs.mkdir(path.join(rootDir, "docs"));
    await fs.writeFile(path.join(rootDir, "readme.txt"), "hello");

    const view = await renderFilesBrowseView(rootDir);
    if ("error" in view) {
      throw new Error(view.error);
    }

    const rows = view.keyboard.inline_keyboard;
    // A folder row carries its own delete button, so it reads [label, trash].
    const folderRow = rows[0] ?? [];
    expect(folderRow[0]?.text).toBe("📁 docs");
    expect(folderRow[1]?.text).toBe("🗑");

    const dirCallback = folderRow[0] ? callbackData(folderRow[0]) : "";
    expect(decodeFilesNavCallback(dirCallback)).toBe(path.join(rootDir, "docs"));
    expect(decodeFilesDeleteCallback(folderRow[1] ? callbackData(folderRow[1]) : "")?.path).toBe(
      path.join(rootDir, "docs"),
    );

    const fileRow = rows.find((row) => row[0]?.text.startsWith("📄 readme.txt")) ?? [];
    expect(fileRow[0]?.text).toBe("📄 readme.txt · 5B");
    const fileCallback = fileRow[0] ? callbackData(fileRow[0]) : "";
    const decoded = decodeFilesFileCallback(fileCallback);
    expect(decoded?.path).toBe(path.join(rootDir, "readme.txt"));
    expect(decoded?.page).toBe(0);
  });

  it("offers download for a file within the Telegram limit", async () => {
    const filePath = path.join(rootDir, "huge.bin");
    await fs.writeFile(filePath, Buffer.alloc(1024));

    const view = await renderFilesFileDetailsView(filePath, 0);
    if ("error" in view) {
      throw new Error(view.error);
    }

    expect(
      callbackDataOf(view).some((data) => data.startsWith(FILES_CALLBACK_DOWNLOAD_PREFIX)),
    ).toBe(true);
  });

  it("omits preview for binary files", async () => {
    const filePath = path.join(rootDir, "image.png");
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const view = await renderFilesFileDetailsView(filePath, 0);
    if ("error" in view) {
      throw new Error(view.error);
    }

    const labels = buttonTexts(view.keyboard);
    expect(labels.some((label) => label.includes("Preview"))).toBe(false);
    expect(labels.some((label) => label.includes("Download"))).toBe(true);
  });

  it("keeps long CJK paths inside the callback byte limit", async () => {
    const deepDir = path.join(rootDir, "非常深的一个目录名称用于测试回调长度限制");
    await fs.mkdir(deepDir);
    const filePath = path.join(deepDir, "另一个很长的中文文件名称.txt");
    await fs.writeFile(filePath, "hi");

    const view = await renderFilesBrowseView(deepDir);
    if ("error" in view) {
      throw new Error(view.error);
    }

    const callbacks = view.keyboard.inline_keyboard
      .flat()
      .map((button) => callbackData(button))
      .filter((data) => data.length > 0);

    for (const data of callbacks) {
      expect(Buffer.byteLength(data, "utf-8")).toBeLessThanOrEqual(64);
    }

    const fileCallback =
      callbacks.find((data) => data.startsWith(FILES_CALLBACK_FILE_PREFIX)) ?? "";
    expect(decodeFilesFileCallback(fileCallback)?.path).toBe(filePath);
  });

  it("truncates a long preview and says so", () => {
    const text = buildFilesPreviewText("big.log", 4096, {
      text: "x".repeat(5000),
      truncated: true,
    });

    expect(text).toContain("<pre>");
    expect(text).toContain("...");
    expect(text).toContain("preview truncated");
  });

  it("omits download for an oversized file in the preview keyboard", () => {
    const keyboard = buildFilesPreviewKeyboard("D:/huge.bin", 0, 200 * 1024 * 1024);
    const callbacks = keyboard.inline_keyboard.flat().map((button) => callbackData(button));

    expect(callbacks.some((data) => data.startsWith(FILES_CALLBACK_DOWNLOAD_PREFIX))).toBe(false);
  });

  it("decodes a download callback to its path", () => {
    const filePath = path.join(rootDir, "small.txt");
    const view = buildFilesPreviewKeyboard(filePath, 0, 10);
    const data = view.inline_keyboard
      .flat()
      .map((button) => callbackData(button))
      .find((callback) => callback.startsWith(FILES_CALLBACK_DOWNLOAD_PREFIX));

    expect(decodeFilesDownloadCallback(data ?? "")).toBe(filePath);
  });
});
