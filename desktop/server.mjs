import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.VIDEO_MANAGER_PORT || 47128);
const SERVER_VERSION = "2026.08.28.04";
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const dataDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "视频素材管理器",
);
const cacheDir = path.join(dataDir, "thumbnails");
fs.mkdirSync(cacheDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, "video-manager.db"));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const DEFAULT_PLATFORMS = [
  "抖音1号", "抖音2号", "视频号", "搜狐号",
  "小红书", "百家号", "哔哩哔哩", "微博号",
];
const VIDEO_EXT = new Set([
  ".mp4",
  ".mov",
  ".m0v",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const SLOT_ORDER = [
  "original_video",
  "original_video_part2",
  "original_video_part3",
  "edited_video",
  "original_cover_landscape",
  "original_cover_portrait",
  "remix_video",
  "remix_cover_landscape",
  "remix_cover_portrait",
  "third_video",
  "third_cover_landscape",
  "third_cover_portrait",
];

const PUBLISH_VERSIONS = {
  original: {
    label: "原版",
    folder: "原版",
    slots: ["edited_video", "original_cover_landscape", "original_cover_portrait"],
  },
  remix: {
    label: "二创",
    folder: "二创",
    slots: ["remix_video", "remix_cover_landscape", "remix_cover_portrait"],
  },
  third: {
    label: "三创",
    folder: "三创",
    slots: ["third_video", "third_cover_landscape", "third_cover_portrait"],
  },
};
const PUBLISH_VERSION_IDS = Object.keys(PUBLISH_VERSIONS);

function publishVersionSlotsForGroup(group, version) {
  if (group?.category === "ageless" && version === "original") {
    return ["edited_video", "original_cover_portrait"];
  }
  return PUBLISH_VERSIONS[version]?.slots || PUBLISH_VERSIONS.original.slots;
}

function taskSlotLabel(slot, index) {
  if (index === 0) return "成片";
  if (slot.includes("landscape")) return "横版封面";
  if (slot.includes("portrait")) return "竖版封面";
  return "封面";
}

function emptyState() {
  return {
    groups: [],
    publishTasks: [],
    publishHistory: [],
    platforms: DEFAULT_PLATFORMS.map((name, index) => ({
      id: `platform-${index + 1}`,
      name,
      sortOrder: index,
      active: true,
    })),
    sources: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeWorkflowCategories(state) {
  for (const group of state.groups ?? []) {
    const linkedAssets = Object.values(group.assets ?? {}).filter(Boolean);
    const onlySingleOriginal =
      linkedAssets.length === 1 && Boolean(group.assets?.original_video);
    if (group.category === "pending_edit") {
      group.category =
        group.contentCategory === "ageless" ||
        (!group.contentCategory && String(group.code || "").startsWith("LS"))
          ? "ageless"
          : "facelift";
    }
    if (["facelift", "ageless"].includes(group.category)) {
      group.contentCategory = group.category;
    }
    group.workflowStatus = onlySingleOriginal ? "pending_edit" : "";
  }
  return state;
}

function annotateSourceAvailability(state) {
  const sourceAvailability = (state.sources ?? []).map((source) => ({
    id: source.id,
    path: source.path,
    category: source.category,
    available: Boolean(source.path && fs.existsSync(source.path)),
  }));
  state.sourceAvailability = sourceAvailability;
  state.offlineSourcePaths = sourceAvailability
    .filter((source) => !source.available)
    .map((source) => source.path);
  state.hasOfflineSources = state.offlineSourcePaths.length > 0;
  return state;
}

function readState() {
  const row = db.prepare("SELECT payload FROM app_state WHERE id = 1").get();
  const state = normalizeWorkflowCategories(
    row ? JSON.parse(String(row.payload)) : emptyState(),
  );
  state.publishTasks ??= [];
  state.publishHistory ??= [];
  for (const group of state.groups ?? []) {
    for (const asset of Object.values(group.assets ?? {})) {
      if (asset) asset.available = fs.existsSync(asset.path);
    }
  }
  recoverPublishTasksFromFolders(state);
  return annotateSourceAvailability(state);
}

function writeState(state) {
  const {
    sourceAvailability: _sourceAvailability,
    offlineSourcePaths: _offlineSourcePaths,
    hasOfflineSources: _hasOfflineSources,
    ...persistedState
  } = state;
  const next = normalizeWorkflowCategories({
    ...persistedState,
    updatedAt: new Date().toISOString(),
  });
  db.prepare(`
    INSERT INTO app_state(id,payload,updated_at) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
  `).run(JSON.stringify(next), next.updatedAt);
  persistPublishTaskMarkers(next);
  return annotateSourceAvailability(next);
}

function respond(response, status, data, type = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

function openExplorerForeground(targetPath) {
  const target = path.resolve(targetPath);
  const encodedTarget = Buffer.from(target, "utf16le").toString("base64");
  const script = [
    `$target=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedTarget}'))`,
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ExplorerForeground { [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags); }'",
    "Start-Process -FilePath explorer.exe -ArgumentList @($target)",
    "$shell=New-Object -ComObject Shell.Application",
    "for($attempt=0;$attempt -lt 30;$attempt++){ Start-Sleep -Milliseconds 100; foreach($window in @($shell.Windows())){ try { $windowPath=[IO.Path]::GetFullPath([string]$window.Document.Folder.Self.Path); if([string]::Equals($windowPath,[IO.Path]::GetFullPath($target),[StringComparison]::OrdinalIgnoreCase)){ $handle=[IntPtr]::new([long]$window.HWND); [ExplorerForeground]::ShowWindowAsync($handle,9)|Out-Null; [ExplorerForeground]::SetWindowPos($handle,[IntPtr]::new(-1),0,0,0,0,0x0043)|Out-Null; [ExplorerForeground]::SetWindowPos($handle,[IntPtr]::new(-2),0,0,0,0,0x0043)|Out-Null; [ExplorerForeground]::BringWindowToTop($handle)|Out-Null; [ExplorerForeground]::SetForegroundWindow($handle)|Out-Null; exit } } catch {} } }",
  ].join("; ");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true },
    () => {},
  );
}

async function bodyJson(request) {
  const parts = [];
  for await (const part of request) parts.push(part);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
}

function imageDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (
      buffer.length > 24 &&
      buffer.toString("ascii", 1, 4) === "PNG"
    ) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
    }
  } catch {}
  return {};
}

function cleanStem(name) {
  const stem = path.basename(name, path.extname(name)).toLowerCase();
  const beautyId = stem.match(/^(beauty_\d+)/i);
  if (beautyId) return beautyId[1];
  return stem
    .replace(
      /(三创字幕|三创文案|三创成片|三创横封面|三创竖封面|三创|第三创|再次创作|third|二创字幕|二创文案|二创成片|二创横封面|二创竖封面|二创|再创作|混剪|改版|原视频|原片|原版|字幕|文案|剪好|剪辑|成片|横封面|竖封面|封面|横版|横屏|竖版|竖屏|cover|original|remix|final|副本|拷贝)/gi,
      "",
    )
    .replace(/[\s_\-—（）()\[\]【】.]+/g, "")
    .replace(/\d{8,14}$/g, "")
    .slice(0, 42);
}

function folderStem(filePath) {
  const folderName = path.basename(path.dirname(filePath)).toLowerCase();
  return /^beauty_\d{13}$/i.test(folderName) ? folderName : "";
}

