import type { Context } from "grammy";
import { isWithinAllowedRootSafe } from "../../app/services/file-browser-service.js";
import {
  clearRemoteDirectory,
  getRemoteFileDetails,
  readTextFilePreview,
  rememberRemoteDirectory,
} from "../../app/services/remote-files-service.js";
import {
  isForegroundBusy,
  type ForegroundBusyDeps,
} from "../../app/services/run-control-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { alert, failure } from "./feedback.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import {
  clearActiveInlineMenu,
  ensureActiveInlineMenu,
  type InlineMenuDeps,
} from "../menus/inline-menu.js";
import { sendDownloadedFile } from "../messages/send-downloaded-file.js";
import {
  buildFilesPreviewKeyboard,
  buildFilesPreviewText,
  buildFilesRootsKeyboard,
  clearFilesPathIndex,
  decodeFilesBackCallback,
  decodeFilesDownloadCallback,
  decodeFilesFileCallback,
  decodeFilesNavCallback,
  decodeFilesPaginationCallback,
  decodeFilesPreviewCallback,
  FILES_CALLBACK_PREFIX,
  FILES_CALLBACK_ROOTS,
  renderFilesBrowseView,
  renderFilesFileDetailsView,
} from "../menus/remote-files-menu.js";

export type FilesCallbackDeps = ForegroundBusyDeps & InlineMenuDeps;

export async function handleFilesCallback(ctx: Context, deps: FilesCallbackDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(FILES_CALLBACK_PREFIX)) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "files", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    if (data === FILES_CALLBACK_ROOTS) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t("files.select_root"), {
        reply_markup: buildFilesRootsKeyboard(),
      });
      return true;
    }

    const navPath = decodeFilesNavCallback(data);
    if (navPath !== null) {
      if (!(await isWithinAllowedRootSafe(navPath))) {
        await alert(ctx, "files.access_denied");
        return true;
      }
      await navigateTo(ctx, navPath);
      return true;
    }

    const pageInfo = decodeFilesPaginationCallback(data);
    if (pageInfo !== null) {
      if (!(await isWithinAllowedRootSafe(pageInfo.path))) {
        await alert(ctx, "files.access_denied");
        return true;
      }
      await navigateTo(ctx, pageInfo.path, pageInfo.page);
      return true;
    }

    const fileInfo = decodeFilesFileCallback(data);
    if (fileInfo !== null) {
      if (!(await isWithinAllowedRootSafe(fileInfo.path))) {
        await alert(ctx, "files.access_denied");
        return true;
      }
      await showFileDetails(ctx, fileInfo.path, fileInfo.page);
      return true;
    }

    const backInfo = decodeFilesBackCallback(data);
    if (backInfo !== null) {
      if (!(await isWithinAllowedRootSafe(backInfo.path))) {
        await alert(ctx, "files.access_denied");
        return true;
      }
      await navigateTo(ctx, backInfo.path, backInfo.page);
      return true;
    }

    const previewInfo = decodeFilesPreviewCallback(data);
    if (previewInfo !== null) {
      if (!(await isWithinAllowedRootSafe(previewInfo.path))) {
        await alert(ctx, "files.access_denied");
        return true;
      }
      await showFilePreview(ctx, previewInfo.path, previewInfo.page);
      return true;
    }

    const downloadPath = decodeFilesDownloadCallback(data);
    if (downloadPath !== null) {
      if (!(await isWithinAllowedRootSafe(downloadPath))) {
        await alert(ctx, "files.access_denied");
        return true;
      }
      await downloadFileAndClose(ctx, deps, downloadPath);
      return true;
    }

    return false;
  } catch (error) {
    logger.error("[Files] Error handling callback:", error);
    await failure(ctx, "callback.processing_error");
    return true;
  }
}

async function navigateTo(ctx: Context, dirPath: string, page: number = 0): Promise<void> {
  const view = await renderFilesBrowseView(dirPath, page);
  if ("error" in view) {
    await ctx.answerCallbackQuery({ text: view.error });
    return;
  }

  rememberRemoteDirectory(ctx.from?.id, dirPath);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
}

async function showFileDetails(ctx: Context, filePath: string, page: number): Promise<void> {
  const view = await renderFilesFileDetailsView(filePath, page);
  if ("error" in view) {
    await ctx.answerCallbackQuery({ text: view.error });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
}

async function showFilePreview(ctx: Context, filePath: string, page: number): Promise<void> {
  const preview = await readTextFilePreview(filePath);
  if ("error" in preview) {
    await ctx.answerCallbackQuery({ text: preview.error });
    return;
  }

  const details = await getRemoteFileDetails(filePath);
  if ("error" in details) {
    await ctx.answerCallbackQuery({ text: details.error });
    return;
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(buildFilesPreviewText(details.name, details.size, preview), {
    parse_mode: "HTML",
    reply_markup: buildFilesPreviewKeyboard(details.fullPath, page, details.size),
  });
}

async function downloadFileAndClose(
  ctx: Context,
  deps: FilesCallbackDeps,
  filePath: string,
): Promise<void> {
  await ctx.answerCallbackQuery({ text: t("commands.download.downloading") });
  const downloaded = await sendDownloadedFile(ctx, filePath, { announce: false });
  if (!downloaded) {
    return;
  }

  clearActiveInlineMenu("files_downloaded", deps);
  clearRemoteDirectory(ctx.from?.id);
  clearFilesPathIndex();
  await ctx.deleteMessage().catch(() => {});
}
