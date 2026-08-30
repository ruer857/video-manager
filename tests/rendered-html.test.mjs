import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished video manager", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>视频素材管理器<\/title>/i);
  assert.match(html, /视频素材管理器/);
  assert.match(html, /正在整理你的内容工作台/);
  assert.match(html, /让每一条内容从素材到发布都有迹可循/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("starter preview is removed and desktop companion is present", async () => {
  const previewFiles = await readdir(new URL("app/_sites-preview", root)).catch(
    () => [],
  );
  assert.deepEqual(previewFiles, []);
  const [server, desktop, localManagement, page, packageJson] = await Promise.all([
    readFile(new URL("desktop/server.mjs", root), "utf8"),
    readFile(new URL("desktop/public/index.html", root), "utf8"),
    readFile(new URL("desktop/public/local-management.js", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
  ]);
  assert.match(server, /DatabaseSync/);
  assert.match(server, /api\/scan/);
  assert.match(server, /openExplorerForeground/);
  assert.match(server, /SetForegroundWindow/);
  assert.match(desktop, /id="sort-filter"/);
  assert.match(desktop, /素材时间：最新优先/);
  assert.match(localManagement, /今日累计已发布/);
  assert.match(localManagement, /publishMarkTimes/);
  assert.match(localManagement, /data-published-list-mode="all"/);
  assert.match(localManagement, /发布记录/);
  assert.match(localManagement, /platform-history-date/);
  assert.match(localManagement, /Number\(candidate\.confidence\) >= 90/);
  assert.match(localManagement, /正在自动归组/);
  assert.match(localManagement, /autoImportError/);
  assert.match(localManagement, /\.map\(\(group\) => \[group\.id, effectiveDouyinOriginalPlatform\(group\)\]\)/);
  assert.match(localManagement, /抖音拉皮号库存/);
  assert.match(localManagement, /DOUYIN_FACELIFT_INVENTORY_ID/);
  assert.doesNotMatch(localManagement, /任务中分配原版\/二创/);
  assert.match(localManagement, /data-open-inventory-file/);
  assert.match(localManagement, /打开文件位置/);
  assert.match(localManagement, /renderWithScrollPreservation/);
  assert.match(localManagement, /platform-stock-list/);
  assert.match(localManagement, /window\.scrollTo\(pageScroll\.x, pageScroll\.y\)/);
  assert.match(localManagement, /updateSelectionUi/);
  assert.match(localManagement, /restoreScrollAfterRender/);
  assert.match(localManagement, /publishTargetApplies/);
  assert.match(localManagement, /not-applicable/);
  assert.match(localManagement, /douyin-version-row/);
  assert.match(localManagement, /data-douyin-version-choice/);
  assert.match(localManagement, /applyDraftDouyinAssignment/);
  assert.match(server, /publishVersionSlotsForGroup/);
  assert.match(desktop, /待归组素材/);
  assert.match(page, /VideoManager/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});