function classify(file) {
  const ext = path.extname(file.path).toLowerCase();
  const name = file.filename.toLowerCase();
  const third = /(三创|第三创|再次创作|third)/i.test(name);
  const remix = /(二创|再创作|混剪|改版|remix)/i.test(name);
  const cover = /(封面|cover)/i.test(name);
  const landscapeHint = /(横封面|横版|横屏|landscape|16[：:]?9)/i.test(name);
  const portraitHint = /(竖封面|竖版|竖屏|portrait|9[：:]?16)/i.test(name);
  if (cover) {
    const dimensions = IMAGE_EXT.has(ext) ? imageDimensions(file.path) : {};
    const landscape = landscapeHint
      ? true
      : portraitHint
        ? false
        : dimensions.width && dimensions.height
          ? dimensions.width >= dimensions.height
          : true;
    return {
      slot: third
        ? landscape
          ? "third_cover_landscape"
          : "third_cover_portrait"
        : remix
        ? landscape
          ? "remix_cover_landscape"
          : "remix_cover_portrait"
        : landscape
          ? "original_cover_landscape"
          : "original_cover_portrait",
      ...dimensions,
    };
  }
  if (VIDEO_EXT.has(ext)) {
    if (third) return "third_video";
    if (remix) return "remix_video";
    if (/(后半段\s*[2二]|第二个后半段|第三段|part\s*3)/i.test(name))
      return "original_video_part3";
    if (/(后半段|第二段|第2段|part\s*2)/i.test(name))
      return "original_video_part2";
    if (/(字幕|文案|剪好|剪辑|成片|发布版|final)/i.test(name))
      return "edited_video";
    return "original_video";
  }
  const dimensions = imageDimensions(file.path);
  const landscape = landscapeHint
    ? true
    : portraitHint
      ? false
      : dimensions.width && dimensions.height
        ? dimensions.width >= dimensions.height
        : true;
  return {
    slot: third
      ? landscape ? "third_cover_landscape" : "third_cover_portrait"
      : remix
      ? landscape ? "remix_cover_landscape" : "remix_cover_portrait"
      : landscape ? "original_cover_landscape" : "original_cover_portrait",
    ...dimensions,
  };
}

function categoryFromPath(filePath) {
  const normalized = filePath.toLowerCase();
  if (normalized.includes("老而不衰")) return "ageless";
  if (normalized.includes("拉皮")) return "facelift";
  return "facelift";
}

function categoryFromSources(filePath, sourceCategories = []) {
  const normalizedFile = path.resolve(filePath).toLowerCase();
  const matchingSource = sourceCategories
    .filter((source) => {
      const root = path.resolve(source.path).toLowerCase();
      return normalizedFile === root || normalizedFile.startsWith(`${root}${path.sep}`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
  return matchingSource?.category === "ageless"
    ? "ageless"
    : matchingSource?.category === "facelift"
      ? "facelift"
      : categoryFromPath(filePath);
}

function walk(directory, result, limit = 20000) {
  if (result.length >= limit) return;
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (result.length >= limit) break;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".git", "$recycle.bin", "system volume information"].includes(entry.name.toLowerCase()))
        walk(fullPath, result, limit);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) continue;
    try {
      const stat = fs.statSync(fullPath);
      result.push({
        id: crypto.createHash("sha1").update(`${fullPath}|${stat.size}|${stat.mtimeMs}`).digest("hex"),
        path: fullPath,
        filename: entry.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        ext,
      });
    } catch {}
  }
}

function scanDirectories(paths, options = {}) {
  const files = [];
  for (const directory of paths) walk(directory, files);
  const importedAssetIds = options.importedAssetIds ?? new Set();
  const rawGroups = new Map();
  for (const file of files) {
    const anchoredStem = folderStem(file.path);
    const key =
      anchoredStem ||
      cleanStem(file.filename) ||
      path.basename(path.dirname(file.path)).toLowerCase();
    const bucketKey = `${path.dirname(file.path).toLowerCase()}|${key}`;
    const bucket = rawGroups.get(bucketKey) ?? {
      id: crypto.createHash("sha1").update(bucketKey).digest("hex"),
      suggestedTitle:
        anchoredStem ||
        cleanStem(file.filename) ||
        path.basename(path.dirname(file.path)),
      directory: path.dirname(file.path),
      category: categoryFromSources(file.path, options.sourceCategories),
      folderAnchored: Boolean(anchoredStem),
      files: [],
    };
    bucket.files.push(file);
    rawGroups.set(bucketKey, bucket);
  }

  const groups = new Map();
  for (const [bucketKey, rawBucket] of rawGroups.entries()) {
    if (
      rawBucket.files.length &&
      rawBucket.files.every((file) => importedAssetIds.has(file.id))
    ) {
      continue;
    }
    const bucket = {
      ...rawBucket,
      slots: {},
      files: [],
      confidence: 60,
    };
    for (const file of rawBucket.files) {
      const detected = classify(file);
      let slot = typeof detected === "string" ? detected : detected.slot;
      if (slot === "original_video" && bucket.slots.original_video) {
        slot = !bucket.slots.original_video_part2
          ? "original_video_part2"
          : !bucket.slots.original_video_part3
            ? "original_video_part3"
            : slot;
      }
      if (
        slot === "original_video_part2" &&
        bucket.slots.original_video_part2 &&
        !bucket.slots.original_video_part3
      ) {
        slot = "original_video_part3";
      }
      const enriched = {
        ...file,
        slot,
        width: typeof detected === "string" ? undefined : detected.width,
        height: typeof detected === "string" ? undefined : detected.height,
        available: true,
      };
      bucket.files.push(enriched);
      if (!bucket.slots[slot]) bucket.slots[slot] = enriched;
      else bucket.confidence = Math.max(35, bucket.confidence - 15);
    }
    groups.set(bucketKey, bucket);
  }

  // A phone may assign a new beauty ID to the second recording segment.
  // If that "后半段" is otherwise orphaned, attach it to the closest earlier
  // original recording in the same folder.
  for (const [orphanKey, orphan] of [...groups.entries()]) {
    const secondPart = orphan.slots.original_video_part2;
    if (!secondPart || orphan.files.length !== 1) continue;
    const secondTime = new Date(secondPart.modifiedAt).getTime();
    const matches = [...groups.entries()]
      .filter(
        ([key, group]) =>
          key !== orphanKey &&
          group.directory === orphan.directory &&
          group.slots.original_video &&
          !group.slots.original_video_part2,
      )
      .map(([key, group]) => {
        const firstTime = new Date(group.slots.original_video.modifiedAt).getTime();
        return { key, group, gap: secondTime - firstTime };
      })
      .filter((match) => match.gap >= 0 && match.gap <= 10 * 60 * 1000)
      .sort((a, b) => a.gap - b.gap);
    if (!matches.length) continue;
    const target = matches[0].group;
    target.slots.original_video_part2 = secondPart;
    target.files.push(secondPart);
    target.confidence = Math.min(96, target.confidence + 6);
    groups.delete(orphanKey);
  }

  return {
    fileCount: files.length,
    candidates: [...groups.values()]
      .map((group) => ({
        ...group,
        confidence: Math.min(
          96,
          group.confidence +
            Object.keys(group.slots).length * 6 +
            (group.folderAnchored ? 30 : 0),
        ),
      }))
      .sort((a, b) => b.files.length - a.files.length || b.confidence - a.confidence),
  };
}

