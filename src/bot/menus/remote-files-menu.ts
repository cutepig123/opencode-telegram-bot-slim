import { InlineKeyboard } from "grammy";
import { formatFileSize, isTextFileName } from "../../app/services/file-download-service.js";
import {
  getBaseName,
  getBrowserRoots,
  getParentPath,
  isAllowedRoot,
  pathToDisplayPath,
} from "../../app/services/file-browser-service.js";
import {
  getRemoteFileDetails,
  scanRemoteDirectory,
  type RemoteDeleteTarget,
  type RemoteFileEntry,
  type TextFilePreview,
} from "../../app/services/remote-files-service.js";
import { t } from "../../i18n/index.js";
import { appendInlineMenuCancelButton } from "./inline-menu.js";

export const FILES_CALLBACK_PREFIX = "files:";
export const FILES_CALLBACK_ROOTS = "files:roots";
export const FILES_CALLBACK_NAV_PREFIX = "files:nav:";
export const FILES_CALLBACK_PAGE_PREFIX = "files:pg:";
export const FILES_CALLBACK_FILE_PREFIX = "files:file:";
export const FILES_CALLBACK_BACK_PREFIX = "files:back:";
export const FILES_CALLBACK_DOWNLOAD_PREFIX = "files:download:";
export const FILES_CALLBACK_PREVIEW_PREFIX = "files:preview:";
export const FILES_CALLBACK_DELETE_PREFIX = "files:delete:";
export const FILES_CALLBACK_DELETE_CONFIRM_PREFIX = "files:delok:";
export const FILES_CALLBACK_DELETE_CANCEL_PREFIX = "files:delno:";

// Telegram rejects bot uploads above this size; sendDownloadedFile enforces the same cap.
export const MAX_DOWNLOAD_SIZE_KB = 50 * 1024;

const PAGE_SEPARATOR = "|";
const MAX_BUTTON_LABEL_LENGTH = 64;
const PREVIEW_TEXT_LIMIT = 3800;

const filesPathIndex = new Map<string, string>();
let filesPathCounter = 0;

export function clearFilesPathIndex(): void {
  filesPathIndex.clear();
  filesPathCounter = 0;
}

function truncateLabel(label: string, maxLen: number = MAX_BUTTON_LABEL_LENGTH): string {
  if (label.length <= maxLen) {
    return label;
  }

  return `${label.slice(0, Math.max(0, maxLen - 3))}...`;
}

// Deep CJK paths blow past Telegram's 64-byte callback limit, so anything that does not
// fit is stored behind a short index key.
function encodePath(prefix: string, fullPath: string, reserveBytes: number = 0): string {
  const naive = `${prefix}${fullPath}`;
  if (Buffer.byteLength(naive, "utf-8") + reserveBytes <= 64) {
    return naive;
  }

  const key = `#${filesPathCounter++}`;
  filesPathIndex.set(key, fullPath);
  return `${prefix}${key}`;
}

function decodePath(prefix: string, data: string): string | null {
  if (!data.startsWith(prefix)) {
    return null;
  }

  const raw = data.slice(prefix.length);
  if (raw.startsWith("#")) {
    return filesPathIndex.get(raw) ?? null;
  }

  return raw;
}

function encodePathWithPage(prefix: string, fullPath: string, page: number): string {
  const pageSuffix = `${PAGE_SEPARATOR}${page}`;
  const reserveBytes = Buffer.byteLength(pageSuffix, "utf-8");
  return `${encodePath(prefix, fullPath, reserveBytes)}${pageSuffix}`;
}

function decodePathWithPage(data: string, prefix: string): { path: string; page: number } | null {
  if (!data.startsWith(prefix)) {
    return null;
  }

  const payload = data.slice(prefix.length);
  const separatorIndex = payload.lastIndexOf(PAGE_SEPARATOR);
  if (separatorIndex < 0) {
    return null;
  }

  const pathRef = payload.slice(0, separatorIndex);
  const page = Number.parseInt(payload.slice(separatorIndex + 1), 10);
  if (Number.isNaN(page)) {
    return null;
  }

  const resolvedPath = pathRef.startsWith("#") ? (filesPathIndex.get(pathRef) ?? null) : pathRef;
  if (resolvedPath === null) {
    return null;
  }

  return { path: resolvedPath, page };
}

