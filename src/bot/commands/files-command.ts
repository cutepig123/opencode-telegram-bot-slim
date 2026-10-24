import type { CommandContext, Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import path from "node:path";
import os from "node:os";
import {
  getBrowserRoots,
  isWithinAllowedRootSafe,
} from "../../app/services/file-browser-service.js";
import {
  clearRemoteDirectory,
  rememberRemoteDirectory,
  resolveRemoteDirectory,
} from "../../app/services/remote-files-service.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { t } from "../../i18n/index.js";
import { isContainerRuntime } from "../../runtime/container.js";
import { logger } from "../../utils/logger.js";
import {
  buildFilesRootsKeyboard,
  clearFilesPathIndex,
  renderFilesBrowseView,
} from "../menus/remote-files-menu.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";

export type FilesCommandDeps = Pick<
  AppContainer,
  "attachManager" | "foregroundSessionState" | "interactionManager"
>;

function expandTilde(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export async function filesCommand(
  ctx: CommandContext<Context>,
  deps: FilesCommandDeps,
): Promise<void> {
  try {
    if (isForegroundBusy(deps)) {
      await replyBusyBlocked(ctx);
      return;
    }

    if (isContainerRuntime()) {
      await ctx.reply(t("runtime.container.command_unavailable"));
      return;
    }

    clearFilesPathIndex();

    const args = typeof ctx.match === "string" ? ctx.match.trim() : "";
    if (args.length > 0) {
      const target = path.resolve(expandTilde(args));
      if (!(await isWithinAllowedRootSafe(target))) {
        await ctx.reply(`❌ ${t("files.access_denied")}`);
        return;
      }

      await openRemoteBrowser(ctx, deps, target);
      return;
    }

    const remembered = resolveRemoteDirectory(ctx.from?.id);
    if (remembered) {
      const opened = await openRemoteBrowser(ctx, deps, remembered);
      if (opened) {
        return;
      }
      clearRemoteDirectory(ctx.from?.id);
    }

    const roots = getBrowserRoots();
    const singleRoot = roots[0];
    if (roots.length === 1 && singleRoot) {
      await openRemoteBrowser(ctx, deps, singleRoot);
      return;
    }

    const message = await ctx.reply(t("files.select_root"), {
      reply_markup: buildFilesRootsKeyboard(),
    });

    deps.interactionManager.start({
      kind: "inline",
      expectedInput: "callback",
      metadata: {
        menuKind: "files",
        messageId: message.message_id,
      },
    });
  } catch (error) {
    logger.error("[Files] Error opening remote file browser:", error);
    await ctx.reply(t("files.open_error"));
  }
}

async function openRemoteBrowser(
  ctx: CommandContext<Context>,
  deps: FilesCommandDeps,
  dirPath: string,
): Promise<boolean> {
  const view = await renderFilesBrowseView(dirPath);
  if ("error" in view) {
    await ctx.reply(t("files.scan_error", { error: view.error }));
    return false;
  }

  rememberRemoteDirectory(ctx.from?.id, dirPath);

  const message = await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });

  deps.interactionManager.start({
    kind: "inline",
    expectedInput: "callback",
    metadata: {
      menuKind: "files",
      messageId: message.message_id,
    },
  });

  return true;
}