function confirmCandidate(candidate) {
  const state = readState();
  const existingGroup = candidate.groupId
    ? state.groups.find((item) => item.id === candidate.groupId)
    : null;
  const category = candidate.category === "ageless" ? "ageless" : "facelift";
  const prefix = category === "facelift" ? "LP" : "LS";
  const max = state.groups
    .filter((group) => group.category === category)
    .map((group) => Number(String(group.code).replace(/\D/g, "")) || 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const now = new Date().toISOString();
  const assets = {};
  for (const slot of SLOT_ORDER) {
    const file = candidate.slots?.[slot];
    if (!file) continue;
    assets[slot] = {
      id: file.id || crypto.randomUUID(),
      slot,
      path: file.path,
      filename: file.filename || path.basename(file.path),
      size: file.size || 0,
      modifiedAt: file.modifiedAt || now,
      width: file.width,
      height: file.height,
      available: fs.existsSync(file.path),
      thumbnail: IMAGE_EXT.has(path.extname(file.path).toLowerCase())
        ? `http://127.0.0.1:${PORT}/media?path=${encodeURIComponent(file.path)}`
        : undefined,
    };
  }
  const candidatePaths = new Set(
    Object.values(assets).map((asset) => path.resolve(asset.path).toLowerCase()),
  );
  const candidateFileStems = new Set(
    (candidate.files ?? []).map((file) => cleanStem(file.filename)),
  );
  const activeTaskGroupIds = new Set(
    (state.publishTasks ?? []).flatMap((task) =>
      (task.items ?? []).map((item) => item.groupId),
    ),
  );
  const normalizedTargetTitle = String(
    candidate.title || candidate.suggestedTitle || "",
  ).trim().toLowerCase();
  const absorbedGroups = state.groups.filter((item) => {
    if (item.id === existingGroup?.id || activeTaskGroupIds.has(item.id)) return false;
    const itemAssets = Object.values(item.assets ?? {}).filter(
      (asset) => asset?.path,
    );
    if (!itemAssets.length) return false;
    const sameTitle =
      String(item.title ?? "").trim().toLowerCase() === normalizedTargetTitle;
    if (!sameTitle && itemAssets.length > 1) return false;
    const pathsAbsorbed = itemAssets.every((asset) =>
      candidatePaths.has(path.resolve(asset.path).toLowerCase()),
    );
    const obsoleteSingleFileSegment =
      itemAssets.length === 1 &&
      itemAssets.every((asset) => !fs.existsSync(asset.path)) &&
      candidateFileStems.has(String(item.title ?? "").trim().toLowerCase());
    return pathsAbsorbed || obsoleteSingleFileSegment;
  });
  const absorbedIds = new Set(absorbedGroups.map((item) => item.id));
  const mergedPublishMarks = Object.assign(
    {},
    ...absorbedGroups.map((item) => item.publishMarks ?? {}),
    existingGroup?.publishMarks ?? {},
    candidate.publishMarks ?? {},
  );
  const mergedPublishMarkTimes = Object.assign(
    {},
    ...absorbedGroups.map((item) => item.publishMarkTimes ?? {}),
    existingGroup?.publishMarkTimes ?? {},
    candidate.publishMarkTimes ?? {},
  );
  const group = {
    ...(existingGroup ?? {}),
    id: candidate.groupId || crypto.randomUUID(),
    category,
    contentCategory: category,
    code: candidate.code || `${prefix}-${String(max + 1).padStart(4, "0")}`,
    title: candidate.title || candidate.suggestedTitle || "未命名视频",
    notes: candidate.notes || "",
    assets,
    publishMarks: mergedPublishMarks,
    publishMarkTimes: mergedPublishMarkTimes,
    douyinOriginalPlatformId:
      existingGroup?.douyinOriginalPlatformId ||
      absorbedGroups.find((item) => item.douyinOriginalPlatformId)
        ?.douyinOriginalPlatformId ||
      "",
    douyinAssignmentLockedAt:
      existingGroup?.douyinAssignmentLockedAt ||
      absorbedGroups.find((item) => item.douyinAssignmentLockedAt)
        ?.douyinAssignmentLockedAt ||
      "",
    createdAt: existingGroup?.createdAt || now,
    updatedAt: now,
  };
  const existingFingerprints = new Set(
    state.groups.filter(
      (item) => item.id !== existingGroup?.id && !absorbedIds.has(item.id),
    ).flatMap((item) =>
      Object.values(item.assets ?? {}).map((asset) => asset?.id).filter(Boolean),
    ),
  );
  const duplicate = Object.values(assets).some((asset) => existingFingerprints.has(asset.id));
  if (duplicate) throw new Error("部分文件已经导入，请先检查已有记录。");
  const remainingGroups = state.groups.filter((item) => !absorbedIds.has(item.id));
  const groups = existingGroup
    ? remainingGroups.map((item) => (item.id === existingGroup.id ? group : item))
    : [group, ...remainingGroups];
  const publishHistory = (state.publishHistory ?? []).map((entry) =>
    absorbedIds.has(entry.groupId)
      ? { ...entry, groupId: group.id }
      : entry,
  );
  return writeState({ ...state, groups, publishHistory });
}

const activeCopyJobs = new Set();
const cancelledCopyJobs = new Set();
const TASK_MARKER = ".video-manager-task.json";

function desktopDirectory() {
  if (process.env.VIDEO_MANAGER_PUBLISH_ROOT) {
    return path.resolve(process.env.VIDEO_MANAGER_PUBLISH_ROOT);
  }
  const candidates = [
    process.env.OneDrive && path.join(process.env.OneDrive, "Desktop"),
    process.env.OneDrive && path.join(process.env.OneDrive, "桌面"),
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "桌面"),
  ].filter(Boolean);
  return path.resolve(candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]);
}

function publishRoot() {
  return path.join(desktopDirectory(), "待发布视频");
}

function safeName(value, fallback = "视频") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function taskFolderName(id) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `发布任务_${stamp}_${id.slice(0, 8)}`;
}

function taskMarkerPath(folderPath) {
  return path.join(folderPath, TASK_MARKER);
}

function validateTaskFolder(task, { allowMissing = false } = {}) {
  const rootPath = path.resolve(publishRoot());
  const folderPath = path.resolve(String(task?.folderPath || ""));
  if (!folderPath || folderPath === rootPath || path.dirname(folderPath) !== rootPath) {
    throw new Error("任务目录安全校验失败：只能操作‘待发布视频’下的独立任务目录");
  }
  if (!fs.existsSync(folderPath)) {
    if (allowMissing) return { folderPath, missing: true };
    throw new Error("任务临时目录不存在");
  }
  const markerPath = taskMarkerPath(folderPath);
  if (!fs.existsSync(markerPath)) throw new Error("任务目录缺少安全标识，已拒绝删除");
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error("任务目录安全标识无效，已拒绝删除");
  }
  if (marker.taskId !== task.id) throw new Error("任务目录编号不匹配，已拒绝删除");
  return { folderPath, missing: false };
}

function removeTaskFolder(task) {
  const checked = validateTaskFolder(task, { allowMissing: true });
  if (!checked.missing) fs.rmSync(checked.folderPath, { recursive: true, force: false });
}

function isSafeTaskFolderPath(folderPath) {
  const rootPath = path.resolve(publishRoot());
  const resolved = path.resolve(String(folderPath || ""));
  return Boolean(resolved) && resolved !== rootPath && path.dirname(resolved) === rootPath;
}