export function decodeFilesNavCallback(data: string): string | null {
  return decodePath(FILES_CALLBACK_NAV_PREFIX, data);
}

export function decodeFilesPaginationCallback(data: string): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_PAGE_PREFIX);
}

export function decodeFilesFileCallback(data: string): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_FILE_PREFIX);
}

export function decodeFilesBackCallback(data: string): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_BACK_PREFIX);
}

export function decodeFilesDownloadCallback(data: string): string | null {
  return decodePath(FILES_CALLBACK_DOWNLOAD_PREFIX, data);
}

export function decodeFilesPreviewCallback(data: string): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_PREVIEW_PREFIX);
}

export function decodeFilesDeleteCallback(data: string): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_DELETE_PREFIX);
}

export function decodeFilesDeleteConfirmCallback(
  data: string,
): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_DELETE_CONFIRM_PREFIX);
}

export function decodeFilesDeleteCancelCallback(
  data: string,
): { path: string; page: number } | null {
  return decodePathWithPage(data, FILES_CALLBACK_DELETE_CANCEL_PREFIX);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEntryLabel(entry: RemoteFileEntry): string {
  if (entry.type === "directory") {
    return `📁 ${entry.name}`;
  }

  return `📄 ${entry.name} · ${formatFileSize(entry.size)}`;
}

function buildFilesHeader(
  displayPath: string,
  directoryCount: number,
  fileCount: number,
  page: number,
  totalPages: number,
): string {
  let header = `📂 ${t("files.header")}\n<code>${escapeHtml(displayPath)}</code>`;
  if (totalPages > 1) {
    header += `\n(${page + 1}/${totalPages})`;
  }
  header += `\n${t("files.counts", {
    directories: String(directoryCount),
    files: String(fileCount),
  })}`;
  return header;
}

function buildBrowseKeyboard(
  entries: RemoteFileEntry[],
  currentPath: string,
  parentPath: string | null,
  page: number,
  totalPages: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const entry of entries) {
    const label = truncateLabel(buildEntryLabel(entry));
    if (entry.type === "directory") {
      // Folders get their own delete button in the same row: tapping a file already
      // opens a details screen that carries one, folders have no such screen.
      keyboard
        .text(label, encodePath(FILES_CALLBACK_NAV_PREFIX, entry.fullPath))
        .text("🗑", encodePathWithPage(FILES_CALLBACK_DELETE_PREFIX, entry.fullPath, page))
        .row();
      continue;
    }

    keyboard
      .text(label, encodePathWithPage(FILES_CALLBACK_FILE_PREFIX, entry.fullPath, page))
      .row();
  }

  if (parentPath !== null) {
    keyboard.text(t("open.back"), encodePath(FILES_CALLBACK_NAV_PREFIX, parentPath)).row();
  }

  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text(
        t("open.prev_page"),
        encodePathWithPage(FILES_CALLBACK_PAGE_PREFIX, currentPath, page - 1),
      );
    }
    if (page < totalPages - 1) {
      keyboard.text(
        t("open.next_page"),
        encodePathWithPage(FILES_CALLBACK_PAGE_PREFIX, currentPath, page + 1),
      );
    }
    keyboard.row();
  }

  if (getBrowserRoots().length > 1 && !isAllowedRoot(currentPath)) {
    keyboard.text(t("files.roots"), FILES_CALLBACK_ROOTS).row();
  }

  appendInlineMenuCancelButton(keyboard, "files");
  return keyboard;
}

export async function renderFilesBrowseView(dirPath: string, page: number = 0) {
  const result = await scanRemoteDirectory(dirPath, page);
  if ("error" in result) {
    return result;
  }

  return {
    text: buildFilesHeader(
      result.displayPath,
      result.directoryCount,
      result.fileCount,
      result.page,
      result.totalPages,
    ),
    keyboard: buildBrowseKeyboard(
      result.entries,
      result.currentPath,
      result.parentPath,
      result.page,
      result.totalPages,
    ),
  };
}

export function buildFilesRootsKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const root of getBrowserRoots()) {
    const label = truncateLabel(`📂 ${pathToDisplayPath(root)}`);
    keyboard.text(label, encodePath(FILES_CALLBACK_NAV_PREFIX, root)).row();
  }

  appendInlineMenuCancelButton(keyboard, "files");
  return keyboard;
}

