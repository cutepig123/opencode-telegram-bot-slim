import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { Context } from "grammy";

const mocked = vi.hoisted(() => ({
  sendDownloadedFile: vi.fn(),
  interactionStart: vi.fn(),
  interactionClear: vi.fn(),
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/bot/messages/send-downloaded-file.js", () => ({
  sendDownloadedFile: mocked.sendDownloadedFile,
}));

import { filesCommand } from "../../../src/bot/commands/files-command.js";
import { handleFilesCallback } from "../../../src/bot/callbacks/remote-files-callback-handler.js";
import {
  initBrowserRoots,
  __resetBrowserRootsForTests,
} from "../../../src/app/services/file-browser-service.js";
import {
  __resetRemoteDirectoriesForTests,
  getRemoteFileDetails,
} from "../../../src/app/services/remote-files-service.js";
import {
  clearFilesPathIndex,
  FILES_CALLBACK_DOWNLOAD_PREFIX,
  renderFilesBrowseView,
} from "../../../src/bot/menus/remote-files-menu.js";

function createDeps() {
  return {
    attachManager: { isBusy: () => false },
    foregroundSessionState: { isBusy: () => false },
    interactionManager: {
      start: mocked.interactionStart,
      clear: mocked.interactionClear,
      // The files menu is the active inline menu, on message 55.
      getSnapshot: () => ({
        kind: "inline",
        expectedInput: "callback",
        allowedCommands: [],
        metadata: { menuKind: "files", messageId: 55 },
        createdAt: Date.now(),
        expiresAt: null,
      }),
    },
  } as never;
}

function createCommandContext(match = ""): Context {
  return {
    chat: { id: 1 },
    from: { id: 2 },
    match,
    reply: vi.fn().mockResolvedValue({ message_id: 55 }),
  } as unknown as Context;
}

function callbackContext(data: string): Context {
  return {
    chat: { id: 1 },
    from: { id: 2 },
    callbackQuery: { data, message: { message_id: 55 } },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("files command and callbacks", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), "files-cmd-test-")));
    await fs.mkdir(path.join(rootDir, "sub"));
    await fs.writeFile(path.join(rootDir, "note.txt"), "hello world", "utf-8");
    __resetBrowserRootsForTests();
    initBrowserRoots(rootDir);
    __resetRemoteDirectoriesForTests();
    clearFilesPathIndex();
    mocked.sendDownloadedFile.mockReset().mockResolvedValue(true);
    mocked.interactionStart.mockReset();
    mocked.interactionClear.mockReset();
  });

  afterEach(async () => {
    __resetBrowserRootsForTests();
    __resetRemoteDirectoriesForTests();
    clearFilesPathIndex();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("opens the single configured root without a picker", async () => {
    const ctx = createCommandContext();

    await filesCommand(ctx as never, createDeps());

    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("1 folders · 1 files"),
      expect.objectContaining({
        parse_mode: "HTML",
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([expect.objectContaining({ text: "📄 note.txt · 11B" })]),
          ]),
        }),
      }),
    );
    expect(mocked.interactionStart).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "inline",
        metadata: expect.objectContaining({ menuKind: "files", messageId: 55 }),
      }),
    );
  });

  it("rejects an explicit path outside the roots", async () => {
    const ctx = createCommandContext("/etc");

    await filesCommand(ctx as never, createDeps());

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Access denied"));
    expect(mocked.interactionStart).not.toHaveBeenCalled();
  });

  it("opens an explicit path inside the roots", async () => {
    const ctx = createCommandContext(path.join(rootDir, "sub"));
    const expected = await renderFilesBrowseView(path.join(rootDir, "sub"));
    if ("error" in expected) {
      throw new Error(expected.error);
    }

    await filesCommand(ctx as never, createDeps());

    expect(ctx.reply).toHaveBeenCalledWith(
      expected.text,
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("downloads a file and closes the menu", async () => {
    const ctx = callbackContext(
      `${FILES_CALLBACK_DOWNLOAD_PREFIX}${path.join(rootDir, "note.txt")}`,
    );

    const handled = await handleFilesCallback(ctx as never, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sendDownloadedFile).toHaveBeenCalledWith(ctx, path.join(rootDir, "note.txt"), {
      announce: false,
    });
    expect(mocked.interactionClear).toHaveBeenCalled();
    expect(ctx.deleteMessage).toHaveBeenCalled();
  });

  it("refuses a callback whose path escaped the roots", async () => {
    const ctx = callbackContext(
      `${FILES_CALLBACK_DOWNLOAD_PREFIX}${path.join(os.tmpdir(), "x.txt")}`,
    );

    const handled = await handleFilesCallback(ctx as never, createDeps());

    expect(handled).toBe(true);
    expect(mocked.sendDownloadedFile).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it("returns false for a callback of another menu", async () => {
    const handled = await handleFilesCallback(
      callbackContext("ls:nav:/tmp") as never,
      createDeps(),
    );
    expect(handled).toBe(false);
  });

  it("reports file details for a real file", async () => {
    const details = await getRemoteFileDetails(path.join(rootDir, "note.txt"));
    expect("error" in details).toBe(false);
    if ("error" in details) {
      return;
    }

    expect(details.size).toBe(11);
  });

  it("reports an error for a directory", async () => {
    const details = await getRemoteFileDetails(path.join(rootDir, "sub"));
    expect("error" in details).toBe(true);
  });
});