function taskMarkerPayload(task) {
  return {
    taskId: task.id,
    createdAt: task.createdAt,
    task: {
      ...task,
      status: task.status === "copying" ? "copy_failed" : task.status,
    },
  };
}

function persistPublishTaskMarker(task) {
  try {
    if (!task?.id || !task?.folderPath || !isSafeTaskFolderPath(task.folderPath)) return;
    if (!fs.existsSync(task.folderPath)) return;
    fs.writeFileSync(
      taskMarkerPath(task.folderPath),
      JSON.stringify(taskMarkerPayload(task), null, 2),
    );
  } catch {}
}

function persistPublishTaskMarkers(state) {
  for (const task of state.publishTasks || []) persistPublishTaskMarker(task);
}

function readTaskMarker(folderPath) {
  try {
    const markerPath = taskMarkerPath(folderPath);
    if (!fs.existsSync(markerPath)) return null;
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function copiedTaskStats(task) {
  let copiedFiles = 0;
  let copiedBytes = 0;
  let totalFiles = 0;
  let totalBytes = 0;
  for (const item of task.items || []) {
    for (const file of item.files || []) {
      totalFiles += 1;
      totalBytes += Number(file.size) || 0;
      const target = path.join(task.folderPath, file.relativePath || "");
      if (!fs.existsSync(target)) continue;
      const stat = fs.statSync(target);
      const expectedSize = Number(file.size) || stat.size;
      if (stat.size === expectedSize) {
        copiedFiles += 1;
        copiedBytes += stat.size;
      }
    }
  }
  return { copiedFiles, copiedBytes, totalFiles, totalBytes };
}

function normalizeRecoveredTask(task, folderPath, marker = {}) {
  const next = {
    ...task,
    id: task.id || marker.taskId,
    name: task.name || path.basename(folderPath),
    folderPath,
    items: task.items || [],
    platformIds: [...new Set(task.platformIds || [])],
    completedPlatformIds: task.completedPlatformIds || [],
    missingCovers: task.missingCovers || [],
    error: task.error || "",
    createdAt: task.createdAt || marker.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const stats = copiedTaskStats(next);
  next.totalFiles = next.totalFiles || stats.totalFiles;
  next.totalBytes = next.totalBytes || stats.totalBytes;
  next.copiedFiles = stats.copiedFiles || next.copiedFiles || 0;
  next.copiedBytes = stats.copiedBytes || next.copiedBytes || 0;
  if (next.totalFiles && stats.copiedFiles >= next.totalFiles) {
    next.status = taskPlatformsFinished(next) ? "completed" : "ready";
    next.error = "";
  } else if (next.status === "copying" || !next.status) {
    next.status = "copy_failed";
    next.error ||= "软件关闭时复制未完成，可点击“继续提取”";
  }
  return next;
}

function platformForRecoveredFolder(state, folderName) {
  const normalized = safeName(folderName, folderName).toLowerCase();
  return (state.platforms || []).find((platform) =>
    [platform.name, platform.accountName, platform.id]
      .filter(Boolean)
      .some((value) => safeName(value, value).toLowerCase() === normalized),
  );
}

function groupForRecoveredFolder(state, folderName, fileNames = []) {
  const normalized = String(folderName || "").toLowerCase();
  const byCode = (state.groups || []).find((group) =>
    group.code && normalized.startsWith(`${String(group.code).toLowerCase()}_`),
  );
  if (byCode) return byCode;
  const byTitle = (state.groups || []).find((group) =>
    group.title && normalized.includes(String(group.title).toLowerCase()),
  );
  if (byTitle) return byTitle;
  const loweredFileNames = fileNames.map((name) => String(name || "").toLowerCase());
  return (state.groups || []).find((group) =>
    Object.values(group.assets || {}).some((asset) =>
      asset?.filename && loweredFileNames.includes(String(asset.filename).toLowerCase()),
    ),
  );
}

function sourceAssetForRecoveredFile(group, version, filename) {
  const slots = publishVersionSlotsForGroup(group, version);
  const lowered = String(filename || "").toLowerCase();
  return slots
    .map((slot) => group.assets?.[slot])
    .find((asset) =>
      asset?.filename && String(asset.filename).toLowerCase() === lowered,
    );
}

function recoverTaskFromFolder(state, folderPath, marker) {
  if (marker?.task) return normalizeRecoveredTask(marker.task, folderPath, marker);
  const id = marker?.taskId;
  if (!id) return null;
  const items = [];
  const platformIds = [];
  const platformDirs = fs.readdirSync(folderPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  for (const platformDir of platformDirs) {
    const platform = platformForRecoveredFolder(state, platformDir.name);
    if (!platform) continue;
    platformIds.push(platform.id);
    const platformFolderPath = path.join(folderPath, platformDir.name);
    const videoDirs = fs.readdirSync(platformFolderPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    for (const videoDir of videoDirs) {
      const videoFolderPath = path.join(platformFolderPath, videoDir.name);
      const versionDirs = fs.readdirSync(videoFolderPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory());
      for (const versionDir of versionDirs) {
        const version = versionDir.name.includes("三创")
          ? "third"
          : versionDir.name.includes("二创")
            ? "remix"
            : "original";
        const versionFolderPath = path.join(videoFolderPath, versionDir.name);
        const copiedFiles = fs.readdirSync(versionFolderPath, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name !== TASK_MARKER && !entry.name.endsWith(".part"));
        if (!copiedFiles.length) continue;
        const group = groupForRecoveredFolder(
          state,
          videoDir.name,
          copiedFiles.map((file) => file.name),
        );
        if (!group) continue;
        const files = copiedFiles.map((file) => {
          const fullPath = path.join(versionFolderPath, file.name);
          const stat = fs.statSync(fullPath);
          const sourceAsset = sourceAssetForRecoveredFile(group, version, file.name);
          return {
            slot: sourceAsset?.slot || "",
            sourcePath: sourceAsset?.path || fullPath,
            filename: file.name,
            size: stat.size,
            relativePath: path.relative(folderPath, fullPath),
          };
        });
        items.push({
          groupId: group.id,
          version,
          title: group.title,
          code: group.code,
          platformId: platform.id,
          platformIds: [platform.id],
          platformName: platform.name,
          platformFolder: platformDir.name,
          files,
        });
      }
    }
  }
  if (!items.length) return null;
  const totalBytes = items.reduce(
    (sum, item) => sum + item.files.reduce((fileSum, file) => fileSum + file.size, 0),
    0,
  );
  return {
    id,
    name: path.basename(folderPath),
    folderPath,
    items,
    platformIds: [...new Set(platformIds)],
    completedPlatformIds: [],
    missingCovers: [],
    totalFiles: items.reduce((sum, item) => sum + item.files.length, 0),
    copiedFiles: items.reduce((sum, item) => sum + item.files.length, 0),
    totalBytes,
    copiedBytes: totalBytes,
    status: "ready",
    error: "",
    createdAt: marker.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoveredFromFolder: true,
  };
}

function recoverPublishTasksFromFolders(state) {
  const rootPath = publishRoot();
  if (!fs.existsSync(rootPath)) return state;
  const existingIds = new Set((state.publishTasks || []).map((task) => task.id));
  const recovered = [];
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folderPath = path.join(rootPath, entry.name);
    if (!isSafeTaskFolderPath(folderPath)) continue;
    const marker = readTaskMarker(folderPath);
    if (!marker?.taskId || existingIds.has(marker.taskId)) continue;
    const task = recoverTaskFromFolder(state, folderPath, marker);
    if (task) {
      recovered.push(task);
      existingIds.add(task.id);
    }
  }
  if (recovered.length) {
    state.publishTasks = [...recovered, ...(state.publishTasks || [])];
  }
  return state;
}

function taskFileDefinitions(group, version) {
  const versionInfo = PUBLISH_VERSIONS[version] || PUBLISH_VERSIONS.original;
  const definitions = publishVersionSlotsForGroup(group, version).map((slot, index) => [
    slot,
    taskSlotLabel(slot, index),
    index === 0,
  ]);
  const missingRequired = [];
  const missingCovers = [];
  const files = [];
  for (const [slot, label, required] of definitions) {
    const asset = group.assets?.[slot];
    if (!asset?.path || !fs.existsSync(asset.path)) {
      (required ? missingRequired : missingCovers).push(`${group.title} · ${versionInfo.label} · ${label}`);
      continue;
    }
    const stat = fs.statSync(asset.path);
    files.push({
      slot,
      sourcePath: asset.path,
      filename: asset.filename || path.basename(asset.path),
      size: stat.size,
    });
  }
  return { files, missingRequired, missingCovers };
}

function createPlatformPublishTask(payload) {
  if (!Array.isArray(payload.platformSelections)) {
    payload = {
      ...payload,
      platformSelections: (payload.platformIds || []).map((platformId) => ({
        platformId,
        items: payload.items || [],
      })),
    };
  }
  const state = readState();
  const activePlatforms = new Map(
    state.platforms
      .filter((platform) => platform.active)
      .map((platform) => [platform.id, platform]),
  );
  const now = new Date().toISOString();
  const platformContentCategory = (platform) => {
    const searchable = `${platform?.name || ""} ${platform?.accountName || ""}`;
    return searchable.includes("老而不衰") ? "ageless" : "facelift";
  };
  const effectiveDouyinOriginalPlatform = (group) => {
    if (group.douyinOriginalPlatformId) return group.douyinOriginalPlatformId;
    if (group.publishMarks?.["original:platform-1"]) return "platform-1";
    if (group.publishMarks?.["original:platform-2"]) return "platform-2";
    if (group.publishMarks?.["remix:platform-1"]) return "platform-2";
    if (group.publishMarks?.["remix:platform-2"]) return "platform-1";
    return "";
  };

  for (const [groupId, originalPlatformId] of Object.entries(payload.douyinAssignments || {})) {
    const group = state.groups.find((item) => item.id === groupId);
    if (!group || group.category !== "facelift") continue;
    if (!["platform-1", "platform-2"].includes(originalPlatformId)) continue;
    const hasDouyinPublish = ["platform-1", "platform-2"].some((platformId) =>
      ["original", "remix"].some((version) =>
        group.publishMarks?.[`${version}:${platformId}`],
      ),
    );
    if (
      hasDouyinPublish &&
      group.douyinOriginalPlatformId &&
      group.douyinOriginalPlatformId !== originalPlatformId
    ) {
      throw new Error(`${group.title} 的抖音原创归属已经锁定，不能修改`);
    }
    group.douyinOriginalPlatformId = originalPlatformId;
    if (hasDouyinPublish) group.douyinAssignmentLockedAt ||= now;
  }

  const missingRequired = [];
  const missingCovers = [];
  const items = [];
  for (const selection of payload.platformSelections) {
    const platform = activePlatforms.get(selection.platformId);
    if (!platform) continue;
    for (const requested of selection.items || []) {
      const group = state.groups.find((item) => item.id === requested.groupId);
      const version = PUBLISH_VERSIONS[requested.version] ? requested.version : "original";
      if (!group || group.hidden) continue;
      if (group.workflowStatus === "pending_edit") {
        throw new Error(`${group.title} 仍在待剪辑分类，不能创建发布任务`);
      }
      if (group.category !== platformContentCategory(platform)) {
        throw new Error(
          group.category === "ageless"
            ? `${group.title} 只能发布到名称带“老而不衰”的账号`
            : `${group.title} 不能发布到“老而不衰”专用账号`,
        );
      }
      if (!payload.allowRepeat && group.publishMarks?.[`${version}:${platform.id}`]) continue;

      if (
        group.category === "facelift" &&
        ["platform-1", "platform-2"].includes(platform.id)
      ) {
        const originalPlatformId = effectiveDouyinOriginalPlatform(group);
        if (!originalPlatformId) {
          throw new Error(`${group.title} 尚未选择抖音1号/2号的原创归属`);
        }
        group.douyinOriginalPlatformId ||= originalPlatformId;
        const allowedVersion =
          platform.id === originalPlatformId ? "original" : "remix";
        if (["original", "remix"].includes(version) && version !== allowedVersion) {
          throw new Error(
            `${group.title} 在 ${platform.name} 只能发布${
              PUBLISH_VERSIONS[allowedVersion].label
            }`,
          );
        }
      }

      const checked = taskFileDefinitions(group, version);
      missingRequired.push(...checked.missingRequired);
      missingCovers.push(...checked.missingCovers);
      items.push({
        groupId: group.id,
        version,
        title: group.title,
        code: group.code,
        platformId: platform.id,
        platformIds: [platform.id],
        platformName: platform.name,
        files: checked.files,
      });
    }
  }
  if (missingRequired.length) {
    const error = new Error(`缺少发布成片：${missingRequired.join("；")}`);
    error.statusCode = 400;
    throw error;
  }
  if (missingCovers.length && !payload.allowMissingCovers) {
    const error = new Error(`部分封面缺失：${missingCovers.join("；")}`);
    error.statusCode = 409;
    error.details = { missingCovers };
    throw error;
  }
  if (!items.length) throw new Error("所选库存已经发布或已被隐藏，没有可提取的视频");

  const platformIds = [...new Set(items.map((item) => item.platformId))];
  const id = crypto.randomUUID();
  const folderPath = path.join(publishRoot(), taskFolderName(id));
  for (const item of items) {
    const platformFolder = safeName(item.platformName, item.platformId);
    const videoFolder = safeName(`${item.code || ""}_${item.title}`, item.groupId);
    const versionFolder = PUBLISH_VERSIONS[item.version]?.folder || item.version;
    item.platformFolder = platformFolder;
    item.files = item.files.map((file) => ({
      ...file,
      relativePath: path.join(
        platformFolder,
        videoFolder,
        versionFolder,
        file.filename,
      ),
    }));
  }
  const allFiles = items.flatMap((item) => item.files);
  const totalBytes = allFiles.reduce((sum, file) => sum + file.size, 0);
  fs.mkdirSync(publishRoot(), { recursive: true });
  if (typeof fs.statfsSync === "function") {
    const disk = fs.statfsSync(publishRoot());
    const available = Number(disk.bavail) * Number(disk.bsize);
    if (Number.isFinite(available) && available < totalBytes + 50 * 1024 * 1024) {
      throw new Error("桌面磁盘剩余空间不足，无法创建发布任务");
    }
  }
  fs.mkdirSync(folderPath, { recursive: false });
  fs.writeFileSync(
    taskMarkerPath(folderPath),
    JSON.stringify({ taskId: id, createdAt: now }, null, 2),
  );
  const task = {
    id,
    name: path.basename(folderPath),
    folderPath,
    items,
    platformIds,
    completedPlatformIds: [],
    missingCovers,
    totalFiles: allFiles.length,
    copiedFiles: 0,
    totalBytes,
    copiedBytes: 0,
    status: "copying",
    error: "",
    createdAt: now,
    updatedAt: now,
  };
  writeState({ ...state, publishTasks: [task, ...(state.publishTasks || [])] });
  startCopyTask(id);
  return task;
}

function updateTask(taskId, updater) {
  const state = readState();
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task) return null;
  updater(task, state);
  task.updatedAt = new Date().toISOString();
  writeState(state);
  return task;
}

async function copyFileWithProgress(sourcePath, destinationPath, taskId, size, baseBytes) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).size === size) return;
  const partialPath = `${destinationPath}.part`;
  await fs.promises.rm(partialPath, { force: true });
  await new Promise((resolve, reject) => {
    const source = fs.createReadStream(sourcePath);
    const destination = fs.createWriteStream(partialPath);
    let transferred = 0;
    let lastSavedAt = 0;
    const fail = (error) => {
      source.destroy();
      destination.destroy();
      reject(error);
    };
    source.on("data", (chunk) => {
      transferred += chunk.length;
      const now = Date.now();
      if (cancelledCopyJobs.has(taskId)) return fail(new Error("任务已取消"));
      if (now - lastSavedAt >= 300) {
        lastSavedAt = now;
        updateTask(taskId, (current) => {
          current.copiedBytes = Math.min(current.totalBytes, baseBytes + transferred);
        });
      }
    });
    source.on("error", fail);
    destination.on("error", fail);
    destination.on("finish", resolve);
    source.pipe(destination);
  });
  if (cancelledCopyJobs.has(taskId)) throw new Error("任务已取消");
  await fs.promises.rm(destinationPath, { force: true });
  await fs.promises.rename(partialPath, destinationPath);
}

