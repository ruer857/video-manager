import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("desktop companion persists state and scans a media directory", async (t) => {
  const testPort = 48128;
  const appData = await mkdtemp(path.join(os.tmpdir(), "video-manager-test-"));
  const publishDesktop = await mkdtemp(
    path.join(os.tmpdir(), "video-manager-publish-desktop-"),
  );
  const child = spawn(process.execPath, ["desktop/server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      APPDATA: appData,
      VIDEO_MANAGER_PORT: String(testPort),
      VIDEO_MANAGER_PUBLISH_ROOT: publishDesktop,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());

  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);

  const stateResponse = await fetch(`http://127.0.0.1:${testPort}/api/state`);
  const state = await stateResponse.json();
  assert.equal(state.platforms.length, 8);
  assert.equal(state.groups.length, 0);

  state.groups.push({
    id: "test-group",
    category: "facelift",
    code: "LP-0001",
    title: "测试视频",
    notes: "",
    assets: {},
    publishMarks: { "original:platform-1": true },
    publishMarkTimes: { "original:platform-1": "2026-07-31T09:30:00.000Z" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  state.platforms[0] = {
    ...state.platforms[0],
    active: false,
    disabledAt: "2026-07-31T09:30:00.000Z",
    stopReasons: ["账号异常", "登录问题"],
    stopReasonNote: "等待账号恢复",
    accountName: "真实账号名字",
    accountId: "douyin-test-001",
    avatar: "data:image/jpeg;base64,dGVzdA==",
  };
  const writeResponse = await fetch(`http://127.0.0.1:${testPort}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  assert.equal(writeResponse.ok, true);
  const persisted = await (
    await fetch(`http://127.0.0.1:${testPort}/api/state`)
  ).json();
  assert.equal(persisted.groups[0].title, "测试视频");
  assert.equal(persisted.groups[0].publishMarks["original:platform-1"], true);
  assert.equal(
    persisted.groups[0].publishMarkTimes["original:platform-1"],
    "2026-07-31T09:30:00.000Z",
  );
  assert.equal(persisted.platforms[0].active, false);
  assert.equal(persisted.platforms[0].disabledAt, "2026-07-31T09:30:00.000Z");
  assert.deepEqual(persisted.platforms[0].stopReasons, [
    "账号异常",
    "登录问题",
  ]);
  assert.equal(persisted.platforms[0].stopReasonNote, "等待账号恢复");
  assert.equal(persisted.platforms[0].accountName, "真实账号名字");
  assert.equal(persisted.platforms[0].accountId, "douyin-test-001");
  assert.equal(
    persisted.platforms[0].avatar,
    "data:image/jpeg;base64,dGVzdA==",
  );

  persisted.groups[0].category = "facelift";
  persisted.groups[0].assets = {
    original_video: {
      id: "raw-only",
      slot: "original_video",
      path: path.join(appData, "raw-only.mov"),
      filename: "raw-only.mov",
    },
  };
  const pendingResponse = await fetch(
    `http://127.0.0.1:${testPort}/api/state`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(persisted),
    },
  );
  const pendingState = await pendingResponse.json();
  assert.equal(pendingState.groups[0].category, "facelift");
  assert.equal(pendingState.groups[0].contentCategory, "facelift");
  assert.equal(pendingState.groups[0].workflowStatus, "pending_edit");

  pendingState.groups[0].assets.edited_video = {
    id: "edited-ready",
    slot: "edited_video",
    path: path.join(appData, "edited-ready.mp4"),
    filename: "edited-ready.mp4",
  };
  const restoredResponse = await fetch(
    `http://127.0.0.1:${testPort}/api/state`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pendingState),
    },
  );
  const restoredState = await restoredResponse.json();
  assert.equal(restoredState.groups[0].category, "facelift");
  assert.equal(restoredState.groups[0].workflowStatus, "");
  restoredState.groups[0].assets = {};
  await fetch(`http://127.0.0.1:${testPort}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(restoredState),
  });

  const incrementalDirectory = await mkdtemp(
    path.join(os.tmpdir(), "video-manager-incremental-"),
  );
  const incrementalFile = path.join(
    incrementalDirectory,
    "beauty_1000000000001.MOV",
  );
  await writeFile(incrementalFile, Buffer.from("test video placeholder"));

  const firstIncrementalScan = await fetch(
    `http://127.0.0.1:${testPort}/api/scan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: [{ path: incrementalDirectory, category: "ageless" }],
      }),
    },
  );
  const firstIncrementalResult = await firstIncrementalScan.json();
  assert.equal(firstIncrementalResult.candidates.length, 1);
  assert.equal(firstIncrementalResult.fileCount, 1);
  assert.equal(firstIncrementalResult.candidates[0].category, "ageless");

  const importedIncremental = await fetch(
    `http://127.0.0.1:${testPort}/api/confirm-import`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(firstIncrementalResult.candidates[0]),
    },
  );
  assert.equal(importedIncremental.ok, true);
  const importedState = await importedIncremental.json();
  const importedGroup = importedState.groups.find(
    (group) => group.title === "beauty_1000000000001",
  );
  assert.ok(importedGroup);

  const secondIncrementalScan = await fetch(
    `http://127.0.0.1:${testPort}/api/scan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: [{ path: incrementalDirectory, category: "ageless" }],
      }),
    },
  );
  const secondIncrementalResult = await secondIncrementalScan.json();
  assert.equal(secondIncrementalResult.candidates.length, 0);
  assert.equal(secondIncrementalResult.fileCount, 0);
  assert.equal(secondIncrementalResult.scannedFileCount, 1);

  const fullScanResponse = await fetch(
    `http://127.0.0.1:${testPort}/api/scan`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "all",
        sources: [{ path: incrementalDirectory, category: "ageless" }],
      }),
    },
  );
  const fullScanResult = await fullScanResponse.json();
  assert.equal(fullScanResult.mode, "all");
  assert.equal(fullScanResult.candidates.length, 1);
  assert.equal(fullScanResult.fileCount, 1);
  assert.equal(fullScanResult.candidates[0].groupId, importedGroup.id);

  const updateExistingResponse = await fetch(
    `http://127.0.0.1:${testPort}/api/confirm-import`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fullScanResult.candidates[0]),
    },
  );
  assert.equal(updateExistingResponse.ok, true);
  const updatedExistingState = await updateExistingResponse.json();
  assert.equal(updatedExistingState.groups.length, importedState.groups.length);
  assert.equal(
    updatedExistingState.groups.filter((group) => group.id === importedGroup.id).length,
    1,
  );

  const organizedFolder = path.join(
    incrementalDirectory,
    "beauty_1000000000099",
  );
  await mkdir(organizedFolder);
  const organizedOriginal = path.join(
    organizedFolder,
    "beauty_2000000000001.MOV",
  );
  const organizedSecondPart = path.join(
    organizedFolder,
    "beauty_2000000000002.MOV",
  );
  const organizedPortrait = path.join(
    organizedFolder,
    "beauty_9999999999999竖封面.png",
  );
  await writeFile(organizedOriginal, Buffer.from("first recording"));
  await writeFile(organizedSecondPart, Buffer.from("second recording"));
  await writeFile(organizedPortrait, Buffer.from("portrait cover"));

  const organizedScan = await (
    await fetch(`http://127.0.0.1:${testPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: [{ path: incrementalDirectory, category: "ageless" }],
      }),
    })
  ).json();
  const organizedCandidate = organizedScan.candidates.find(
    (candidate) => candidate.suggestedTitle === "beauty_1000000000099",
  );
  assert.ok(organizedCandidate);
  assert.equal(organizedCandidate.folderAnchored, true);
  assert.ok(organizedCandidate.confidence >= 90);
  assert.equal(
    organizedCandidate.slots.original_video.filename,
    "beauty_2000000000001.MOV",
  );
  assert.equal(
    organizedCandidate.slots.original_video_part2.filename,
    "beauty_2000000000002.MOV",
  );
  assert.equal(
    organizedCandidate.slots.original_cover_portrait.filename,
    "beauty_9999999999999竖封面.png",
  );
  const organizedImport = await (
    await fetch(`http://127.0.0.1:${testPort}/api/confirm-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(organizedCandidate),
    })
  ).json();
  const organizedGroup = organizedImport.groups.find(
    (group) => group.title === "beauty_1000000000099",
  );
  assert.ok(organizedGroup);

  const organizedLandscape = path.join(
    organizedFolder,
    "封面文件名不一致横封面.png",
  );
  await writeFile(organizedLandscape, Buffer.from("landscape cover"));
  const coverUpdateScan = await (
    await fetch(`http://127.0.0.1:${testPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: [{ path: incrementalDirectory, category: "ageless" }],
      }),
    })
  ).json();
  const coverUpdateCandidate = coverUpdateScan.candidates.find(
    (candidate) => candidate.suggestedTitle === "beauty_1000000000099",
  );
  assert.equal(coverUpdateCandidate.groupId, organizedGroup.id);
  assert.equal(
    coverUpdateCandidate.slots.original_cover_landscape.filename,
    "封面文件名不一致横封面.png",
  );
  const coverUpdatedState = await (
    await fetch(`http://127.0.0.1:${testPort}/api/confirm-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(coverUpdateCandidate),
    })
  ).json();
  assert.equal(
    coverUpdatedState.groups.find((group) => group.id === organizedGroup.id)
      .assets.original_cover_landscape.filename,
    "封面文件名不一致横封面.png",
  );

  const thirdVideo = path.join(
    organizedFolder,
    "beauty_1000000000099三创字幕.mp4",
  );
  const thirdLandscape = path.join(
    organizedFolder,
    "beauty_1000000000099三创横封面.png",
  );
  const thirdPortrait = path.join(
    organizedFolder,
    "beauty_1000000000099三创竖封面.png",
  );
  await writeFile(thirdVideo, Buffer.from("third creative video"));
  await writeFile(thirdLandscape, Buffer.from("third landscape cover"));
  await writeFile(thirdPortrait, Buffer.from("third portrait cover"));
  const thirdScan = await (
    await fetch(`http://127.0.0.1:${testPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: [{ path: incrementalDirectory, category: "ageless" }],
      }),
    })
  ).json();
  const thirdCandidate = thirdScan.candidates.find(
    (candidate) => candidate.suggestedTitle === "beauty_1000000000099",
  );
  assert.equal(thirdCandidate.groupId, organizedGroup.id);
  assert.equal(thirdCandidate.slots.third_video.filename, path.basename(thirdVideo));
  assert.equal(
    thirdCandidate.slots.third_cover_landscape.filename,
    path.basename(thirdLandscape),
  );
  assert.equal(
    thirdCandidate.slots.third_cover_portrait.filename,
    path.basename(thirdPortrait),
  );
  const thirdUpdatedState = await (
    await fetch(`http://127.0.0.1:${testPort}/api/confirm-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(thirdCandidate),
    })
  ).json();
  const thirdUpdatedGroup = thirdUpdatedState.groups.find(
    (group) => group.id === organizedGroup.id,
  );
  assert.equal(thirdUpdatedGroup.assets.third_video.filename, path.basename(thirdVideo));
  assert.equal(
    thirdUpdatedGroup.assets.third_cover_landscape.filename,
    path.basename(thirdLandscape),
  );
  assert.equal(
    thirdUpdatedGroup.assets.third_cover_portrait.filename,
    path.basename(thirdPortrait),
  );

  const resetResponse = await fetch(
    `http://127.0.0.1:${testPort}/api/reset-materials`,
    { method: "POST" },
  );
  const resetState = await resetResponse.json();
  assert.equal(resetState.groups.length, 0);
  assert.equal(resetState.platforms.length, 8);
  assert.equal(
    resetState.sources.some((source) => source.path === incrementalDirectory),
    true,
  );
  assert.equal(
    resetState.sources.find((source) => source.path === incrementalDirectory)
      .category,
    "ageless",
  );
  await access(incrementalFile);

  const actualScanPath = process.env.VIDEO_MANAGER_ACTUAL_SCAN_PATH;
  if (actualScanPath) {
    const scanResponse = await fetch(`http://127.0.0.1:${testPort}/api/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: [actualScanPath] }),
    });
    assert.equal(scanResponse.ok, true);
    const scan = await scanResponse.json();
    assert.equal(scan.fileCount, 94);

    const split = scan.candidates.find(
      (candidate) => candidate.suggestedTitle === "beauty_1785240851596",
    );
    assert.ok(split);
    assert.equal(split.category, "facelift");
    assert.match(split.slots.original_video.filename, /\.MOV$/i);
    assert.match(split.slots.original_video_part2.filename, /后半段\.MOV$/i);
    assert.match(split.slots.edited_video.filename, /(字幕|文案)\.mp4$/i);
    assert.match(split.slots.remix_video.filename, /二创字幕\.mp4$/i);
    assert.match(split.slots.original_cover_landscape.filename, /横封面\.png$/i);
    assert.match(split.slots.original_cover_portrait.filename, /竖封面\.png$/i);

    const inferredSplit = scan.candidates.find(
      (candidate) => candidate.suggestedTitle === "beauty_1785239969657",
    );
    assert.ok(inferredSplit);
    assert.match(
      inferredSplit.slots.original_video_part2.filename,
      /后半段\.MOV$/i,
    );
  }
});