function buildFileDetailsKeyboard(
  filePath: string,
  page: number,
  canPreview: boolean,
  size: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (canPreview) {
    keyboard
      .text(t("files.preview"), encodePathWithPage(FILES_CALLBACK_PREVIEW_PREFIX, filePath, page))
      .row();
  }
  if (size <= MAX_DOWNLOAD_SIZE_KB * 1024) {
    keyboard.text(t("files.download"), encodePath(FILES_CALLBACK_DOWNLOAD_PREFIX, filePath)).row();
  }
  keyboard
    .text(t("files.delete"), encodePathWithPage(FILES_CALLBACK_DELETE_PREFIX, filePath, page))
    .row();
  keyboard
    .text(
      t("ls.file.back"),
      encodePathWithPage(FILES_CALLBACK_BACK_PREFIX, getParentPath(filePath), page),
    )
    .row();

  appendInlineMenuCancelButton(keyboard, "files");
  return keyboard;
}

export async function renderFilesFileDetailsView(filePath: string, page: number) {
  const details = await getRemoteFileDetails(filePath);
  if ("error" in details) {
    return details;
  }

  let text =
    `📄 ${t("ls.file.header")}\n<code>${escapeHtml(getBaseName(details.fullPath))}</code>\n` +
    `${t("commands.download.size")}: ${formatFileSize(details.size)}\n` +
    `${t("commands.download.modified")}: ${details.modified.toLocaleDateString()}\n` +
    `${t("files.path")}: <code>${escapeHtml(details.displayPath)}</code>`;

  if (details.size > MAX_DOWNLOAD_SIZE_KB * 1024) {
    text += `\n\n${t("files.too_large", { maxSizeMb: String(MAX_DOWNLOAD_SIZE_KB / 1024) })}`;
  }

  return {
    text,
    keyboard: buildFileDetailsKeyboard(
      details.fullPath,
      page,
      isTextFileName(details.name),
      details.size,
    ),
  };
}

export function buildFilesPreviewText(
  fileName: string,
  size: number,
  preview: TextFilePreview,
): string {
  const body = preview.text.length > 0 ? preview.text : t("files.preview_empty");
  const clipped =
    body.length > PREVIEW_TEXT_LIMIT ? `${body.slice(0, PREVIEW_TEXT_LIMIT)}\n...` : body;

  let text = `📄 <code>${escapeHtml(fileName)}</code> · ${formatFileSize(size)}\n`;
  text += `<pre>${escapeHtml(clipped)}</pre>`;

  if (preview.truncated || clipped !== body) {
    text += `\n${t("files.preview_truncated", { lines: String(clipped.split("\n").length) })}`;
  }

  return text;
}

export function buildFilesPreviewKeyboard(
  filePath: string,
  page: number,
  size: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (size <= MAX_DOWNLOAD_SIZE_KB * 1024) {
    keyboard.text(t("files.download"), encodePath(FILES_CALLBACK_DOWNLOAD_PREFIX, filePath)).row();
  }
  keyboard
    .text(
      t("ls.file.back"),
      encodePathWithPage(FILES_CALLBACK_BACK_PREFIX, getParentPath(filePath), page),
    )
    .row();

  appendInlineMenuCancelButton(keyboard, "files");
  return keyboard;
}

export function buildFilesDeleteConfirmKeyboard(entryPath: string, page: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text(
      t("files.delete_confirm_yes"),
      encodePathWithPage(FILES_CALLBACK_DELETE_CONFIRM_PREFIX, entryPath, page),
    )
    .row();
  keyboard
    .text(
      t("files.delete_confirm_no"),
      encodePathWithPage(FILES_CALLBACK_DELETE_CANCEL_PREFIX, entryPath, page),
    )
    .row();

  return keyboard;
}

export function buildFilesDeleteConfirmText(entryPath: string, target: RemoteDeleteTarget): string {
  const name = getBaseName(entryPath);
  const kind =
    target === "directory" ? t("files.delete_kind_directory") : t("files.delete_kind_file");

  return (
    `⚠️ ${t("files.delete_title")}

` +
    `${t("files.delete_kind")}: ${kind}
` +
    `<code>${escapeHtml(name)}</code>
` +
    `${t("files.path")}: <code>${escapeHtml(pathToDisplayPath(entryPath))}</code>

` +
    t("files.delete_warning")
  );
}