function startCopyTask(taskId) {
  if (activeCopyJobs.has(taskId)) return;
  activeCopyJobs.add(taskId);
  (async () => {
    try {
      const initialState = readState();
      const task = initialState.publishTasks.find((item) => item.id === taskId);
      if (!task) return;
      validateTaskFolder(task);
      let copiedFiles = 0;
      let copiedBytes = 0;
      for (const item of task.items) {
        for (const file of item.files) {
          if (cancelledCopyJobs.has(taskId)) throw new Error("任务已取消");
          if (!fs.existsSync(file.sourcePath)) throw new Error(`源文件不存在：${file.sourcePath}`);
          await copyFileWithProgress(file.sourcePath, path.join(task.folderPath, file.relativePath), taskId, file.size, copiedBytes);
          copiedFiles += 1;
          copiedBytes += file.size;
          updateTask(taskId, (current) => {
            current.copiedFiles = copiedFiles;
            current.copiedBytes = copiedBytes;
            current.status = "copying";
            current.error = "";
          });
        }
      }
      updateTask(taskId, (current) => {
        current.copiedFiles = current.totalFiles;
        current.copiedBytes = current.totalBytes;
        current.status = "ready";
        current.error = "";
      });
    } catch (error) {
      const cancelled = cancelledCopyJobs.has(taskId);
      const state = readState();
      const task = state.publishTasks.find((item) => item.id === taskId);
      if (task) {
        if (cancelled) {
          try {
            removeTaskFolder(task);
            state.publishTasks = state.publishTasks.filter((item) => item.id !== taskId);
          } catch (cleanupError) {
            task.status = "cleanup_failed";
            task.error = cleanupError.message;
          }
        } else {
          task.status = "copy_failed";
          task.error = error.message;
        }
        writeState(state);
      }
    } finally {
      activeCopyJobs.delete(taskId);
      cancelledCopyJobs.delete(taskId);
    }
  })();
}

