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
  decodeFilesDeleteCallback,
  decodeFilesDeleteConfirmCallback,
  FILES_CALLBACK_DELETE_PREFIX,
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

  describe("delete", () => {
    interface Button {
      text: string;
      callback_data?: string;
    }

    // One reusable context: every reply/edit lands on the same mocks, so a test can
    // walk command -> details -> confirm -> delete without rebuilding the harness.
    function createRecordingContext() {
      const ctx = {
        chat: { id: 1 },
        from: { id: 2 },
        match: "",
        callbackQuery: undefined as unknown,
        message: undefined as unknown,
        reply: vi.fn().mockResolvedValue({ message_id: 55 }),
        editMessageText: vi.fn().mockResolvedValue(undefined),
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      };

      const asCommand = (match = ""): Context => {
        Object.assign(ctx, { match, callbackQuery: undefined, message: { text: "/files" } });
        return ctx as unknown as Context;
      };
      const asCallback = (data: string): Context => {
        Object.assign(ctx, { callbackQuery: { data, message: { message_id: 55 } } });
        return ctx as unknown as Context;
      };

      return { ctx, asCommand, asCallback };
    }

    function buttonsOf(ctx: {
      editMessageText: ReturnType<typeof vi.fn>;
      reply: ReturnType<typeof vi.fn>;
    }): Button[] {
      const editOptions = ctx.editMessageText.mock.calls.at(-1)?.[1];
      const replyOptions = ctx.reply.mock.calls.at(-1)?.[1];
      const markup = editOptions?.reply_markup ?? replyOptions?.reply_markup;
      return (markup?.inline_keyboard ?? []).flat() as Button[];
    }

    function rowsOf(ctx: {
      editMessageText: ReturnType<typeof vi.fn>;
      reply: ReturnType<typeof vi.fn>;
    }): Button[][] {
      const editOptions = ctx.editMessageText.mock.calls.at(-1)?.[1];
      const replyOptions = ctx.reply.mock.calls.at(-1)?.[1];
      const markup = editOptions?.reply_markup ?? replyOptions?.reply_markup;
      return (markup?.inline_keyboard ?? []) as Button[][];
    }

    function dataFor(ctx: Parameters<typeof buttonsOf>[0], labelPart: string): string {
      const button = buttonsOf(ctx).find((candidate) => candidate.text.includes(labelPart));
      return button?.callback_data ?? "";
    }

    function trashFor(ctx: Parameters<typeof buttonsOf>[0], folderName: string): string {
      const row = rowsOf(ctx).find((cells) => cells[0]?.text.includes(folderName));
      const trash = row?.find((cell) => cell.text.includes("🗑"));
      return trash?.callback_data ?? "";
    }

    async function openFileDetails(
      harness: ReturnType<typeof createRecordingContext>,
      fileName: string,
    ): Promise<void> {
      await filesCommand(harness.asCommand() as never, createDeps());
      const open = dataFor(harness.ctx, fileName);
      expect(open).toContain("files:file:");
      await handleFilesCallback(harness.asCallback(open), createDeps());
    }

    it("shows a delete button on the details screen", async () => {
      const harness = createRecordingContext();
      await openFileDetails(harness, "note.txt");

      const deleteData = dataFor(harness.ctx, "Delete");
      expect(deleteData).toContain(FILES_CALLBACK_DELETE_PREFIX);
      expect(decodeFilesDeleteCallback(deleteData)?.path).toBe(path.join(rootDir, "note.txt"));
    });

    it("does not delete anything until the confirmation is accepted", async () => {
      const filePath = path.join(rootDir, "victim.txt");
      await fs.writeFile(filePath, "keep me", "utf-8");

      const harness = createRecordingContext();
      await openFileDetails(harness, "victim.txt");

      // Tapping Delete opens a confirmation; the file must still be there.
      await handleFilesCallback(harness.asCallback(dataFor(harness.ctx, "Delete")), createDeps());
      await expect(fs.access(filePath)).resolves.toBeUndefined();

      const confirmData = dataFor(harness.ctx, "Yes, delete");
      expect(decodeFilesDeleteConfirmCallback(confirmData)?.path).toBe(filePath);
      await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    it("keeps the file when the confirmation is declined", async () => {
      const filePath = path.join(rootDir, "spared.txt");
      await fs.writeFile(filePath, "still here", "utf-8");

      const harness = createRecordingContext();
      await openFileDetails(harness, "spared.txt");
      await handleFilesCallback(harness.asCallback(dataFor(harness.ctx, "Delete")), createDeps());
      await handleFilesCallback(
        harness.asCallback(dataFor(harness.ctx, "No, go back")),
        createDeps(),
      );

      await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    it("deletes the file only after the confirmation is accepted", async () => {
      const filePath = path.join(rootDir, "doomed.txt");
      await fs.writeFile(filePath, "bye", "utf-8");

      const harness = createRecordingContext();
      await openFileDetails(harness, "doomed.txt");
      await handleFilesCallback(harness.asCallback(dataFor(harness.ctx, "Delete")), createDeps());
      await handleFilesCallback(
        harness.asCallback(dataFor(harness.ctx, "Yes, delete")),
        createDeps(),
      );

      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it("offers delete for a folder but refuses a non-empty one", async () => {
      const fullDir = path.join(rootDir, "full-dir");
      await fs.mkdir(fullDir);
      await fs.writeFile(path.join(fullDir, "inner.txt"), "x", "utf-8");

      const harness = createRecordingContext();
      await filesCommand(harness.asCommand() as never, createDeps());

      const trashData = trashFor(harness.ctx, "full-dir");
      expect(trashData).toContain(FILES_CALLBACK_DELETE_PREFIX);

      await handleFilesCallback(harness.asCallback(trashData), createDeps());
      await handleFilesCallback(
        harness.asCallback(dataFor(harness.ctx, "Yes, delete")),
        createDeps(),
      );

      await expect(fs.access(path.join(fullDir, "inner.txt"))).resolves.toBeUndefined();
      expect(harness.ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("not empty") }),
      );
    });

    it("deletes an empty folder after confirmation", async () => {
      const emptyDir = path.join(rootDir, "empty-dir");
      await fs.mkdir(emptyDir);

      const harness = createRecordingContext();
      await filesCommand(harness.asCommand() as never, createDeps());
      await handleFilesCallback(
        harness.asCallback(trashFor(harness.ctx, "empty-dir")),
        createDeps(),
      );
      await handleFilesCallback(
        harness.asCallback(dataFor(harness.ctx, "Yes, delete")),
        createDeps(),
      );

      await expect(fs.access(emptyDir)).rejects.toThrow();
    });

    it("refuses a delete callback for a path outside the roots", async () => {
      const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`);
      await fs.writeFile(outside, "x", "utf-8");

      const harness = createRecordingContext();
      // Proper encoded shape: prefix + path + "|page".
      const handled = await handleFilesCallback(
        harness.asCallback(`${FILES_CALLBACK_DELETE_PREFIX}${outside}|0`),
        createDeps(),
      );

      expect(handled).toBe(true);
      await expect(fs.access(outside)).resolves.toBeUndefined();
      await fs.rm(outside, { force: true });
    });
  });
});
