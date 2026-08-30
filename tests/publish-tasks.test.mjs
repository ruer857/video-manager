import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

test("publish task copies into platform folders, records separately, and safely cleans up", async (t) => {
  const port = await getFreePort();
  const appData = await mkdtemp(path.join(os.tmpdir(), "video-manager-publish-db-"));
  const desktop = await mkdtemp(path.join(os.tmpdir(), "video-manager-publish-desktop-"));
  const source = await mkdtemp(path.join(os.tmpdir(), "video-manager-publish-source-"));
  const files = {
    edited_video: path.join(source, "beauty_100字幕.mp4"),
    original_cover_landscape: path.join(source, "beauty_100横封面.png"),
    original_cover_portrait: path.join(source, "beauty_100竖封面.png"),
  };
  for (const [slot, filePath] of Object.entries(files)) {
    await writeFile(filePath, Buffer.from(`test-${slot}`));
  }
  const child = spawn(process.execPath, ["desktop/server.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      APPDATA: appData,
      VIDEO_MANAGER_PORT: String(port),
      VIDEO_MANAGER_PUBLISH_ROOT: desktop,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await wait(100);
  }
  const state = await (await fetch(`${base}/api/state`)).json();
  const now = new Date().toISOString();
  state.groups = [{
    id: "publish-group",
    category: "facelift",
    code: "LP-0001",
    title: "发布测试",
    notes: "",
    assets: Object.fromEntries(Object.entries(files).map(([slot, filePath]) => [slot, {
      id: slot,
      slot,
      path: filePath,
      filename: path.basename(filePath),
      size: 20,
      modifiedAt: now,
      available: true,
    }])),
    publishMarks: {},
    publishMarkTimes: {},
    createdAt: now,
    updatedAt: now,
  }];
  await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  const createdResponse = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      items: [{ groupId: "publish-group", version: "original" }],
      platformIds: ["platform-3", "platform-4"],
    }),
  });
  assert.equal(createdResponse.status, 201);
  const { task } = await createdResponse.json();
  let current;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    current = await (await fetch(`${base}/api/state`)).json();
    if (current.publishTasks[0]?.status === "ready") break;
    await wait(50);
  }
  const readyTask = current.publishTasks[0];
  assert.equal(readyTask.status, "ready");
  assert.equal(readyTask.totalFiles, 6);
  const platform3Name = state.platforms.find((platform) => platform.id === "platform-3").name;
  assert.equal((await readdir(path.join(task.folderPath, platform3Name, "LP-0001_发布测试", "原版"))).length, 3);
  assert.equal(JSON.parse(await readFile(path.join(task.folderPath, ".video-manager-task.json"), "utf8")).taskId, task.id);
  for (const filePath of Object.values(files)) await access(filePath);

  const first = await (await fetch(`${base}/api/publish-tasks/${task.id}/complete-platform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformId: "platform-3" }),
  })).json();
  assert.equal(first.finished, false);
  assert.equal(first.state.groups[0].publishMarks["original:platform-3"], true);
  assert.equal(first.state.groups[0].publishMarks["original:platform-4"], undefined);
  assert.equal(first.state.publishHistory.length, 1);
  assert.equal(first.state.publishHistory[0].platformId, "platform-3");
  assert.equal(first.state.publishHistory[0].groupId, "publish-group");
  assert.equal(first.state.publishHistory[0].version, "original");
  assert.match(first.state.publishHistory[0].publishedAt, /^\d{4}-\d{2}-\d{2}T/);
  await access(task.folderPath);

  const skippedLast = await (await fetch(`${base}/api/publish-tasks/${task.id}/remove-platform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformId: "platform-4" }),
  })).json();
  assert.equal(skippedLast.groups[0].publishMarks["original:platform-4"], undefined);
  assert.equal(skippedLast.publishHistory.length, 1);
  assert.deepEqual(
    skippedLast.publishHistory.map((entry) => entry.platformId),
    ["platform-3"],
  );
  assert.equal(skippedLast.publishTasks.length, 0);
  await assert.rejects(access(task.folderPath));
  for (const filePath of Object.values(files)) await access(filePath);

  const remixFiles = {
    remix_video: path.join(source, "beauty_100二创.mp4"),
    remix_cover_landscape: path.join(source, "beauty_100二创横封面.png"),
    remix_cover_portrait: path.join(source, "beauty_100二创竖封面.png"),
  };
  for (const [slot, filePath] of Object.entries(remixFiles)) {
    await writeFile(filePath, Buffer.from(`test-${slot}`));
  }
  const pairState = await (await fetch(`${base}/api/state`)).json();
  Object.assign(
    pairState.groups[0].assets,
    Object.fromEntries(Object.entries(remixFiles).map(([slot, filePath]) => [slot, {
      id: slot,
      slot,
      path: filePath,
      filename: path.basename(filePath),
      size: 20,
      modifiedAt: now,
      available: true,
    }])),
  );
  await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pairState),
  });
  const pairResponse = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platformSelections: [
        { platformId: "platform-1", items: [{ groupId: "publish-group", version: "original" }] },
        { platformId: "platform-2", items: [{ groupId: "publish-group", version: "remix" }] },
      ],
      douyinAssignments: { "publish-group": "platform-1" },
    }),
  });
  assert.equal(pairResponse.status, 201);
  const pairTask = (await pairResponse.json()).task;
  let pairReady;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    pairReady = await (await fetch(`${base}/api/state`)).json();
    if (pairReady.publishTasks[0]?.status === "ready") break;
    await wait(50);
  }
  assert.equal(pairReady.publishTasks[0].status, "ready");
  const platform2Name = pairReady.platforms.find((platform) => platform.id === "platform-2").name;
  await access(path.join(pairTask.folderPath, platform2Name));
  const removedState = await (await fetch(`${base}/api/publish-tasks/${pairTask.id}/remove-platform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformId: "platform-2" }),
  })).json();
  assert.deepEqual(removedState.publishTasks[0].platformIds, ["platform-1"]);
  assert.equal(removedState.groups[0].publishMarks["remix:platform-2"], undefined);
  await assert.rejects(access(path.join(pairTask.folderPath, platform2Name)));
  const pairComplete = await (await fetch(`${base}/api/publish-tasks/${pairTask.id}/complete-platform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformId: "platform-1" }),
  })).json();
  assert.equal(pairComplete.state.groups[0].publishMarks["original:platform-1"], true);
  assert.equal(pairComplete.state.groups[0].douyinOriginalPlatformId, "platform-1");
  assert.ok(pairComplete.state.groups[0].douyinAssignmentLockedAt);

  const thirdFiles = {
    third_video: path.join(source, "beauty_100三创.mp4"),
    third_cover_landscape: path.join(source, "beauty_100三创横封面.png"),
    third_cover_portrait: path.join(source, "beauty_100三创竖封面.png"),
  };
  for (const [slot, filePath] of Object.entries(thirdFiles)) {
    await writeFile(filePath, Buffer.from(`test-${slot}`));
  }
  const thirdState = await (await fetch(`${base}/api/state`)).json();
  Object.assign(
    thirdState.groups[0].assets,
    Object.fromEntries(Object.entries(thirdFiles).map(([slot, filePath]) => [slot, {
      id: slot,
      slot,
      path: filePath,
      filename: path.basename(filePath),
      size: 20,
      modifiedAt: now,
      available: true,
    }]))
  );
  await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(thirdState),
  });
  const thirdResponse = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platformSelections: [
        { platformId: "platform-4", items: [{ groupId: "publish-group", version: "third" }] },
      ],
    }),
  });
  assert.equal(thirdResponse.status, 201);
  const thirdTask = (await thirdResponse.json()).task;
  let thirdReady;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    thirdReady = await (await fetch(`${base}/api/state`)).json();
    if (thirdReady.publishTasks[0]?.status === "ready") break;
    await wait(50);
  }
  const platform4Name = thirdReady.platforms.find((platform) => platform.id === "platform-4").name;
  assert.equal(
    (await readdir(path.join(thirdTask.folderPath, platform4Name, "LP-0001_发布测试", "三创"))).length,
    3,
  );
  const thirdComplete = await (await fetch(`${base}/api/publish-tasks/${thirdTask.id}/complete-platform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformId: "platform-4" }),
  })).json();
  assert.equal(thirdComplete.state.groups[0].publishMarks["third:platform-4"], true);

  const reverseAssignment = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platformSelections: [
        { platformId: "platform-2", items: [{ groupId: "publish-group", version: "original" }] },
      ],
      douyinAssignments: { "publish-group": "platform-2" },
      allowRepeat: true,
    }),
  });
  assert.equal(reverseAssignment.ok, false);
  assert.match((await reverseAssignment.json()).error, /已经锁定/);

  const legacyState = await (await fetch(`${base}/api/state`)).json();
  legacyState.groups.push({
    ...legacyState.groups[0],
    id: "legacy-douyin-group",
    code: "LP-0099",
    title: "旧发布记录推断归属",
    publishMarks: { "remix:platform-2": true },
    publishMarkTimes: {},
    douyinOriginalPlatformId: "",
    douyinAssignmentLockedAt: "",
  });
  await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(legacyState),
  });
  const inferredAssignmentResponse = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platformSelections: [{
        platformId: "platform-1",
        items: [{ groupId: "legacy-douyin-group", version: "original" }],
      }],
    }),
  });
  assert.equal(inferredAssignmentResponse.status, 201);
  const inferredTask = (await inferredAssignmentResponse.json()).task;
  let inferredReady;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    inferredReady = await (await fetch(`${base}/api/state`)).json();
    if (inferredReady.publishTasks[0]?.status === "ready") break;
    await wait(50);
  }
  assert.equal(
    inferredReady.groups.find((group) => group.id === "legacy-douyin-group")
      .douyinOriginalPlatformId,
    "platform-1",
  );
  await fetch(`${base}/api/publish-tasks/${inferredTask.id}/complete-platform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platformId: "platform-1" }),
  });

  const categoryState = await (await fetch(`${base}/api/state`)).json();
  categoryState.platforms.find((platform) => platform.id === "platform-8").name =
    "老而不衰快手";
  categoryState.groups.push({
    ...categoryState.groups[0],
    id: "ageless-publish-group",
    category: "ageless",
    code: "LS-0001",
    title: "老而不衰发布测试",
    assets: {
      edited_video: categoryState.groups[0].assets.edited_video,
      original_cover_portrait: categoryState.groups[0].assets.original_cover_portrait,
    },
    publishMarks: {},
    publishMarkTimes: {},
    douyinOriginalPlatformId: "",
    douyinAssignmentLockedAt: "",
  });
  await fetch(`${base}/api/state`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(categoryState),
  });

  const invalidCategoryResponse = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platformSelections: [{
        platformId: "platform-3",
        items: [{ groupId: "ageless-publish-group", version: "original" }],
      }],
    }),
  });
  assert.equal(invalidCategoryResponse.ok, false);
  assert.match((await invalidCategoryResponse.json()).error, /名称带“老而不衰”/);

  const validCategoryResponse = await fetch(`${base}/api/publish-tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platformSelections: [{
        platformId: "platform-8",
        items: [{ groupId: "ageless-publish-group", version: "original" }],
      }],
    }),
  });
  assert.equal(validCategoryResponse.status, 201);
});