function taskPlatformsFinished(task) {
  const completed = new Set(task.completedPlatformIds || []);
  return Boolean(task.platformIds?.length) &&
    task.platformIds.every((id) => completed.has(id));
}

function finishPublishTaskIfComplete(state, taskId) {
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task || !taskPlatformsFinished(task)) return false;
  task.status = "completed";
  task.error = "";
  task.updatedAt = new Date().toISOString();
  return true;
}

function completeTaskPlatform(taskId, platformId) {
  const state = readState();
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task) throw new Error("发布任务不存在");
  if (!task.platformIds.includes(platformId)) throw new Error("该账号不属于此任务");
  if (task.completedPlatformIds.includes(platformId)) return { state, task, finished: false };
  if (!["ready", "cleanup_failed"].includes(task.status) && fs.existsSync(task.folderPath)) {
    throw new Error("素材仍在复制中，请等待复制完成");
  }
  const now = new Date().toISOString();
  state.publishHistory ??= [];
  for (const item of task.items) {
    if (!item.platformIds.includes(platformId)) continue;
    const group = state.groups.find((candidate) => candidate.id === item.groupId);
    if (!group) continue;
    const key = `${item.version}:${platformId}`;
    group.publishMarks ||= {};
    group.publishMarkTimes ||= {};
    const previouslyPublished = Boolean(group.publishMarks[key]);
    const previousPublishedAt = group.publishMarkTimes[key] || "";
    if (!group.publishMarks[key]) group.publishMarkTimes[key] = now;
    group.publishMarks[key] = true;
    group.updatedAt = now;
    if (
      group.category === "facelift" &&
      ["platform-1", "platform-2"].includes(platformId) &&
      ["original", "remix"].includes(item.version)
    ) {
      if (!group.douyinOriginalPlatformId) {
        group.douyinOriginalPlatformId =
          item.version === "original"
            ? platformId
            : platformId === "platform-1"
              ? "platform-2"
              : "platform-1";
      }
      group.douyinAssignmentLockedAt ||= now;
    }
    state.publishHistory.push({
      id: crypto.randomUUID(),
      groupId: group.id,
      version: item.version,
      platformId,
      publishedAt: now,
      source: "publish-task",
      taskId: task.id,
      previouslyPublished,
      previousPublishedAt,
    });
  }
  task.completedPlatformIds.push(platformId);
  task.updatedAt = now;
  const finished = finishPublishTaskIfComplete(state, taskId);
  return { state: writeState(state), task, finished };
}

function undoTaskPlatform(taskId, platformId) {
  const state = readState();
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task) throw new Error("发布任务不存在");
  if (!task.platformIds.includes(platformId)) throw new Error("该账号不属于此任务");
  if (!task.completedPlatformIds.includes(platformId)) throw new Error("该账号尚未确认发布");

  state.publishHistory ??= [];
  const removedEntries = state.publishHistory.filter((entry) =>
    entry.source === "publish-task" &&
    entry.taskId === task.id &&
    entry.platformId === platformId,
  );
  state.publishHistory = state.publishHistory.filter((entry) => !(
    entry.source === "publish-task" &&
    entry.taskId === task.id &&
    entry.platformId === platformId
  ));

  const now = new Date().toISOString();
  for (const item of task.items) {
    if (!(item.platformIds || []).includes(platformId)) continue;
    const group = state.groups.find((candidate) => candidate.id === item.groupId);
    if (!group) continue;
    const key = `${item.version}:${platformId}`;
    group.publishMarks ||= {};
    group.publishMarkTimes ||= {};
    const remainingEntries = state.publishHistory
      .filter((entry) =>
        entry.groupId === item.groupId &&
        entry.version === item.version &&
        entry.platformId === platformId,
      )
      .sort((left, right) => Date.parse(right.publishedAt || "") - Date.parse(left.publishedAt || ""));
    const removedEntry = removedEntries.find((entry) =>
      entry.groupId === item.groupId && entry.version === item.version,
    );
    if (remainingEntries.length) {
      group.publishMarks[key] = true;
      group.publishMarkTimes[key] = remainingEntries[0].publishedAt;
    } else if (removedEntry?.previouslyPublished) {
      group.publishMarks[key] = true;
      if (removedEntry.previousPublishedAt) group.publishMarkTimes[key] = removedEntry.previousPublishedAt;
      else delete group.publishMarkTimes[key];
    } else {
      delete group.publishMarks[key];
      delete group.publishMarkTimes[key];
    }
    group.updatedAt = now;
  }

  task.completedPlatformIds = task.completedPlatformIds.filter((id) => id !== platformId);
  task.status = "ready";
  task.error = "";
  task.updatedAt = now;
  return { state: writeState(state), task };
}

function finalizePublishTask(taskId) {
  const state = readState();
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task) throw new Error("发布任务不存在");
  if (!taskPlatformsFinished(task)) throw new Error("仍有账号尚未确认发布");
  try {
    removeTaskFolder(task);
    state.publishTasks = state.publishTasks.filter((item) => item.id !== taskId);
    return writeState(state);
  } catch (error) {
    task.status = "cleanup_failed";
    task.error = error.message;
    writeState(state);
    throw error;
  }
}

function removeTaskPlatform(taskId, platformId) {
  const state = readState();
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task) throw new Error("发布任务不存在");
  if (!task.platformIds.includes(platformId)) throw new Error("该账号不属于此任务");
  if (task.completedPlatformIds.includes(platformId)) {
    throw new Error("该账号已经确认发布，不能从任务中移除");
  }
  if (activeCopyJobs.has(taskId) || task.status === "copying") {
    throw new Error("素材正在复制，请等待提取完成后再选择本次不发");
  }
  const platformItems = task.items.filter((item) =>
    (item.platformIds || []).includes(platformId),
  );
  const platformFolders = [...new Set(
    platformItems.map((item) => item.platformFolder).filter(Boolean),
  )];
  if (fs.existsSync(task.folderPath)) {
    validateTaskFolder(task);
    for (const folder of platformFolders) {
      const child = path.resolve(task.folderPath, folder);
      const rootPath = path.resolve(task.folderPath);
      if (path.dirname(child) !== rootPath) {
        throw new Error("平台目录安全校验失败，已拒绝清理");
      }
      fs.rmSync(child, { recursive: true, force: true });
    }
  }
  task.items = task.items.filter(
    (item) => !(item.platformIds || []).includes(platformId),
  );
  task.platformIds = task.platformIds.filter((id) => id !== platformId);
  task.totalFiles = task.items.reduce((sum, item) => sum + item.files.length, 0);
  task.totalBytes = task.items.reduce(
    (sum, item) => sum + item.files.reduce((fileSum, file) => fileSum + file.size, 0),
    0,
  );
  task.copiedFiles = Math.min(task.copiedFiles, task.totalFiles);
  task.copiedBytes = Math.min(task.copiedBytes, task.totalBytes);
  task.updatedAt = new Date().toISOString();
  if (!task.platformIds.length || taskPlatformsFinished(task)) {
    try {
      removeTaskFolder(task);
      state.publishTasks = state.publishTasks.filter((item) => item.id !== taskId);
    } catch (error) {
      task.status = "cleanup_failed";
      task.error = error.message;
    }
  }
  return writeState(state);
}

function cancelPublishTask(taskId) {
  const state = readState();
  const task = state.publishTasks.find((item) => item.id === taskId);
  if (!task) throw new Error("发布任务不存在");
  if (activeCopyJobs.has(taskId)) {
    cancelledCopyJobs.add(taskId);
    task.status = "canceling";
    writeState(state);
    return { pending: true };
  }
  try {
    removeTaskFolder(task);
    state.publishTasks = state.publishTasks.filter((item) => item.id !== taskId);
    writeState(state);
    return { pending: false };
  } catch (error) {
    task.status = "cleanup_failed";
    task.error = error.message;
    writeState(state);
    throw error;
  }
}

function sendMedia(request, response, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
    return respond(response, 404, { error: "文件不存在" });
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
    ".webm": "video/webm", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".bmp": "image/bmp",
  }[ext] || "application/octet-stream";
  const range = request.headers.range;
  if (range) {
    const [startText, endText] = range.replace("bytes=", "").split("-");
    const start = Number(startText);
    const end = endText ? Number(endText) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
    response.writeHead(206, {
      "content-type": mime, "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "content-length": String(end - start + 1),
      "access-control-allow-origin": "*",
    });
    fs.createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, {
    "content-type": mime, "content-length": String(stat.size),
    "accept-ranges": "bytes", "access-control-allow-origin": "*",
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (request.method === "OPTIONS") return respond(response, 204, "");
    if (url.pathname === "/api/health")
      return respond(response, 200, { ok: true, version: SERVER_VERSION });
    if (url.pathname === "/api/state" && request.method === "GET")
      return respond(response, 200, readState());
    if (url.pathname === "/api/state" && request.method === "PUT")
      return respond(response, 200, writeState(await bodyJson(request)));
    if (url.pathname === "/api/publish-tasks" && request.method === "POST") {
      const task = createPlatformPublishTask(await bodyJson(request));
      return respond(response, 201, { task });
    }
    const publishTaskMatch = url.pathname.match(/^\/api\/publish-tasks\/([^/]+)\/(open|complete-platform|undo-platform|remove-platform|finalize|cancel|retry|retry-cleanup)$/);
    if (publishTaskMatch && request.method === "POST") {
      const taskId = decodeURIComponent(publishTaskMatch[1]);
      const action = publishTaskMatch[2];
      const state = readState();
      const task = state.publishTasks.find((item) => item.id === taskId);
      if (!task) return respond(response, 404, { error: "发布任务不存在" });
      if (action === "open") {
        if (!fs.existsSync(task.folderPath)) return respond(response, 404, { error: "任务文件夹已被手动删除" });
        openExplorerForeground(task.folderPath);
        return respond(response, 200, { ok: true });
      }
      if (action === "complete-platform") {
        const body = await bodyJson(request);
        return respond(response, 200, completeTaskPlatform(taskId, body.platformId));
      }
      if (action === "undo-platform") {
        const body = await bodyJson(request);
        return respond(response, 200, undoTaskPlatform(taskId, body.platformId));
      }
      if (action === "remove-platform") {
        const body = await bodyJson(request);
        return respond(response, 200, removeTaskPlatform(taskId, body.platformId));
      }
      if (action === "finalize") return respond(response, 200, finalizePublishTask(taskId));
      if (action === "cancel") return respond(response, 200, cancelPublishTask(taskId));
      if (action === "retry") {
        if (!fs.existsSync(task.folderPath)) {
          fs.mkdirSync(task.folderPath, { recursive: true });
          fs.writeFileSync(taskMarkerPath(task.folderPath), JSON.stringify({ taskId, createdAt: task.createdAt }, null, 2));
        } else {
          validateTaskFolder(task);
        }
        updateTask(taskId, (current) => {
          current.status = "copying";
          current.error = "";
          current.copiedFiles = 0;
          current.copiedBytes = 0;
        });
        startCopyTask(taskId);
        return respond(response, 200, { ok: true });
      }
      if (action === "retry-cleanup") {
        removeTaskFolder(task);
        state.publishTasks = state.publishTasks.filter((item) => item.id !== taskId);
        return respond(response, 200, writeState(state));
      }
    }
    if (url.pathname === "/api/pick-directory" && request.method === "POST") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = '选择需要扫描的视频素材目录'",
        "$d.ShowNewFolderButton = $false",
        "$owner = New-Object System.Windows.Forms.Form",
        "$owner.TopMost = $true",
        "$owner.ShowInTaskbar = $false",
        "$owner.StartPosition = 'CenterScreen'",
        "$owner.Width = 1",
        "$owner.Height = 1",
        "$owner.Opacity = 0",
        "$owner.Show()",
        "$result = $d.ShowDialog($owner)",
        "$owner.Close()",
        "if ($result -eq 'OK') { [Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath }",
      ].join("; ");
      const selected = await new Promise((resolve) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-STA", "-Command", script],
          { encoding: "utf8" },
          (error, stdout) => resolve(error ? "" : stdout.trim()),
        );
      });
      return respond(response, 200, { path: selected });
    }
    if (url.pathname === "/api/scan" && request.method === "POST") {
      const body = await bodyJson(request);
      const requestedSources = (body.sources ?? [])
        .filter((source) => source && typeof source.path === "string")
        .map((source) => ({
          path: source.path,
          category: source.category === "ageless" ? "ageless" : "facelift",
        }));
      const requestedPaths = requestedSources.length
        ? requestedSources.map((source) => source.path)
        : body.paths ?? [];
      const paths = requestedPaths.filter(
        (item) => typeof item === "string" && fs.existsSync(item),
      );
      const state = readState();
      const scanAll = body.mode === "all";
      const importedAssetIds = new Set(
        state.groups.flatMap((group) =>
          Object.values(group.assets ?? {}).map((asset) => asset?.id).filter(Boolean),
        ),
      );
      const importedTitles = new Set(
        state.groups.map((group) => String(group.title ?? "").trim().toLowerCase()).filter(Boolean),
      );
      const scanResult = scanDirectories(paths, {
        importedAssetIds: scanAll ? new Set() : importedAssetIds,
        importedTitles: scanAll ? new Set() : importedTitles,
        sourceCategories: requestedSources,
      });
      const candidates = scanResult.candidates.map((candidate) => {
        const candidatePaths = new Set(candidate.files.map((file) => path.resolve(file.path).toLowerCase()));
        const normalizedTitle = String(candidate.suggestedTitle ?? "").trim().toLowerCase();
        const existingGroup = state.groups
          .map((group) => {
          const sameTitle = String(group.title ?? "").trim().toLowerCase() === normalizedTitle;
          const samePathCount = Object.values(group.assets ?? {}).filter(
            (asset) =>
              asset?.path &&
              candidatePaths.has(path.resolve(asset.path).toLowerCase()),
          ).length;
          const assetCount = Object.values(group.assets ?? {}).filter(Boolean).length;
          return {
            group,
            score:
              samePathCount * 100 +
              (sameTitle ? 30 : 0) +
              (group.category === candidate.category ? 5 : 0) +
              Math.min(assetCount, 9) / 10,
          };
        })
          .filter((match) => match.score >= 30)
          .sort((left, right) => right.score - left.score)[0]?.group;
        return existingGroup
          ? {
              ...candidate,
              groupId: existingGroup.id,
              suggestedTitle: existingGroup.title,
              code: existingGroup.code,
              title: existingGroup.title,
              notes: existingGroup.notes,
              publishMarks: existingGroup.publishMarks,
              publishMarkTimes: existingGroup.publishMarkTimes,
            }
          : candidate;
      });
      const sources = [...state.sources];
      for (const sourcePath of paths) {
        const found = sources.find((source) => source.path.toLowerCase() === sourcePath.toLowerCase());
        const requestedSource = requestedSources.find(
          (source) => source.path.toLowerCase() === sourcePath.toLowerCase(),
        );
        if (found) {
          found.lastScannedAt = new Date().toISOString();
          if (requestedSource) found.category = requestedSource.category;
        } else {
          sources.push({
            id: crypto.randomUUID(),
            path: sourcePath,
            category: requestedSource?.category ?? categoryFromPath(sourcePath),
            lastScannedAt: new Date().toISOString(),
          });
        }
      }
      writeState({ ...state, sources });
      return respond(response, 200, {
        candidates,
        fileCount: candidates.reduce((sum, item) => sum + item.files.length, 0),
        scannedFileCount: scanResult.fileCount,
        mode: scanAll ? "all" : "new",
      });
    }
    if (url.pathname === "/api/reset-materials" && request.method === "POST") {
      const state = readState();
      if (state.publishTasks?.length) {
        return respond(response, 409, { error: "还有发布任务未结束，请先完成或取消发布任务" });
      }
      const resolvedDataDir = path.resolve(dataDir);
      const resolvedCacheDir = path.resolve(cacheDir);
      if (resolvedCacheDir.startsWith(`${resolvedDataDir}${path.sep}`)) {
        fs.rmSync(resolvedCacheDir, { recursive: true, force: true });
        fs.mkdirSync(resolvedCacheDir, { recursive: true });
      }
      return respond(response, 200, writeState({ ...state, groups: [], publishHistory: [] }));
    }
    if (url.pathname === "/api/confirm-import" && request.method === "POST")
      return respond(response, 200, confirmCandidate(await bodyJson(request)));
    if (url.pathname === "/api/open" && request.method === "POST") {
      const body = await bodyJson(request);
      const target = body.kind === "folder" ? path.dirname(body.path) : body.path;
      if (!target || !fs.existsSync(target)) return respond(response, 404, { error: "文件不可用" });
      openExplorerForeground(target);
      return respond(response, 200, { ok: true });
    }
    if (url.pathname === "/media") return sendMedia(request, response, url.searchParams.get("path"));

    let requested = decodeURIComponent(url.pathname);
    if (requested === "/") requested = "/index.html";
    const filePath = path.normalize(path.join(publicDir, requested));
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath))
      return respond(response, 404, "Not found", "text/plain; charset=utf-8");
    const ext = path.extname(filePath);
    const mime = {
      ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8", ".png": "image/png",
      ".svg": "image/svg+xml; charset=utf-8", ".ico": "image/x-icon",
    }[ext] || "application/octet-stream";
    respond(response, 200, fs.readFileSync(filePath), mime);
  } catch (error) {
    respond(response, error?.statusCode || 500, {
      error: error instanceof Error ? error.message : "操作失败",
      ...(error?.details || {}),
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`视频素材管理器已启动：http://127.0.0.1:${PORT}`);
  if (process.argv.includes("--open")) {
    const url = `http://127.0.0.1:${PORT}`;
    const chromePaths = [
      process.env["PROGRAMFILES"] && path.join(process.env["PROGRAMFILES"], "Google", "Chrome", "Application", "chrome.exe"),
      process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ].filter(Boolean);
    const chrome = chromePaths.find((candidate) => fs.existsSync(candidate));
    if (chrome) spawn(chrome, [`--app=${url}`, "--start-maximized"], { detached: true, stdio: "ignore" }).unref();
    else execFile("cmd.exe", ["/c", "start", "", url]);
  }
  const startupState = readState();
  let startupChanged = false;
  for (const task of [...(startupState.publishTasks || [])]) {
    if (taskPlatformsFinished(task)) {
      finishPublishTaskIfComplete(startupState, task.id);
      startupChanged = true;
    }
  }
  if (startupChanged) writeState(startupState);
  for (const task of startupState.publishTasks || []) {
    if (task.status === "copying") startCopyTask(task.id);
  }
});
