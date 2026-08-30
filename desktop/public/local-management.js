SLOT_LABELS.third_video = "三创视频";
SLOT_LABELS.third_cover_landscape = "三创横封面";
SLOT_LABELS.third_cover_portrait = "三创竖封面";

const PUBLISH_VERSION_META = {
  original: {
    label: "原版",
    matrixLabel: "原视频",
    missingVideoText: "缺少原版字幕成片",
    unavailableText: "原版字幕成片文件不可用",
    videoSlot: "edited_video",
    slots: ["edited_video", "original_cover_landscape", "original_cover_portrait"],
  },
  remix: {
    label: "二创",
    matrixLabel: "二创视频",
    missingVideoText: "缺少二创视频",
    unavailableText: "二创视频文件不可用",
    videoSlot: "remix_video",
    slots: ["remix_video", "remix_cover_landscape", "remix_cover_portrait"],
  },
  third: {
    label: "三创",
    matrixLabel: "三创视频",
    missingVideoText: "缺少三创视频",
    unavailableText: "三创视频文件不可用",
    videoSlot: "third_video",
    slots: ["third_video", "third_cover_landscape", "third_cover_portrait"],
  },
};
const PUBLISH_VERSION_IDS = Object.keys(PUBLISH_VERSION_META);
function publishVersionLabel(version) {
  return PUBLISH_VERSION_META[version]?.label || version;
}
function publishVersionMatrixLabel(version) {
  return PUBLISH_VERSION_META[version]?.matrixLabel || publishVersionLabel(version);
}

const REQUIRED_MATERIAL_SLOTS_BY_CATEGORY = {
  facelift: [
    "original_video",
    "edited_video",
    "original_cover_landscape",
    "original_cover_portrait",
    "remix_video",
    "remix_cover_landscape",
    "remix_cover_portrait",
  ],
  ageless: [
    "original_video",
    "edited_video",
    "original_cover_portrait",
  ],
};

function availableMaterialCount(group) {
  return Object.values(group?.assets || {}).filter((asset) => libraryAssetAvailable(asset)).length;
}

function hasOfflineSources() {
  return Boolean(state?.hasOfflineSources || state?.offlineSourcePaths?.length);
}

function normalizeLibraryPath(value) {
  return String(value || "").replace(/\//g, "\\").toLowerCase();
}

function assetBelongsToOfflineSource(asset) {
  const assetPath = normalizeLibraryPath(asset?.path);
  if (!assetPath) return false;
  return (state?.offlineSourcePaths || []).some((sourcePath) => {
    const source = normalizeLibraryPath(sourcePath).replace(/\\+$/, "");
    return assetPath === source || assetPath.startsWith(`${source}\\`);
  });
}

function libraryAssetAvailable(asset) {
  return Boolean(asset?.available || assetBelongsToOfflineSource(asset));
}

function requiredMaterialSlotsForGroup(group) {
  return REQUIRED_MATERIAL_SLOTS_BY_CATEGORY[group?.category] ||
    REQUIRED_MATERIAL_SLOTS_BY_CATEGORY.facelift;
}

function requiredMaterialCount(group) {
  return requiredMaterialSlotsForGroup(group)
    .filter((slot) => libraryAssetAvailable(group?.assets?.[slot]))
    .length;
}

function groupRequiredMaterialsComplete(group) {
  return requiredMaterialSlotsForGroup(group)
    .every((slot) => libraryAssetAvailable(group?.assets?.[slot]));
}

function materialBarWidth(group) {
  const slots = requiredMaterialSlotsForGroup(group);
  if (!slots.length) return availableMaterialCount(group) ? 100 : 0;
  return Math.min(100, requiredMaterialCount(group) / slots.length * 100);
}

let lastScanMode = "new";

async function scanVideos(mode = "new") {
  if (!state.sources.length) {
    showView("settings");
    toast("请先在“目录与设置”中选择素材目录");
    return;
  }

  const buttons = [
    document.querySelector("#scan-button"),
    document.querySelector("#scan-all-button"),
    document.querySelector("#scan-again"),
  ].filter(Boolean);
  const labels = buttons.map((button) => button.textContent);
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = mode === "all" ? "正在扫描全部…" : "正在扫描新增…";
  });

  try {
    lastScanMode = mode;
    const result = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({
        mode,
        sources: state.sources.map((source) => ({
          path: source.path,
          category: source.category || inferDirectoryCategory(source.path),
        })),
      }),
    });
    const scannedCandidates = Array.isArray(result.candidates)
      ? result.candidates
      : [];
    let autoImported = 0;
    let autoFailed = 0;

    if (mode === "all") {
      const autoCandidates = scannedCandidates.filter(
        (candidate) => Number(candidate.confidence) >= 90,
      );
      const pendingCandidates = [];
      let autoProgress = 0;

      for (const candidate of scannedCandidates) {
        if (Number(candidate.confidence) < 90) {
          pendingCandidates.push(candidate);
          continue;
        }

        autoProgress += 1;
        buttons.forEach((button) => {
          button.textContent = `正在自动归组 ${autoProgress}/${autoCandidates.length}…`;
        });
        try {
          state = await api("/api/confirm-import", {
            method: "POST",
            body: JSON.stringify({
              ...candidate,
              slots: candidate.slots ?? {},
              title: candidate.title || candidate.suggestedTitle,
              category: candidate.category,
            }),
          });
          autoImported += 1;
        } catch (error) {
          autoFailed += 1;
          pendingCandidates.push({
            ...candidate,
            autoImportError: error.message || "自动归组失败",
          });
        }
      }
      candidates = pendingCandidates;
    } else {
      candidates = scannedCandidates;
    }

    render();
    document.querySelector("#inbox-count").textContent = candidates.length;
    renderCandidates();

    if (candidates.length) {
      showView("inbox");
      toast(
        mode === "all"
          ? autoFailed
            ? `扫描完成：已自动归组 ${autoImported} 组，${autoFailed} 组失败并保留，${candidates.length - autoFailed} 组待人工确认`
            : `扫描完成：已自动归组 ${autoImported} 组，${candidates.length} 组待人工确认`
          : `发现 ${candidates.length} 组新增视频，请确认归组`,
      );
    } else {
      if (mode === "all" && autoImported) {
        showView("library");
        toast(`扫描完成：可信度 90% 以上的 ${autoImported} 组已全部自动归组`);
      } else {
        toast(mode === "all" ? "扫描完成，没有找到视频" : "扫描完成，没有发现新增视频");
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    buttons.forEach((button, index) => {
      button.disabled = false;
      button.textContent = labels[index];
    });
  }
}

function scanNewVideos() {
  return scanVideos("new");
}

function scanAllVideos() {
  return scanVideos("all");
}

function inferDirectoryCategory(directoryPath) {
  return String(directoryPath).includes("老而不衰") ? "ageless" : "facelift";
}

function chooseDirectoryCategory(directoryPath) {
  return new Promise((resolve) => {
    const layer = document.querySelector("#modal-layer");
    layer.innerHTML = `
      <div class="modal-bg">
        <div class="modal source-category-modal">
          <button type="button" class="close">×</button>
          <h2>这个目录属于哪类内容？</h2>
          <p class="source-category-path">${esc(directoryPath)}</p>
          <div class="source-category-choices">
            <button type="button" data-source-category="facelift">
              <strong>拉皮视频</strong>
              <span>该目录下的新增视频归入拉皮分类</span>
            </button>
            <button type="button" data-source-category="ageless">
              <strong>老而不衰视频</strong>
              <span>该目录下的新增视频归入老而不衰分类</span>
            </button>
          </div>
          <button type="button" class="ghost cancel-source-category">取消</button>
        </div>
      </div>`;
    const finish = (category) => {
      layer.innerHTML = "";
      resolve(category);
    };
    layer.querySelector(".close").onclick = () => finish(null);
    layer.querySelector(".cancel-source-category").onclick = () => finish(null);
    layer.querySelectorAll("[data-source-category]").forEach((button) => {
      button.onclick = () => finish(button.dataset.sourceCategory);
    });
  });
}

pickSource = async function pickCategorizedSource() {
  const selected = await api("/api/pick-directory", { method: "POST" });
  if (!selected.path) return null;
  const existing = state.sources.find(
    (source) => source.path.toLowerCase() === selected.path.toLowerCase(),
  );
  if (existing) {
    toast("这个素材目录已经添加");
    return existing.path;
  }
  const category = await chooseDirectoryCategory(selected.path);
  if (!category) return null;
  state.sources.push({
    id: crypto.randomUUID(),
    path: selected.path,
    category,
  });
  await save();
  return selected.path;
};

function enhanceSourceCategories() {
  document.querySelectorAll("#source-list .source").forEach((row, index) => {
    const source = state.sources[index];
    if (!source || row.querySelector(".source-category-select")) return;
    const select = document.createElement("select");
    select.className = "source-category-select";
    select.setAttribute("aria-label", `${source.path}的内容分类`);
    select.innerHTML = `
      <option value="facelift">拉皮视频</option>
      <option value="ageless">老而不衰视频</option>`;
    select.value = source.category || inferDirectoryCategory(source.path);
    select.onchange = () => {
      source.category = select.value;
      save();
    };
    row.insertBefore(select, row.querySelector(".remove-source"));
  });
}

const PLATFORM_STOP_REASONS = [
  "账号异常",
  "违规处罚",
  "限流或流量异常",
  "登录问题",
  "暂停运营",
  "人员调整",
  "其他原因",
];

function formatPlatformStoppedAt(value) {
  if (!value) return "历史停用时间未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "历史停用时间未记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function enhancePlatformStatusControls() {
  document.querySelectorAll("#platform-list .platform").forEach((row, index) => {
    const platform = state.platforms[index];
    if (!platform || row.querySelector(".platform-status-select")) return;

    row.classList.add("platform-account");
    row.classList.toggle("is-disabled", !platform.active);

    const oldToggle = row.querySelector("[data-toggle]");
    const statusSelect = document.createElement("select");
    statusSelect.className = "platform-status-select";
    statusSelect.setAttribute("aria-label", `${platform.name}的账号状态`);
    statusSelect.innerHTML = `
      <option value="active">使用中</option>
      <option value="disabled">已停用</option>`;
    statusSelect.value = platform.active ? "active" : "disabled";
    statusSelect.onchange = () => {
      if (statusSelect.value === "disabled") {
        if (platform.active) platform.disabledAt = new Date().toISOString();
        platform.active = false;
        if (!Array.isArray(platform.stopReasons)) platform.stopReasons = [];
      } else {
        platform.active = true;
      }
      save();
    };
    oldToggle.replaceWith(statusSelect);

    if (platform.active) return;

    const details = document.createElement("div");
    details.className = "platform-stop-details";
    details.innerHTML = `
      <div class="platform-stop-time">
        <strong>停用时间</strong>
        <span>${esc(formatPlatformStoppedAt(platform.disabledAt))}</span>
      </div>
      <fieldset>
        <legend>为何停发（可多选）</legend>
        <div class="platform-stop-reasons">
          ${PLATFORM_STOP_REASONS.map(
            (reason) => `
              <label>
                <input type="checkbox" value="${esc(reason)}"
                  ${platform.stopReasons?.includes(reason) ? "checked" : ""}>
                <span>${esc(reason)}</span>
              </label>`,
          ).join("")}
        </div>
      </fieldset>
      <label class="platform-stop-note">
        补充说明（可选）
        <input type="text" value="${esc(platform.stopReasonNote || "")}"
          placeholder="可以自行填写具体停发原因">
      </label>`;

    details.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.onchange = () => {
        platform.stopReasons = [
          ...details.querySelectorAll('input[type="checkbox"]:checked'),
        ].map((item) => item.value);
        save();
      };
    });
    details.querySelector(".platform-stop-note input").onchange = (event) => {
      platform.stopReasonNote = event.target.value.trim();
      save();
    };
    row.append(details);
  });
}

let selectedPlatformPreviewId = null;
let selectedPlatformPublishListMode = "all";
let selectedPlatformHistoryDate = localDayKey(new Date());

const PLATFORM_BRANDS = {
  "platform-1": { key: "douyin", name: "抖音", logo: "/platform-logos/douyin.png" },
  "platform-2": { key: "douyin", name: "抖音", logo: "/platform-logos/douyin.png" },
  "platform-3": { key: "wechat", name: "视频号", logo: "/platform-logos/wechat.png" },
  "platform-4": { key: "sohu", name: "搜狐", logo: "/platform-logos/sohu.png" },
  "platform-5": { key: "xiaohongshu", name: "小红书", logo: "/platform-logos/xiaohongshu.png" },
  "platform-6": { key: "baidu", name: "百家号", logo: "/platform-logos/baidu.png" },
  "platform-7": { key: "bilibili", name: "哔哩哔哩", logo: "/platform-logos/bilibili.png" },
  "platform-8": { key: "weibo", name: "微博", logo: "/platform-logos/weibo.png" },
  kuaishou: { key: "kuaishou", name: "快手", logo: "/platform-logos/kuaishou.png" },
};

const PLATFORM_BRAND_MATCHERS = [
  [/抖音|douyin|tiktok/i, PLATFORM_BRANDS["platform-1"]],
  [/视频号|微信|wechat/i, PLATFORM_BRANDS["platform-3"]],
  [/搜狐|sohu/i, PLATFORM_BRANDS["platform-4"]],
  [/小红书|xiaohongshu|red/i, PLATFORM_BRANDS["platform-5"]],
  [/百家号|百度|baidu/i, PLATFORM_BRANDS["platform-6"]],
  [/哔哩哔哩|bilibili|b站/i, PLATFORM_BRANDS["platform-7"]],
  [/微博|weibo/i, PLATFORM_BRANDS["platform-8"]],
  [/快手|kuaishou|kwai/i, PLATFORM_BRANDS.kuaishou],
];

function platformBrand(platform) {
  if (PLATFORM_BRANDS[platform.id]) return PLATFORM_BRANDS[platform.id];
  const searchable = `${platform.name || ""} ${platform.accountName || ""}`;
  return PLATFORM_BRAND_MATCHERS.find(([matcher]) => matcher.test(searchable))?.[1];
}

function platformOfficialLogoMarkup(platform) {
  const brand = platformBrand(platform);
  if (!brand) {
    return `<span class="platform-logo generic">${esc((platform.name || "平").slice(0, 1))}</span>`;
  }
  return `<span class="platform-logo ${brand.key}"><img src="${brand.logo}" alt="${brand.name}官方Logo"></span>`;
}

function platformAvatarMarkup(platform, className = "") {
  if (platform.avatar) {
    return `<span class="platform-avatar ${className}"><img src="${esc(platform.avatar)}" alt="${esc(platform.name)}头像"></span>`;
  }
  return `<span class="platform-avatar ${className}">${esc((platform.accountName || platform.name || "账").slice(0, 1))}</span>`;
}

function platformPublishedEntries(platform) {
  const history = (state.publishHistory || [])
    .filter((entry) => entry.platformId === platform.id)
    .map((entry) => ({
      ...entry,
      group: state.groups.find((group) => group.id === entry.groupId),
    }))
    .filter((entry) => entry.group)
    .sort((left, right) => Date.parse(right.publishedAt || "") - Date.parse(left.publishedAt || ""));
  const historyKeys = new Set(history.map((entry) => `${entry.groupId}:${entry.version}`));
  const legacy = state.groups.flatMap((group) =>
    PUBLISH_VERSION_IDS
      .filter((version) => group.publishMarks?.[markKey(version, platform.id)] && !historyKeys.has(`${group.id}:${version}`))
      .map((version) => {
        const key = markKey(version, platform.id);
        return {
          id: `legacy:${group.id}:${version}:${platform.id}`,
          group,
          version,
          publishedAt: group.publishMarkTimes?.[key] || "",
          source: "legacy",
        };
      }),
  );
  return [...history, ...legacy];
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function resizePlatformAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("头像文件无法读取"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("请选择有效的图片文件"));
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - sourceSize) / 2;
        const sourceY = (image.naturalHeight - sourceSize) / 2;
        context.drawImage(
          image,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          size,
          size,
        );
        resolve(canvas.toDataURL("image/jpeg", 0.84));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderPlatformPreview() {
  const container = document.querySelector("#platform-preview");
  if (!container) return;
  document.querySelector("#platform-count").textContent = state.platforms.length;

  if (!state.platforms.length) {
    container.innerHTML =
      '<div class="panel empty"><b>还没有发布账号</b>请先在“目录与设置”中添加账号。</div>';
    return;
  }

  if (!state.platforms.some((platform) => platform.id === selectedPlatformPreviewId)) {
    selectedPlatformPreviewId = state.platforms[0].id;
  }
  const selected = state.platforms.find(
    (platform) => platform.id === selectedPlatformPreviewId,
  );
  const selectedEntries = platformPublishedEntries(selected);
  const originalCount = selectedEntries.filter(
    (entry) => entry.version === "original",
  ).length;
  const remixCount = selectedEntries.filter(
    (entry) => entry.version === "remix",
  ).length;
  const thirdCount = selectedEntries.filter(
    (entry) => entry.version === "third",
  ).length;
  const todayKey = localDayKey(new Date());
  const todayPublishedCount = selectedEntries.filter(
    (entry) => entry.publishedAt && localDayKey(entry.publishedAt) === todayKey,
  ).length;
  const visiblePublishedEntries = selectedPlatformPublishListMode === "date"
    ? selectedEntries.filter(
        (entry) => entry.publishedAt && localDayKey(entry.publishedAt) === selectedPlatformHistoryDate,
      )
    : selectedEntries;
  const totalPossible = state.groups.reduce(
    (sum, group) =>
      sum + PUBLISH_VERSION_IDS.filter((version) => publishVersionAssets(group, version).hasVideo).length,
    0,
  );
  const uniquePublishedCount = new Set(selectedEntries.map((entry) => `${entry.group.id}:${entry.version}`)).size;
  const completion = totalPossible
    ? Math.round((uniquePublishedCount / totalPossible) * 100)
    : 0;

  container.innerHTML = `
    <div class="platform-preview-layout">
      <aside class="panel platform-preview-list">
        <div class="platform-preview-list-head">
          <h2>发布账号</h2>
          <span>${state.platforms.length} 个账号</span>
        </div>
        <div class="platform-preview-accounts">
          ${state.platforms
            .map((platform) => {
              const entries = platformPublishedEntries(platform);
              return `
                <button class="platform-preview-account ${platform.id === selected.id ? "active" : ""}"
                  data-preview-platform="${platform.id}">
                  ${platformOfficialLogoMarkup(platform)}
                  <span>
                    <strong>${esc(platform.name)}</strong>
                    <small>${esc(
                      [platform.accountName, platform.accountId]
                        .filter(Boolean)
                        .join(" · ") || "尚未填写账号名字和ID",
                    )}</small>
                  </span>
                  <i class="${platform.active ? "" : "disabled"}">
                    ${platform.active ? `${entries.length} 条` : "已停用"}
                  </i>
                </button>`;
            })
            .join("")}
        </div>
      </aside>

      <section class="panel platform-preview-detail">
        <div class="platform-profile">
          <div class="platform-avatar-editor">
            ${platformAvatarMarkup(selected, "large")}
            <label class="ghost">
              更换头像
              <input type="file" accept="image/*" data-platform-avatar hidden>
            </label>
            ${selected.avatar ? '<button class="platform-avatar-remove">移除头像</button>' : ""}
          </div>
          <div class="platform-profile-fields">
            <label>
              内部代称
              <input id="platform-profile-name" value="${esc(selected.name)}">
            </label>
            <label>
              账号名字
              <input id="platform-profile-account-name"
                value="${esc(selected.accountName || "")}"
                placeholder="填写平台上显示的账号名字">
            </label>
            <label>
              账号ID
              <input id="platform-profile-id" value="${esc(selected.accountId || "")}"
                placeholder="填写平台上的账号ID">
            </label>
          </div>
          <div class="platform-profile-status ${selected.active ? "" : "disabled"}">
            <span>${selected.active ? "使用中" : "已停用"}</span>
            ${
              selected.active
                ? "<small>可继续记录发布状态</small>"
                : `<small>${esc(formatPlatformStoppedAt(selected.disabledAt))}</small>`
            }
          </div>
        </div>

        ${
          !selected.active
            ? `<div class="platform-disabled-summary">
                <strong>停发原因</strong>
                <span>${esc(
                  [
                    ...(selected.stopReasons || []),
                    selected.stopReasonNote || "",
                  ]
                    .filter(Boolean)
                    .join("、") || "尚未填写",
                )}</span>
              </div>`
            : ""
        }

        <div class="platform-publish-stats">
          <button type="button" class="platform-publish-filter ${selectedPlatformPublishListMode === "all" ? "active" : ""}"
            data-published-list-mode="all" aria-pressed="${selectedPlatformPublishListMode === "all"}">
            <span>累计已发布</span><b>${selectedEntries.length}</b><small>点击查看全部列表</small>
          </button>
          <button type="button" class="platform-publish-filter today-published ${selectedPlatformPublishListMode === "date" && selectedPlatformHistoryDate === todayKey ? "active" : ""}"
            data-published-list-mode="today" aria-pressed="${selectedPlatformPublishListMode === "date" && selectedPlatformHistoryDate === todayKey}">
            <span>今日累计已发布</span><b>${todayPublishedCount}</b><small>${todayKey} · 点击查看</small>
          </button>
          <article><span>原版视频</span><b>${originalCount}</b><small>已勾选发布</small></article>
          <article><span>二创视频</span><b>${remixCount}</b><small>已勾选发布</small></article>
          <article><span>三创视频</span><b>${thirdCount}</b><small>已勾选发布</small></article>
          <article><span>发布完成度</span><b>${completion}%</b><small>${uniquePublishedCount}/${totalPossible} 个版本</small></article>
        </div>

        <div class="platform-published-list">
          <div class="platform-published-list-head">
            <div><h2>${selectedPlatformPublishListMode === "date" ? `${selectedPlatformHistoryDate} 发布记录` : "全部发布历史"}</h2><p>每次确认发布都会保留平台、视频版本和准确时间。</p></div>
            <div class="platform-history-date"><label>按日期查看 <input type="date" id="platform-history-date" value="${selectedPlatformHistoryDate}" max="${todayKey}"></label><button type="button" class="ghost" data-history-all>全部历史</button><span>${visiblePublishedEntries.length} 条记录</span></div>
          </div>
          ${
            visiblePublishedEntries.length
              ? visiblePublishedEntries
                  .map(
                    ({ group, version, publishedAt }) => `
                      <div class="platform-published-row">
                        <span class="tag ${group.category}">
                          ${group.category === "facelift" ? "拉皮视频" : "老而不衰"}
                        </span>
                        <div>
                          <strong>${esc(group.title)}</strong>
                          <small>${esc(group.code)}</small>
                        </div>
                        <time>${publishedAt ? formatPlatformStoppedAt(publishedAt) : "历史时间未记录"}</time>
                        <b>${publishVersionLabel(version)}</b>
                      </div>`,
                  )
                  .join("")
              : `<div class="platform-published-empty">${
                  selectedPlatformPublishListMode === "date"
                    ? `这个账号在 ${selectedPlatformHistoryDate} 没有发布记录。`
                    : "这个账号还没有勾选任何已发布视频。"
                }</div>`
          }
        </div>
      </section>
    </div>`;

  container.querySelectorAll("[data-preview-platform]").forEach((button) => {
    button.onclick = () => {
      selectedPlatformPreviewId = button.dataset.previewPlatform;
      selectedPlatformPublishListMode = "all";
      renderPlatformPreview();
    };
  });
  container.querySelectorAll("[data-published-list-mode]").forEach((button) => {
    button.onclick = () => {
      selectedPlatformPublishListMode = button.dataset.publishedListMode === "today" ? "date" : "all";
      if (button.dataset.publishedListMode === "today") selectedPlatformHistoryDate = todayKey;
      renderPlatformPreview();
      container.querySelector(".platform-published-list")?.scrollIntoView({
        block: "nearest",
      });
    };
  });
  container.querySelector("#platform-history-date").onchange = (event) => {
    selectedPlatformHistoryDate = event.target.value || todayKey;
    selectedPlatformPublishListMode = "date";
    renderPlatformPreview();
  };
  container.querySelector("[data-history-all]").onclick = () => {
    selectedPlatformPublishListMode = "all";
    renderPlatformPreview();
  };
  container.querySelector("#platform-profile-name").onchange = (event) => {
    selected.name = event.target.value.trim() || selected.name;
    save();
  };
  container.querySelector("#platform-profile-account-name").onchange = (event) => {
    selected.accountName = event.target.value.trim();
    save();
  };
  container.querySelector("#platform-profile-id").onchange = (event) => {
    selected.accountId = event.target.value.trim();
    save();
  };
  container.querySelector("[data-platform-avatar]").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      selected.avatar = await resizePlatformAvatar(file);
      await save();
      toast("账号头像已保存");
    } catch (error) {
      toast(error.message);
    }
  };
  const removeAvatar = container.querySelector(".platform-avatar-remove");
  if (removeAvatar) {
    removeAvatar.onclick = () => {
      selected.avatar = "";
      save();
    };
  }
}

let activeSettingsTab = "sources";

function enhanceSettingsTabs() {
  const settingsView = document.querySelector("#settings-view");
  if (!settingsView) return;
  const tabs = [...settingsView.querySelectorAll("[data-settings-tab]")];
  const panels = [...settingsView.querySelectorAll("[data-settings-panel]")];
  if (!tabs.length || !panels.length) return;
  const validTabs = new Set(tabs.map((tab) => tab.dataset.settingsTab));
  if (!validTabs.has(activeSettingsTab)) activeSettingsTab = tabs[0].dataset.settingsTab;
  tabs.forEach((tab) => {
    const selected = tab.dataset.settingsTab === activeSettingsTab;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.onclick = () => {
      activeSettingsTab = tab.dataset.settingsTab;
      enhanceSettingsTabs();
    };
  });
  panels.forEach((panel) => {
    const selected = panel.dataset.settingsPanel === activeSettingsTab;
    panel.classList.toggle("active", selected);
    panel.classList.toggle("hidden", !selected);
  });
}

const renderSettingsWithoutSourceCategories = renderSettings;
renderSettings = function renderSettingsWithSourceCategories() {
  renderSettingsWithoutSourceCategories();
  enhanceSourceCategories();
  enhancePlatformStatusControls();
  enhanceSettingsTabs();
  renderPlatformPreview();
};

enhanceSourceCategories();
enhancePlatformStatusControls();
enhanceSettingsTabs();
renderPlatformPreview();

const renderCandidatesWithoutExistingMarkers = renderCandidates;
renderCandidates = function renderCandidatesWithExistingMarkers() {
  renderCandidatesWithoutExistingMarkers();
  candidates.forEach((candidate, index) => {
    if (!candidate.groupId) return;
    const article = document.querySelector(`.candidate[data-index="${index}"]`);
    if (!article) return;
    article.classList.add("existing-candidate");
    const title = article.querySelector(".candidate-top h3");
    title?.insertAdjacentHTML(
      "beforeend",
      '<span class="existing-candidate-badge">已有记录</span>',
    );
    const confirmButton = article.querySelector(".confirm-candidate");
    if (confirmButton) confirmButton.textContent = "更新记录";
  });
};

function timestampFromBeautyFilename(filename) {
  const match = String(filename || "").match(/beauty_(\d{13})/i);
  const timestamp = match ? Number(match[1]) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function groupMaterialTimestamp(group) {
  const assets = Object.values(group.assets || {}).filter(Boolean);
  const original = group.assets?.original_video;
  const filenameTimestamp = timestampFromBeautyFilename(original?.filename)
    || Math.max(0, ...assets.map((asset) => timestampFromBeautyFilename(asset.filename)));
  if (filenameTimestamp) return filenameTimestamp;
  const originalModified = Date.parse(original?.modifiedAt || "");
  if (Number.isFinite(originalModified)) return originalModified;
  const assetModified = Math.max(
    0,
    ...assets.map((asset) => Date.parse(asset.modifiedAt || "") || 0),
  );
  return assetModified || Date.parse(group.createdAt || "") || 0;
}

function compareGroupCodes(left, right) {
  return String(left.code || "").localeCompare(String(right.code || ""), "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

const renderListWithoutSorting = renderList;
renderList = function renderListWithSorting() {
  const sortMode = document.querySelector("#sort-filter")?.value || "material-desc";
  const originalGroups = state.groups;
  state.groups = [...state.groups].sort((left, right) => {
    if (sortMode === "material-asc") {
      return groupMaterialTimestamp(left) - groupMaterialTimestamp(right);
    }
    if (sortMode === "updated-desc") {
      return (Date.parse(right.updatedAt || "") || 0) - (Date.parse(left.updatedAt || "") || 0);
    }
    if (sortMode === "code-desc") return compareGroupCodes(right, left);
    if (sortMode === "code-asc") return compareGroupCodes(left, right);
    if (sortMode === "title-asc") {
      return String(left.title || "").localeCompare(String(right.title || ""), "zh-CN", {
        numeric: true,
        sensitivity: "base",
      });
    }
    return groupMaterialTimestamp(right) - groupMaterialTimestamp(left);
  });
  try {
    renderListWithoutSorting();
  } finally {
    state.groups = originalGroups;
  }
};

const sortFilter = document.querySelector("#sort-filter");
const savedSortMode = localStorage.getItem("video-manager-sort-mode");
if (savedSortMode && [...sortFilter.options].some((option) => option.value === savedSortMode)) {
  sortFilter.value = savedSortMode;
}
sortFilter.onchange = () => preserveScrollAround(() => {
  localStorage.setItem("video-manager-sort-mode", sortFilter.value);
  renderList();
}, sortFilter);

const openDrawerWithoutPublishTimes = openDrawer;
openDrawer = function openDrawerWithPublishTimes(id, rerender = false) {
  openDrawerWithoutPublishTimes(id, rerender);
  const group = state.groups.find((item) => item.id === id);
  if (!group) return;
  document.querySelectorAll("[data-mark]").forEach((button) => {
    button.onclick = () => {
      const scrollState = captureScrollState();
      const [version, platformId] = button.dataset.mark.split("|");
      const key = markKey(version, platformId);
      const nextValue = !group.publishMarks?.[key];
      group.publishMarks ||= {};
      group.publishMarkTimes ||= {};
      group.publishMarks[key] = nextValue;
      if (nextValue) {
        const publishedAt = new Date().toISOString();
        group.publishMarkTimes[key] = publishedAt;
        state.publishHistory ??= [];
        state.publishHistory.push({
          id: crypto.randomUUID(),
          groupId: group.id,
          version,
          platformId,
          publishedAt,
          source: "manual",
        });
      }
      else delete group.publishMarkTimes[key];
      group.updatedAt = new Date().toISOString();
      save();
      restoreScrollState(scrollState);
    };
  });
};

const showViewWithoutPlatformPreview = showView;
showView = function showViewWithPlatformPreview(view) {
  showViewWithoutPlatformPreview(view);
  document
    .querySelector("#platform-view")
    .classList.toggle("hidden", view !== "platform");
  if (view === "platform") {
    document.querySelector("#page-title").textContent = "平台预览";
    renderPlatformPreview();
  }
};

async function resetAllMaterials() {
  if ((state.publishTasks || []).length) {
    toast("还有发布任务未结束，请先完成或取消发布任务");
    showView("publish-tasks");
    return;
  }
  const confirmed = await confirmAppDialog({
    kicker: "资料管理",
    title: "确定重置所有素材？",
    message: "这会清空全部视频管理记录、发布勾选和待归组结果，但不会删除磁盘中的原视频或封面文件。",
    confirmLabel: "确认重置",
    tone: "danger",
  });
  if (!confirmed) return;

  const button = document.querySelector("#reset-materials");
  button.disabled = true;
  button.textContent = "正在重置…";
  try {
    state = await api("/api/reset-materials", { method: "POST" });
    candidates = [];
    selectedId = null;
    document.querySelector("#drawer-layer").innerHTML = "";
    render();
    renderCandidates();
    showView("library");
    toast("所有素材管理记录已重置，磁盘原文件未删除");
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = "重置所有素材";
  }
}

document.querySelector("#scan-button").onclick = scanNewVideos;
document.querySelector("#scan-all-button").onclick = scanAllVideos;
document.querySelector("#scan-again").onclick = () => scanVideos(lastScanMode);
document.querySelector("#reset-materials").onclick = resetAllMaterials;
document.querySelector("#add-source").onclick = pickSource;

// Local publish tasks -------------------------------------------------------
const publishTaskAutoOpened = new Set();
let publishTaskPollTimer = null;

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatTaskTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function publishVersionSlotsForGroup(group, version) {
  if (group?.category === "ageless" && version === "original") {
    return ["edited_video", "original_cover_portrait"];
  }
  return PUBLISH_VERSION_META[version]?.slots || PUBLISH_VERSION_META.original.slots;
}

function publishVersionAssets(group, version) {
  const slots = publishVersionSlotsForGroup(group, version);
  const assets = slots.map((slot) => group.assets?.[slot]).filter((asset) => asset?.available);
  return {
    slots,
    assets,
    hasVideo: Boolean(group.assets?.[slots[0]]?.available),
    missingCovers: slots.slice(1).filter((slot) => !group.assets?.[slot]?.available),
    bytes: assets.reduce((sum, asset) => sum + (Number(asset.size) || 0), 0),
  };
}

function currentLibraryScopeGroups() {
  return state.groups.filter(
    (group) => operationalCategory === "all" || group.category === operationalCategory,
  );
}

function currentLibraryVisibleGroups() {
  return currentLibraryScopeGroups().filter(
    (group) => !group.hidden && groupHasLibraryAsset(group),
  );
}

function refreshLibraryStats() {
  const scopedGroups = currentLibraryScopeGroups();
  const visibleGroups = currentLibraryVisibleGroups();
  const statCards = document.querySelectorAll("#stats .stat");
  const totalStat = statCards[0];
  if (totalStat) {
    const title = operationalCategory === "ageless"
      ? "老而不衰视频组"
      : operationalCategory === "facelift"
        ? "拉皮视频组"
        : "全部视频组";
    totalStat.querySelector("span").textContent = title;
    totalStat.querySelector("b").textContent = visibleGroups.length;
    const pendingCount = visibleGroups.filter(
      (group) => group.workflowStatus === "pending_edit",
    ).length;
    totalStat.querySelector("small").textContent = `待剪辑 ${pendingCount}`;
  }
  const materialStat = statCards[1];
  if (materialStat) {
    materialStat.querySelector("span").textContent = "已关联素材";
    materialStat.querySelector("b").textContent = visibleGroups
      .reduce((sum, group) => sum + availableMaterialCount(group), 0);
    materialStat.querySelector("small").textContent = hasOfflineSources()
      ? "素材盘离线时按历史记录保留"
      : "只统计实际已有素材";
  }
  const publishCompleteStat = statCards[2];
  if (publishCompleteStat) {
    publishCompleteStat.querySelector("b").textContent = visibleGroups
      .filter((group) => {
        const publishStatus = groupPublishProgress(group);
        return publishStatus.total && publishStatus.done === publishStatus.total;
      }).length;
    publishCompleteStat.querySelector("small").textContent = "按实际可发布版本统计";
  }
  const publishMarksStat = statCards[3];
  if (publishMarksStat) {
    publishMarksStat.querySelector("b").textContent = visibleGroups
      .reduce((sum, group) => sum + groupPublishProgress(group).done, 0);
  }
}

function taskStatusText(task) {
  return {
    copying: "正在复制",
    ready: "等待发布",
    completed: "全部已发布",
    copy_failed: "复制失败",
    canceling: "正在取消",
    cleanup_failed: "待清理",
  }[task.status] || task.status;
}

function confirmAppDialog({
  kicker = "请确认",
  title = "确认此操作？",
  message = "",
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "primary",
} = {}) {
  return new Promise((resolve) => {
    const safeTone = ["primary", "warning", "danger"].includes(tone) ? tone : "primary";
    const host = document.createElement("div");
    host.className = "app-confirm-host";
    host.innerHTML = `<div class="app-confirm-backdrop"><section class="modal app-confirm-modal tone-${safeTone}" role="dialog" aria-modal="true" aria-labelledby="app-confirm-title">
      <button type="button" class="close" aria-label="取消">×</button>
      <span class="app-confirm-kicker">${esc(kicker)}</span>
      <h2 id="app-confirm-title">${esc(title)}</h2>
      <p>${esc(message)}</p>
      <div class="modal-actions"><button type="button" class="ghost cancel">${esc(cancelLabel)}</button><button type="button" class="app-confirm-action">${esc(confirmLabel)}</button></div>
    </section></div>`;
    document.body.append(host);

    const finish = (confirmed) => {
      document.removeEventListener("keydown", onKeyDown);
      host.remove();
      resolve(confirmed);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter") finish(true);
    };
    document.addEventListener("keydown", onKeyDown);
    host.querySelector(".close").onclick = () => finish(false);
    host.querySelector(".cancel").onclick = () => finish(false);
    host.querySelector(".app-confirm-action").onclick = () => finish(true);
    host.querySelector(".app-confirm-backdrop").onclick = (event) => {
      if (event.target === event.currentTarget) finish(false);
    };
    host.querySelector(".cancel").focus();
  });
}

function confirmUndoTaskPlatform(platformName) {
  return new Promise((resolve) => {
    const layer = document.querySelector("#modal-layer");
    if (!layer) return resolve(false);
    layer.innerHTML = `<div class="modal-bg"><section class="modal task-undo-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="task-undo-confirm-title">
      <button type="button" class="close" aria-label="取消">×</button>
      <span class="task-undo-confirm-kicker">发布状态</span>
      <h2 id="task-undo-confirm-title">撤销“${esc(platformName)}”的发布记录？</h2>
      <p>只会撤销当前任务中该平台的发布确认，复制好的文件和其他发布记录不会受到影响。</p>
      <div class="modal-actions"><button type="button" class="ghost cancel">取消</button><button type="button" class="task-undo-confirm-action">撤销发布</button></div>
    </section></div>`;
    const finish = (confirmed) => {
      document.removeEventListener("keydown", onKeyDown);
      layer.innerHTML = "";
      resolve(confirmed);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", onKeyDown);
    layer.querySelector(".close").onclick = () => finish(false);
    layer.querySelector(".cancel").onclick = () => finish(false);
    layer.querySelector(".modal-bg").onclick = (event) => {
      if (event.target === event.currentTarget) finish(false);
    };
    const confirmButton = layer.querySelector(".task-undo-confirm-action");
    confirmButton.onclick = () => finish(true);
    confirmButton.focus();
  });
}

function confirmSkipTaskPlatform(platformName) {
  return new Promise((resolve) => {
    const layer = document.querySelector("#modal-layer");
    if (!layer) return resolve(false);
    layer.innerHTML = `<div class="modal-bg"><section class="modal task-skip-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="task-skip-confirm-title">
      <button type="button" class="close" aria-label="取消">×</button>
      <span class="task-skip-confirm-kicker">发布任务</span>
      <h2 id="task-skip-confirm-title">“${esc(platformName)}”本次不发布？</h2>
      <p>确认后，该平台会从当前任务中移除且不会写入发布记录。如需恢复，需要重新选择该平台。</p>
      <div class="modal-actions"><button type="button" class="ghost cancel">取消</button><button type="button" class="task-skip-confirm-action">确认本次不发</button></div>
    </section></div>`;
    const finish = (confirmed) => {
      document.removeEventListener("keydown", onKeyDown);
      layer.innerHTML = "";
      resolve(confirmed);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", onKeyDown);
    layer.querySelector(".close").onclick = () => finish(false);
    const cancelButton = layer.querySelector(".cancel");
    cancelButton.onclick = () => finish(false);
    layer.querySelector(".modal-bg").onclick = (event) => {
      if (event.target === event.currentTarget) finish(false);
    };
    layer.querySelector(".task-skip-confirm-action").onclick = () => finish(true);
    cancelButton.focus();
  });
}

function launchPublishTaskFlow(event) {
  event?.preventDefault();
  try {
    openPlatformInventoryTask();
  } catch (error) {
    console.error("打开发布任务失败", error);
    toast(`无法打开发布任务：${error?.message || "页面发生异常"}`);
  }
}

function renderPublishTasks() {
  const container = document.querySelector("#publish-task-list");
  if (!container) return;
  const tasks = state.publishTasks || [];
  document.querySelector("#publish-task-count").textContent = tasks.length;
  container.innerHTML = tasks.length
    ? `<div class="publish-task-page-head"><div><h2>发布任务</h2><p>账号全部确认后仍可撤销；确认无误后再手动完成并清理临时文件。</p></div><button class="primary" data-create-task>＋ 创建发布任务</button></div>${tasks.map((task) => {
        const percent = task.totalBytes
          ? Math.min(100, Math.round((task.copiedBytes || 0) / task.totalBytes * 100))
          : task.status === "ready" ? 100 : 0;
        const platforms = task.platformIds
          .map((id) => state.platforms.find((platform) => platform.id === id))
          .filter(Boolean);
        return `<article class="panel publish-task-card" data-task-id="${task.id}">
          <div class="publish-task-head">
            <div><span class="task-status ${task.status}">${taskStatusText(task)}</span><h2>${esc(task.name)}</h2><p>${esc(task.folderPath)} · ${formatTaskTime(task.createdAt)}</p></div>
            <div class="task-actions"><button class="ghost" data-task-open>打开文件夹</button>${task.status === "copy_failed" ? '<button class="ghost" data-task-retry>继续提取</button>' : ""}${task.status === "cleanup_failed" ? '<button class="ghost" data-task-cleanup>重试清理</button>' : ""}${task.status === "completed" ? '<button class="primary" data-task-finalize>完成并清理</button>' : '<button class="danger-outline" data-task-cancel>取消任务</button>'}</div>
          </div>
          <div class="task-copy-progress">
            <div><span>复制进度 ${task.copiedFiles || 0}/${task.totalFiles || 0} 个文件</span><b>${percent}% · ${formatBytes(task.copiedBytes)} / ${formatBytes(task.totalBytes)}</b></div>
            <div class="bar"><i style="width:${percent}%"></i></div>
            ${task.error ? `<p class="task-error">${esc(task.error)}</p>` : ""}
          </div>
          <div class="task-items">${task.items.map((item) => `<span><b>${esc(item.code)}</b> ${esc(item.title)} · ${publishVersionLabel(item.version)}</span>`).join("")}</div>
          <div class="task-platforms">
            <h3>逐个确认发布账号</h3>
            ${platforms.map((platform) => {
              const done = task.completedPlatformIds.includes(platform.id);
              return `<div class="task-platform-wrap"><button class="task-platform ${done ? "done" : ""}" data-task-platform="${platform.id}" ${done || task.status !== "ready" ? "disabled" : ""}>${platformOfficialLogoMarkup(platform)}<span><b>${esc(platform.name)}</b><small>${done ? "已记录发布" : task.status === "ready" ? "该平台已发布" : "等待素材复制完成"}</small></span>${done ? "✓" : ""}</button>${done ? `<button class="task-undo-platform" data-task-undo-platform="${platform.id}">撤销发布</button>` : `<button class="task-skip-platform" data-task-skip-platform="${platform.id}" ${task.status !== "ready" ? "disabled" : ""}>本次不发</button>`}</div>`;
            }).join("")}
          </div>
        </article>`;
      }).join("")}`
    : `<div class="panel empty publish-task-empty"><b>暂无进行中的发布任务</b>选择视频版本和发布账号，一键提取到桌面临时文件夹。<button class="primary" data-create-task>创建发布任务</button></div>`;

  container.querySelectorAll("[data-create-task]").forEach((button) => {
    button.onclick = launchPublishTaskFlow;
  });
  container.querySelectorAll(".publish-task-card").forEach((card) => {
    const taskId = card.dataset.taskId;
    const task = tasks.find((item) => item.id === taskId);
    card.querySelector("[data-task-open]").onclick = () => taskAction(taskId, "open");
    card.querySelector("[data-task-retry]")?.addEventListener("click", () => taskAction(taskId, "retry"));
    card.querySelector("[data-task-cleanup]")?.addEventListener("click", () => taskAction(taskId, "retry-cleanup"));
    const cancelTaskButton = card.querySelector("[data-task-cancel]");
    if (cancelTaskButton) cancelTaskButton.onclick = async () => {
      if (!await confirmAppDialog({
        kicker: "发布任务",
        title: "取消这个发布任务？",
        message: "任务会被取消并清理临时文件，不会写入任何发布状态。",
        confirmLabel: "取消任务",
        tone: "danger",
      })) return;
      await taskAction(taskId, "cancel");
    };
    const finalizeTaskButton = card.querySelector("[data-task-finalize]");
    if (finalizeTaskButton) finalizeTaskButton.onclick = async () => {
      if (!await confirmAppDialog({
        kicker: "发布任务",
        title: "完成并清理这个任务？",
        message: "请确认所有平台发布记录无误。清理临时文件后，任务将从列表中移除。",
        confirmLabel: "完成并清理",
      })) return;
      await taskAction(taskId, "finalize");
    };
    card.querySelectorAll("[data-task-platform]").forEach((button) => {
      button.onclick = async () => {
        const platformId = button.dataset.taskPlatform;
        const platform = state.platforms.find((item) => item.id === platformId);
        const remaining = task.platformIds.filter((id) => !task.completedPlatformIds.includes(id));
        if (remaining.length === 1 && !await confirmAppDialog({
          kicker: "最后一个发布账号",
          title: `确认“${platform?.name || "该账号"}”已发布？`,
          message: "确认后任务会标记为全部已发布；如有误，仍可在完成清理前撤销该记录。",
          confirmLabel: "确认已发布",
        })) return;
        try {
          const result = await api(`/api/publish-tasks/${encodeURIComponent(taskId)}/complete-platform`, {
            method: "POST",
            body: JSON.stringify({ platformId }),
          });
          state = result.state;
          render();
          renderPublishTasks();
          toast(result.finished ? "全部账号已记录发布，可撤销或完成并清理" : `已记录 ${platform?.name || "该账号"} 发布完成`);
        } catch (error) {
          toast(error.message);
        }
      };
    });
    card.querySelectorAll("[data-task-undo-platform]").forEach((button) => {
      button.onclick = async () => {
        const platformId = button.dataset.taskUndoPlatform;
        const platform = state.platforms.find((item) => item.id === platformId);
        if (!await confirmUndoTaskPlatform(platform?.name || "该账号")) return;
        try {
          const result = await api(`/api/publish-tasks/${encodeURIComponent(taskId)}/undo-platform`, {
            method: "POST",
            body: JSON.stringify({ platformId }),
          });
          state = result.state;
          render();
          renderPublishTasks();
          toast(`已撤销 ${platform?.name || "该账号"} 的本次发布记录`);
        } catch (error) {
          toast(error.message);
        }
      };
    });
    card.querySelectorAll("[data-task-skip-platform]").forEach((button) => {
      button.onclick = async () => {
        const platformId = button.dataset.taskSkipPlatform;
        const platform = state.platforms.find((item) => item.id === platformId);
        if (!await confirmSkipTaskPlatform(platform?.name || "该账号")) return;
        try {
          state = await api(`/api/publish-tasks/${encodeURIComponent(taskId)}/remove-platform`, {
            method: "POST",
            body: JSON.stringify({ platformId }),
          });
          render();
          renderPublishTasks();
          toast(`已从任务移除 ${platform?.name || "该账号"}`);
        } catch (error) {
          toast(error.message);
        }
      };
    });
  });
  managePublishTaskPolling();
}

async function taskAction(taskId, action) {
  try {
    const result = await api(`/api/publish-tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
    if (action !== "open") {
      state = await api("/api/state");
      render();
      renderPublishTasks();
    }
    if (action === "cancel") toast(result.pending ? "正在停止复制并清理临时文件" : "任务已取消，临时文件已清理");
    if (action === "finalize") toast("发布任务已完成，临时文件已清理");
    if (action === "retry") toast("已继续提取素材");
    if (action === "retry-cleanup") toast("临时文件已清理");
  } catch (error) {
    try {
      state = await api("/api/state");
      render();
      renderPublishTasks();
    } catch {}
    toast(error.message);
  }
}

function selectedTaskData(modal) {
  const platformIds = [...modal.querySelectorAll('[name="task-platform"]:checked')].map((item) => item.value);
  const items = [...modal.querySelectorAll('[name="task-version"]:checked')].map((item) => ({
    groupId: item.dataset.groupId,
    version: item.value,
  }));
  const details = items.map((item) => {
    const group = state.groups.find((candidate) => candidate.id === item.groupId);
    return { ...item, group, info: publishVersionAssets(group, item.version) };
  });
  return {
    platformIds,
    items,
    details,
    fileCount: details.reduce((sum, item) => sum + item.info.assets.length, 0),
    totalBytes: details.reduce((sum, item) => sum + item.info.bytes, 0),
    missingCovers: details.flatMap((item) => item.info.missingCovers.map((slot) => `${item.group.title} · ${publishVersionLabel(item.version)} · ${SLOT_LABELS[slot]}`)),
  };
}

function updateTaskSelectionSummary(modal) {
  const selection = selectedTaskData(modal);
  modal.querySelector("#task-selection-summary").innerHTML = `<b>${selection.items.length}</b> 个视频版本 · <b>${selection.platformIds.length}</b> 个账号 · <b>${selection.fileCount}</b> 个文件 · 约 <b>${formatBytes(selection.totalBytes)}</b>${selection.missingCovers.length ? `<span>缺少 ${selection.missingCovers.length} 个封面，创建时会再次确认</span>` : ""}`;
}

function filterPublishTaskGroups(modal) {
  const query = modal.querySelector("#task-search").value.trim().toLowerCase();
  const categoryValue = modal.querySelector("#task-category").value;
  modal.querySelectorAll(".task-video-choice").forEach((row) => {
    const visible = (!query || row.dataset.search.includes(query)) && (categoryValue === "all" || row.dataset.category === categoryValue);
    row.classList.toggle("hidden", !visible);
  });
}

function openCreatePublishTask() {
  const activePlatforms = state.platforms.filter((platform) => platform.active);
  const layer = document.querySelector("#modal-layer");
  layer.innerHTML = `<div class="modal-bg"><form class="modal create-publish-task-modal">
    <button type="button" class="close">×</button>
    <div class="task-modal-title"><div><h2>创建发布任务</h2><p>选择成片版本和账号，系统只复制一份素材到桌面临时文件夹。</p></div></div>
    <div class="task-modal-filters"><input id="task-search" placeholder="搜索标题、编号或备注"><select id="task-category"><option value="all">全部分类</option><option value="facelift">拉皮视频</option><option value="ageless">老而不衰视频</option></select></div>
    <section class="task-choice-section"><h3>1. 选择视频版本</h3><div class="task-video-choices">${state.groups.map((group) => {
      const versionChoices = PUBLISH_VERSION_IDS.map((version) => {
        const info = publishVersionAssets(group, version);
        const meta = PUBLISH_VERSION_META[version];
        return `<label class="version-choice ${info.hasVideo ? "" : "disabled"}"><input type="checkbox" name="task-version" value="${version}" data-group-id="${group.id}" ${info.hasVideo ? "" : "disabled"}><span>${meta.label}</span><small>${info.hasVideo ? `${info.assets.length}/3 个文件` : meta.missingVideoText}</small></label>`;
      }).join("");
      return `<article class="task-video-choice" data-category="${group.category}" data-search="${esc(`${group.code} ${group.title} ${group.notes || ""}`.toLowerCase())}"><div><span class="tag ${group.category}">${group.category === "facelift" ? "拉皮视频" : "老而不衰"}</span><b>${esc(group.title)}</b><small>${esc(group.code)}</small></div>${versionChoices}</article>`;
    }).join("") || '<div class="empty">还没有可选择的视频记录</div>'}</div></section>
    <section class="task-choice-section"><h3>2. 选择发布账号</h3><div class="task-platform-choices">${activePlatforms.map((platform) => `<label><input type="checkbox" name="task-platform" value="${platform.id}">${platformOfficialLogoMarkup(platform)}<span>${esc(platform.name)}</span></label>`).join("") || '<div class="empty">没有使用中的发布账号</div>'}</div></section>
    <label class="allow-repeat"><input type="checkbox" id="task-allow-repeat">允许重复发布 <small>开启后，也会提取已经在目标账号发布过的视频</small></label>
    <div id="task-selection-summary" class="task-selection-summary"></div>
    <div class="modal-actions"><button type="button" class="ghost cancel">取消</button><button class="primary">一键提取并打开文件夹</button></div>
  </form></div>`;
  const modal = layer.querySelector("form");
  const close = () => layer.innerHTML = "";
  modal.querySelector(".close").onclick = close;
  modal.querySelector(".cancel").onclick = close;
  modal.querySelectorAll('input[type="checkbox"]').forEach((input) => input.onchange = () => updateTaskSelectionSummary(modal));
  modal.querySelector("#task-search").oninput = () => filterPublishTaskGroups(modal);
  modal.querySelector("#task-category").onchange = () => filterPublishTaskGroups(modal);
  updateTaskSelectionSummary(modal);
  modal.onsubmit = async (event) => {
    event.preventDefault();
    const selection = selectedTaskData(modal);
    if (!selection.items.length) return toast("请至少选择一个视频版本");
    if (!selection.platformIds.length) return toast("请至少选择一个发布账号");
    let allowMissingCovers = false;
    if (selection.missingCovers.length) {
      allowMissingCovers = await confirmAppDialog({
        kicker: "素材不完整",
        title: "部分封面缺失",
        message: `以下封面缺失：\n${selection.missingCovers.join("\n")}\n\n是否只提取现有文件并继续？`,
        confirmLabel: "继续提取",
        tone: "warning",
      });
      if (!allowMissingCovers) return;
    }
    const submit = modal.querySelector('button[type="submit"], .modal-actions .primary');
    submit.disabled = true;
    submit.textContent = "正在创建任务…";
    try {
      const result = await api("/api/publish-tasks", {
        method: "POST",
        body: JSON.stringify({
          items: selection.items,
          platformIds: selection.platformIds,
          allowRepeat: modal.querySelector("#task-allow-repeat").checked,
          allowMissingCovers,
        }),
      });
      state = await api("/api/state");
      close();
      showView("publish-tasks");
      render();
      renderPublishTasks();
      toast(`发布任务已创建，正在提取 ${result.task.totalFiles} 个文件`);
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
      submit.textContent = "一键提取并打开文件夹";
    }
  };
}

function managePublishTaskPolling() {
  const needsPolling = (state.publishTasks || []).some((task) => ["copying", "canceling"].includes(task.status));
  if (!needsPolling) {
    clearInterval(publishTaskPollTimer);
    publishTaskPollTimer = null;
    return;
  }
  if (publishTaskPollTimer) return;
  publishTaskPollTimer = setInterval(async () => {
    try {
      const previous = new Map((state.publishTasks || []).map((task) => [task.id, task.status]));
      state = await api("/api/state");
      render();
      renderPublishTasks();
      for (const task of state.publishTasks || []) {
        if (task.status === "ready" && previous.get(task.id) === "copying" && !publishTaskAutoOpened.has(task.id)) {
          publishTaskAutoOpened.add(task.id);
          taskAction(task.id, "open");
          toast("素材提取完成，已打开任务文件夹");
        }
      }
    } catch {}
  }, 1000);
}

const renderWithoutPublishTasks = render;
render = function renderWithPublishTasks() {
  state.publishTasks ??= [];
  state.publishHistory ??= [];
  renderWithoutPublishTasks();
  document.querySelector("#publish-task-count").textContent = state.publishTasks.length;
  renderPublishTasks();
};

const showViewWithoutPublishTasks = showView;
showView = function showViewWithPublishTasks(view) {
  showViewWithoutPublishTasks(view);
  document.querySelector("#publish-task-view").classList.toggle("hidden", view !== "publish-tasks");
  if (view === "publish-tasks") {
    document.querySelector("#page-title").textContent = "发布任务";
    document.querySelector("#stats").classList.add("hidden");
    renderPublishTasks();
  } else {
    document.querySelector("#stats").classList.remove("hidden");
  }
};

document.querySelector("#create-publish-task").onclick = openCreatePublishTask;

// Inventory, category isolation and hidden videos --------------------------
let operationalCategory = "all";
let videoVisibility = "visible";
let selectedInventoryPlatformId = null;
const DOUYIN_PLATFORM_IDS = ["platform-1", "platform-2"];
const DOUYIN_FACELIFT_INVENTORY_ID = "douyin-facelift";

function groupHasAvailableAsset(group) {
  return Object.values(group?.assets ?? {}).some((asset) => asset?.available);
}

function groupHasLibraryAsset(group) {
  return Object.values(group?.assets ?? {}).some((asset) => libraryAssetAvailable(asset));
}

function groupPreviewAsset(group) {
  const firstAvailable = (...assets) => assets.find((asset) => asset?.available);
  if (group?.category === "ageless") {
    return firstAvailable(
      group.assets?.original_cover_portrait,
      group.assets?.edited_video,
      group.assets?.original_video,
      group.assets?.original_cover_landscape
    );
  }
  return firstAvailable(
    group.assets?.original_cover_landscape,
    group.assets?.original_cover_portrait,
    group.assets?.edited_video,
    group.assets?.original_video
  );
}

let scrollRestoreToken = 0;
let lastUserScrollAt = 0;

["wheel", "touchmove", "scroll"].forEach((eventName) => {
  window.addEventListener(
    eventName,
    () => {
      lastUserScrollAt = Date.now();
      scrollRestoreToken += 1;
    },
    { passive: true, capture: true },
  );
});

function restoreScrollAfterRender(callback) {
  const token = ++scrollRestoreToken;
  const restore = () => {
    if (token !== scrollRestoreToken) return;
    if (Date.now() - lastUserScrollAt < 140) return;
    callback();
  };
  requestAnimationFrame(() => {
    restore();
    setTimeout(restore, 0);
  });
}

const SCROLL_PRESERVE_SELECTORS = [
  "main",
  ".drawer",
  ".drawer-content",
  ".drawer .matrix",
  ".asset-grid",
  ".modal-bg",
  ".modal",
  ".create-publish-task-modal",
  ".platform-first-task-modal",
  ".platform-stock-task-modal",
  ".today-platform-grid",
  ".task-platform-tabs",
  ".platform-stock-list",
  ".task-video-choices",
  ".task-platform-selection-counts",
  ".publish-task-card",
];

function captureScrollState() {
  return {
    pageX: window.scrollX,
    pageY: window.scrollY,
    elements: SCROLL_PRESERVE_SELECTORS.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((element, index) => ({
        selector,
        index,
        top: element.scrollTop || 0,
        left: element.scrollLeft || 0,
      })),
    ),
  };
}

function restoreScrollState(scrollState) {
  if (!scrollState) return;
  restoreScrollAfterRender(() => {
    window.scrollTo(scrollState.pageX || 0, scrollState.pageY || 0);
    scrollState.elements?.forEach(({ selector, index, top, left }) => {
      const element = document.querySelectorAll(selector)[index];
      if (!element) return;
      element.scrollTop = top || 0;
      element.scrollLeft = left || 0;
    });
  });
}

function releaseScrollChangingFocus(target = document.activeElement) {
  const element = target?.closest?.("input, select, button");
  if (element && typeof element.blur === "function") element.blur();
}

function preserveScrollAround(callback, focusTarget = document.activeElement) {
  const scrollState = captureScrollState();
  const result = callback();
  releaseScrollChangingFocus(focusTarget);
  restoreScrollState(scrollState);
  if (result && typeof result.then === "function") {
    return result.finally(() => {
      releaseScrollChangingFocus(focusTarget);
      restoreScrollState(scrollState);
    });
  }
  return result;
}

function effectiveDouyinOriginalPlatform(group, draftAssignments = {}) {
  if (draftAssignments[group.id]) return draftAssignments[group.id];
  if (group.douyinOriginalPlatformId) return group.douyinOriginalPlatformId;
  if (group.publishMarks?.[markKey("original", "platform-1")]) return "platform-1";
  if (group.publishMarks?.[markKey("original", "platform-2")]) return "platform-2";
  if (group.publishMarks?.[markKey("remix", "platform-1")]) return "platform-2";
  if (group.publishMarks?.[markKey("remix", "platform-2")]) return "platform-1";
  return "";
}

function platformContentCategory(platform) {
  const searchable = `${platform?.name || ""} ${platform?.accountName || ""}`;
  return searchable.includes("老而不衰") ? "ageless" : "facelift";
}

function groupCategoryLabel(group) {
  return group?.category === "ageless" ? "老而不衰" : "拉皮视频";
}

function groupCategoryClass(group) {
  return group?.category;
}

function platformAcceptsGroup(platform, group) {
  return Boolean(platform && group) &&
    group.workflowStatus !== "pending_edit" &&
    group.category === platformContentCategory(platform);
}

function publishableVersionsForGroup(group) {
  return PUBLISH_VERSION_IDS.filter((version) => publishVersionAssets(group, version).hasVideo);
}

function publishTargetApplies(group, version, platform) {
  if (!platformAcceptsGroup(platform, group)) return false;
  if (
    group?.category === "facelift" &&
    DOUYIN_PLATFORM_IDS.includes(platform?.id) &&
    ["original", "remix"].includes(version)
  ) {
    const originalPlatformId = effectiveDouyinOriginalPlatform(group);
    if (!originalPlatformId) return true;
    const expectedVersion = platform.id === originalPlatformId ? "original" : "remix";
    return version === expectedVersion;
  }
  return true;
}

function groupPublishProgress(group) {
  const platforms = state.platforms.filter((platform) =>
    platform.active && platformAcceptsGroup(platform, group),
  );
  const versions = publishableVersionsForGroup(group);
  const targets = platforms.flatMap((platform) =>
    versions
      .filter((version) => publishTargetApplies(group, version, platform))
      .map((version) => ({ platform, version })),
  );
  return {
    done: targets.reduce(
      (count, target) =>
        count + Number(!!group.publishMarks?.[markKey(target.version, target.platform.id)]),
      0,
    ),
    total: targets.length,
  };
}

function douyinOriginalPlatformForCurrentVersion(platformId, version) {
  if (version === "original") return platformId;
  if (version === "remix") return platformId === "platform-1" ? "platform-2" : "platform-1";
  return "";
}

function douyinCurrentPlatformVersion(platformId, originalPlatformId) {
  if (!originalPlatformId) return "";
  return platformId === originalPlatformId ? "original" : "remix";
}

function douyinVersionOptionAvailable(group, platformId, version) {
  const info = publishVersionAssets(group, version);
  return info.hasVideo && !group.publishMarks?.[markKey(version, platformId)];
}

function inventoryForPlatform(platformId, draftAssignments = {}) {
  const platform = state.platforms.find((item) => item.id === platformId);
  if (!platform) return [];
  const isDouyinPair = DOUYIN_PLATFORM_IDS.includes(platformId);
  return state.groups
    .filter((group) => !group.hidden && platformAcceptsGroup(platform, group))
    .flatMap((group) => {
      if (isDouyinPair && group.category === "facelift") {
        const lockedOriginalPlatformId = effectiveDouyinOriginalPlatform(group);
        const originalPlatformId =
          lockedOriginalPlatformId || draftAssignments[group.id] || "";
        const version = douyinCurrentPlatformVersion(platformId, originalPlatformId);
        const canOriginal = douyinVersionOptionAvailable(group, platformId, "original");
        const canRemix = douyinVersionOptionAvailable(group, platformId, "remix");
        const selectedAvailable = version
          ? douyinVersionOptionAvailable(group, platformId, version)
          : false;
        const records = [];
        if (
          lockedOriginalPlatformId
            ? selectedAvailable
            : canOriginal || canRemix
        ) {
          records.push({
            group,
            version: selectedAvailable ? version : "",
            info: selectedAvailable ? publishVersionAssets(group, version) : undefined,
            unassigned: !originalPlatformId,
            douyinAssignable: true,
            locked: Boolean(lockedOriginalPlatformId),
            originalPlatformId,
            canOriginal,
            canRemix,
          });
        }
        const thirdInfo = publishVersionAssets(group, "third");
        if (thirdInfo.hasVideo && !group.publishMarks?.[markKey("third", platformId)]) {
          records.push({ group, version: "third", info: thirdInfo });
        }
        return records;
      }
      return PUBLISH_VERSION_IDS.flatMap((version) => {
        const info = publishVersionAssets(group, version);
        return info.hasVideo && !group.publishMarks?.[markKey(version, platformId)]
          ? [{ group, version, info }]
          : [];
      });
    });
}

function inventoryCounts(platformId) {
  const records = inventoryForPlatform(platformId);
  return {
    original: records.filter((record) => record.version === "original").length,
    remix: records.filter((record) => record.version === "remix").length,
    third: records.filter((record) => record.version === "third").length,
    unassigned: records.filter((record) => record.unassigned).length,
    total: records.filter((record) => record.version).length,
  };
}

function douyinFaceliftInventoryRecords() {
  const activeDouyinPlatforms = state.platforms.filter(
    (platform) =>
      platform.active && DOUYIN_PLATFORM_IDS.includes(platform.id),
  );
  if (!activeDouyinPlatforms.length) return [];
  return state.groups
    .filter(
      (group) =>
        !group.hidden &&
        group.category === "facelift" &&
        group.workflowStatus !== "pending_edit" &&
        groupHasAvailableAsset(group),
    )
    .flatMap((group) => {
      const originalPlatformId = effectiveDouyinOriginalPlatform(group);
      const thirdInfo = publishVersionAssets(group, "third");
      const thirdRecords = activeDouyinPlatforms.flatMap((platform) =>
        thirdInfo.hasVideo && !group.publishMarks?.[markKey("third", platform.id)]
          ? [{ group, version: "third", platform, unassigned: false, originalPlatformId }]
          : [],
      );
      if (!originalPlatformId) {
        return [
          ...["original", "remix"].flatMap((version) =>
          publishVersionAssets(group, version).hasVideo
            ? [{ group, version, unassigned: true }]
            : [],
          ),
          ...thirdRecords,
        ];
      }
      const assignedRecords = activeDouyinPlatforms.flatMap((platform) => {
        const version =
          platform.id === originalPlatformId ? "original" : "remix";
        const info = publishVersionAssets(group, version);
        return info.hasVideo &&
          !group.publishMarks?.[markKey(version, platform.id)]
          ? [{
              group,
              version,
              platform,
              unassigned: false,
              originalPlatformId,
            }]
          : [];
      });
      return [...assignedRecords, ...thirdRecords];
    });
}

function renderInventoryPage() {
  const container = document.querySelector("#inventory-page");
  if (!container) return;
  const pageScroll = { x: window.scrollX, y: window.scrollY };
  const activePlatforms = state.platforms.filter((platform) => platform.active);
  const activeDouyinPlatforms = activePlatforms.filter((platform) =>
    DOUYIN_PLATFORM_IDS.includes(platform.id),
  );
  const regularPlatforms = activePlatforms.filter(
    (platform) => !DOUYIN_PLATFORM_IDS.includes(platform.id),
  );
  if (
    selectedInventoryPlatformId === "douyin-unassigned" ||
    DOUYIN_PLATFORM_IDS.includes(selectedInventoryPlatformId)
  ) {
    selectedInventoryPlatformId = DOUYIN_FACELIFT_INVENTORY_ID;
  }
  if (
    selectedInventoryPlatformId !== DOUYIN_FACELIFT_INVENTORY_ID &&
    !regularPlatforms.some(
      (platform) => platform.id === selectedInventoryPlatformId,
    )
  ) {
    selectedInventoryPlatformId = activeDouyinPlatforms.length
      ? DOUYIN_FACELIFT_INVENTORY_ID
      : regularPlatforms[0]?.id || null;
  }
  const douyinRecords = douyinFaceliftInventoryRecords();
  const selectedPlatform = regularPlatforms.find(
    (platform) => platform.id === selectedInventoryPlatformId,
  );
  const selectedRecords =
    selectedInventoryPlatformId === DOUYIN_FACELIFT_INVENTORY_ID
      ? douyinRecords
      : selectedPlatform
        ? inventoryForPlatform(selectedPlatform.id).filter((record) => record.version)
        : [];
  const inventoryEntryCount =
    regularPlatforms.length + Number(activeDouyinPlatforms.length > 0);
  document.querySelector("#inventory-count").textContent = inventoryEntryCount;
  container.innerHTML = `
    <div class="inventory-layout">
      <aside class="panel inventory-platform-list">
        <div class="inventory-head"><h2>各平台库存</h2><span>${inventoryEntryCount} 个库存入口</span></div>
        ${
          activeDouyinPlatforms.length
            ? `<button class="inventory-platform ${selectedInventoryPlatformId === DOUYIN_FACELIFT_INVENTORY_ID ? "active" : ""}" data-inventory-platform="${DOUYIN_FACELIFT_INVENTORY_ID}">${platformOfficialLogoMarkup(activeDouyinPlatforms[0])}<div><b>抖音拉皮号库存</b><small>抖音1号与2号共用拉皮视频库存</small></div><i>${douyinRecords.length}</i></button>`
            : ""
        }
        ${regularPlatforms.map((platform) => {
          const counts = inventoryCounts(platform.id);
          return `<button class="inventory-platform ${selectedInventoryPlatformId === platform.id ? "active" : ""}" data-inventory-platform="${platform.id}">${platformOfficialLogoMarkup(platform)}<div><b>${esc(platform.name)}</b><small>原版 ${counts.original} · 二创 ${counts.remix} · 三创 ${counts.third}</small></div><i>${counts.total}</i></button>`;
        }).join("")}
      </aside>
      <section class="panel inventory-detail">
        <div class="inventory-detail-head"><div><h2>${selectedInventoryPlatformId === DOUYIN_FACELIFT_INVENTORY_ID ? "抖音拉皮号库存" : esc(selectedPlatform?.name || "发布库存")}</h2><p>${selectedInventoryPlatformId === DOUYIN_FACELIFT_INVENTORY_ID ? "抖音1号和2号使用同一批拉皮视频；创建任务时再确定原版与二创归属。" : "只显示未隐藏、成片可用且尚未发布的版本。"}</p></div><button class="primary" data-create-from-inventory>创建发布任务</button></div>
        <div class="inventory-rows">${
          selectedRecords.length
            ? selectedRecords.map((record) => {
                const status =
                  selectedInventoryPlatformId === DOUYIN_FACELIFT_INVENTORY_ID
                    ? record.unassigned
                      ? publishVersionLabel(record.version)
                      : `${record.platform.name}${
                          publishVersionLabel(record.version)
                        }`
                    : publishVersionLabel(record.version);
                return `<article class="inventory-row"><span class="tag ${record.group.category}">${record.group.category === "facelift" ? "拉皮视频" : "老而不衰"}</span><div><b>${esc(record.group.title)}</b><small>${esc(record.group.code)}</small></div><div class="inventory-row-actions"><strong>${esc(status)}</strong><button type="button" data-open-inventory-file="${record.group.id}" data-inventory-version="${record.version}">打开文件位置</button></div></article>`;
              }).join("")
            : '<div class="empty"><b>这个账号暂时没有待发布库存</b>已发布、隐藏或缺少成片的视频不会显示。</div>'
        }</div>
      </section>
    </div>`;
  container.querySelectorAll("[data-open-inventory-file]").forEach((button) => {
    button.onclick = async () => {
      const group = state.groups.find(
        (item) => item.id === button.dataset.openInventoryFile,
      );
      const slot =
        PUBLISH_VERSION_META[button.dataset.inventoryVersion]?.videoSlot ||
        PUBLISH_VERSION_META.original.videoSlot;
      const asset = group?.assets?.[slot];
      if (!asset?.available) {
        toast(
          PUBLISH_VERSION_META[button.dataset.inventoryVersion]?.unavailableText ||
            PUBLISH_VERSION_META.original.unavailableText,
        );
        return;
      }
      try {
        await api("/api/open", {
          method: "POST",
          body: JSON.stringify({ path: asset.path, kind: "folder" }),
        });
      } catch (error) {
        toast(error.message);
      }
    };
  });
  container.querySelectorAll("[data-inventory-platform]").forEach((button) => {
    button.onclick = () => preserveScrollAround(() => {
      selectedInventoryPlatformId = button.dataset.inventoryPlatform;
      renderInventoryPage();
    }, button);
  });
  container.querySelector("[data-create-from-inventory]").onclick = () => preserveScrollAround(() => {
    openPlatformInventoryTask(
      selectedInventoryPlatformId === DOUYIN_FACELIFT_INVENTORY_ID
        ? activeDouyinPlatforms.map((platform) => platform.id)
        : selectedPlatform
          ? [selectedPlatform.id]
          : [],
    );
  }, container.querySelector("[data-create-from-inventory]"));
  restoreScrollAfterRender(() =>
    window.scrollTo(pageScroll.x, pageScroll.y),
  );
}

function renderOperationalVideoList() {
  const pageScroll = { x: window.scrollX, y: window.scrollY };
  const q = document.querySelector("#search").value.trim().toLowerCase();
  const assetFilter = document.querySelector("#asset-filter").value;
  const publishFilter = document.querySelector("#publish-filter").value;
  const sortMode = document.querySelector("#sort-filter")?.value || "material-desc";
  let groups = state.groups.filter((group) => {
    if (operationalCategory !== "all" && group.category !== operationalCategory) return false;
    if (
      videoVisibility === "visible" &&
      (group.hidden ||
        group.workflowStatus === "pending_edit" ||
        !groupHasLibraryAsset(group))
    ) return false;
    if (
      videoVisibility === "pending" &&
      (group.hidden ||
        group.workflowStatus !== "pending_edit" ||
        !groupHasLibraryAsset(group))
    ) return false;
    if (videoVisibility === "hidden" && !group.hidden) return false;
    if (q && !`${group.code} ${group.title} ${group.notes}`.toLowerCase().includes(q)) return false;
    const materialsComplete = groupRequiredMaterialsComplete(group);
    if (assetFilter === "complete" && !materialsComplete) return false;
    if (assetFilter === "missing" && materialsComplete) return false;
    const publishProgress = groupPublishProgress(group);
    if (publishFilter === "complete" && publishProgress.done !== publishProgress.total) return false;
    if (publishFilter === "open" && publishProgress.done === publishProgress.total) return false;
    return true;
  });
  groups = [...groups].sort((left, right) => {
    if (sortMode === "material-asc") return groupMaterialTimestamp(left) - groupMaterialTimestamp(right);
    if (sortMode === "updated-desc") return (Date.parse(right.updatedAt || "") || 0) - (Date.parse(left.updatedAt || "") || 0);
    if (sortMode === "code-desc") return compareGroupCodes(right, left);
    if (sortMode === "code-asc") return compareGroupCodes(left, right);
    if (sortMode === "title-asc") return String(left.title || "").localeCompare(String(right.title || ""), "zh-CN", { numeric: true });
    return groupMaterialTimestamp(right) - groupMaterialTimestamp(left);
  });
  refreshLibraryStats();
  document.querySelector("#result-count").textContent = `${groups.length} 条`;
  document.querySelector("#video-list").innerHTML = groups.length
    ? groups.map((group) => {
        const assetCount = availableMaterialCount(group);
        const assetWidth = materialBarWidth(group);
        const publishProgress = groupPublishProgress(group);
        const cover = groupPreviewAsset(group);
        const coverLetter =
          group.category === "facelift" ? "拉" : "老";
        return `<article class="video-row ${group.category === "ageless" ? "ageless-video-row" : ""} ${group.hidden ? "is-hidden-video" : ""}" data-id="${group.id}"><div class="cover">${cover?.thumbnail ? `<img src="${cover.thumbnail}">` : coverLetter}</div><div><span class="tag ${groupCategoryClass(group)}">${groupCategoryLabel(group)}</span>${group.workflowStatus === "pending_edit" ? '<span class="tag pending-edit">待剪辑</span>' : ""}${group.hidden ? '<span class="hidden-video-badge">已隐藏</span>' : ""}${!groupHasAvailableAsset(group) ? `<span class="unavailable-video-badge">${hasOfflineSources() ? "素材盘离线" : "文件不可用"}</span>` : ""}<h3>${esc(group.title)}</h3><p>${esc(group.code)} · ${esc(group.notes || "暂无备注")}</p></div><div class="progress"><span>素材 ${assetCount}</span><div class="bar"><i style="width:${assetWidth}%"></i></div></div><div class="progress publish"><span>发布 ${publishProgress.done}/${publishProgress.total}</span><div class="bar"><i style="width:${publishProgress.total ? publishProgress.done / publishProgress.total * 100 : 0}%"></i></div></div><button class="video-visibility-action" data-toggle-video-hidden="${group.id}">${group.hidden ? "恢复展示" : "隐藏"}</button><b class="video-open-arrow">›</b></article>`;
      }).join("")
    : '<div class="empty"><b>没有符合条件的视频</b>可以切换“展示视频”“所有视频”“待剪辑”或“隐藏视频”查看。</div>';
  document.querySelectorAll(".video-row").forEach((row) => {
    row.onclick = (event) => {
      if (event.target.closest("[data-toggle-video-hidden]")) return;
      openDrawer(row.dataset.id);
    };
  });
  document.querySelectorAll("[data-toggle-video-hidden]").forEach((button) => {
    button.onclick = async () => preserveScrollAround(async () => {
      const group = state.groups.find((item) => item.id === button.dataset.toggleVideoHidden);
      if (!group) return;
      group.hidden = !group.hidden;
      group.hiddenAt = group.hidden ? new Date().toISOString() : "";
      await save();
      toast(group.hidden ? "视频已隐藏，不再进入库存和发布任务" : "视频已恢复展示");
    }, button);
  });
  restoreScrollAfterRender(() =>
    window.scrollTo(pageScroll.x, pageScroll.y),
  );
}

renderList = renderOperationalVideoList;

function renderVisibilityTabs() {
  const hiddenCount = state.groups.filter((group) => group.hidden).length;
  const pendingCount = state.groups.filter(
    (group) =>
      !group.hidden &&
      group.workflowStatus === "pending_edit" &&
      (operationalCategory === "all" || group.category === operationalCategory),
  ).length;
  document.querySelector("#hidden-video-count").textContent = hiddenCount;
  document.querySelector("#pending-video-count").textContent = pendingCount;
  document.querySelectorAll("[data-video-visibility]").forEach((button) => {
    button.classList.toggle("active", button.dataset.videoVisibility === videoVisibility);
    button.onclick = () => preserveScrollAround(() => {
      videoVisibility = button.dataset.videoVisibility;
      renderOperationalVideoList();
      renderVisibilityTabs();
    }, button);
  });
}

function inventorySelectionSummary(platformSelections) {
  return platformSelections.reduce(
    (summary, selection) => {
      summary.platforms += 1;
      summary.items += selection.items.length;
      for (const item of selection.items) {
        const group = state.groups.find((candidate) => candidate.id === item.groupId);
        const info = publishVersionAssets(group, item.version);
        summary.files += info.assets.length;
        summary.bytes += info.bytes;
        summary.missingCovers.push(
          ...info.missingCovers.map(
            (slot) => `${group.title} · ${publishVersionLabel(item.version)} · ${SLOT_LABELS[slot]}`,
          ),
        );
      }
      return summary;
    },
    { platforms: 0, items: 0, files: 0, bytes: 0, missingCovers: [] },
  );
}

function openPlatformInventoryTask(prefilledPlatformIds = []) {
  const activePlatforms = state.platforms.filter((platform) => platform.active);
  const layer = document.querySelector("#modal-layer");
  const draft = {
    step: 1,
    platformIds: new Set(prefilledPlatformIds),
    selections: {},
    douyinAssignments: Object.fromEntries(
      state.groups
        .map((group) => [group.id, effectiveDouyinOriginalPlatform(group)])
        .filter(([, platformId]) => platformId),
    ),
    activePlatformId: prefilledPlatformIds[0] || "",
    allowRepeat: false,
  };
  const taskModalScrollSelectors = [
    ".modal-bg",
    ".platform-first-task-modal",
    ".platform-stock-task-modal",
    ".today-platform-grid",
    ".task-platform-tabs",
    ".platform-stock-list",
    ".task-platform-selection-counts",
  ];
  let taskModalScrollState = null;
  let taskModalRestoreToken = 0;
  let taskModalUserScrolledAt = 0;
  const taskCssEscape = (value) =>
    window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  const taskAnchorSelector = (target) => {
    const element = target?.closest?.(
      "[data-task-platform],[data-stock-platform],[data-stock-group],[data-douyin-group],#task-allow-repeat,.next-platform-stock,.back-platform-step,.today-platform-grid label,.today-platform-grid input,.platform-stock-row",
    );
    if (!element) return "";
    if (element.dataset.taskPlatform) return `[data-task-platform="${taskCssEscape(element.dataset.taskPlatform)}"]`;
    if (element.matches?.(".today-platform-grid input")) return `.today-platform-grid input[value="${taskCssEscape(element.value)}"]`;
    if (element.matches?.(".today-platform-grid label")) {
      const input = element.querySelector("input[value]");
      if (input) return `.today-platform-grid input[value="${taskCssEscape(input.value)}"]`;
    }
    if (element.dataset.stockPlatform) return `[data-stock-platform="${taskCssEscape(element.dataset.stockPlatform)}"]`;
    if (element.dataset.stockGroup) {
      return `[data-stock-group="${taskCssEscape(element.dataset.stockGroup)}"][data-stock-version="${taskCssEscape(element.dataset.stockVersion || "")}"]`;
    }
    if (element.dataset.douyinGroup) return `[data-douyin-group="${taskCssEscape(element.dataset.douyinGroup)}"]`;
    if (element.classList.contains("platform-stock-row")) {
      const input = element.querySelector("[data-stock-group]");
      if (input) return `[data-stock-group="${taskCssEscape(input.dataset.stockGroup)}"][data-stock-version="${taskCssEscape(input.dataset.stockVersion || "")}"]`;
      const select = element.querySelector("[data-douyin-group]");
      if (select) return `[data-douyin-group="${taskCssEscape(select.dataset.douyinGroup)}"]`;
    }
    if (element.id === "task-allow-repeat") return "#task-allow-repeat";
    if (element.classList.contains("next-platform-stock")) return ".next-platform-stock";
    if (element.classList.contains("back-platform-step")) return ".back-platform-step";
    return "";
  };
  const captureTaskAnchor = (focusTarget = document.activeElement) => {
    const selector = taskAnchorSelector(focusTarget);
    if (!selector) return null;
    const element = layer.querySelector(selector);
    if (!element) return null;
    return {
      selector,
      top: element.getBoundingClientRect().top,
    };
  };
  const restoreTaskAnchor = (anchor) => {
    if (!anchor?.selector) return;
    const element = layer.querySelector(anchor.selector);
    if (!element) return;
    const scroller = element.closest(
      ".platform-stock-list,.platform-stock-task-modal,.platform-first-task-modal,.today-platform-grid,.task-platform-tabs,.modal-bg",
    );
    if (!scroller) return;
    const delta = element.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
  };
  const stopTaskFocusScroll = (event) => {
    if (event.target?.closest?.("select")) return;
    event.preventDefault();
  };
  const protectTaskClickFromScroll = (element) => {
    if (!element) return;
    element.addEventListener("pointerdown", stopTaskFocusScroll);
    element.addEventListener("mousedown", stopTaskFocusScroll);
  };

  const saveTaskModalScrollState = (focusTarget = document.activeElement) => {
    taskModalScrollState = {
      pageX: window.scrollX,
      pageY: window.scrollY,
      anchor: captureTaskAnchor(focusTarget),
      elements: taskModalScrollSelectors.flatMap((selector) =>
        [...layer.querySelectorAll(selector)].map((element, index) => ({
          selector,
          index,
          top: element.scrollTop || 0,
          left: element.scrollLeft || 0,
        })),
      ),
    };
    return taskModalScrollState;
  };

  const restoreTaskModalScrollState = (scrollState = taskModalScrollState) => {
    if (!scrollState) return;
    const token = ++taskModalRestoreToken;
    const restore = () => {
      if (token !== taskModalRestoreToken) return;
      if (Date.now() - taskModalUserScrolledAt < 140) return;
      window.scrollTo(scrollState.pageX || 0, scrollState.pageY || 0);
      scrollState.elements?.forEach(({ selector, index, top, left }) => {
        const element = layer.querySelectorAll(selector)[index];
        if (!element) return;
        element.scrollTop = top || 0;
        element.scrollLeft = left || 0;
      });
      restoreTaskAnchor(scrollState.anchor);
    };
    requestAnimationFrame(() => {
      restore();
      setTimeout(restore, 0);
    });
  };

  const bindTaskModalScrollGuard = () => {
    const markUserScroll = () => {
      taskModalUserScrolledAt = Date.now();
      taskModalRestoreToken += 1;
    };
    layer.querySelectorAll(
      ".modal-bg,.platform-first-task-modal,.platform-stock-task-modal,.today-platform-grid,.task-platform-tabs,.platform-stock-list",
    ).forEach((element) => {
      if (element.dataset.scrollGuardBound === "true") return;
      element.dataset.scrollGuardBound = "true";
      element.addEventListener("wheel", markUserScroll, { passive: true });
      element.addEventListener("touchmove", markUserScroll, { passive: true });
      element.addEventListener("scroll", markUserScroll, { passive: true });
    });
  };

  const withTaskModalScroll = (callback, focusTarget = document.activeElement) => {
    const scrollState = saveTaskModalScrollState(focusTarget);
    releaseScrollChangingFocus(focusTarget);
    const result = callback();
    releaseScrollChangingFocus(focusTarget);
    restoreTaskModalScrollState(scrollState);
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        releaseScrollChangingFocus(focusTarget);
        restoreTaskModalScrollState(scrollState);
      });
    }
    return result;
  };

  const close = () => { layer.innerHTML = ""; };
  const renderModal = () => {
    const scrollState = taskModalScrollState || saveTaskModalScrollState();
    const restoreScroll = () => restoreTaskModalScrollState(scrollState);
    if (draft.step === 1) {
      layer.innerHTML = `<div class="modal-bg"><div class="modal platform-first-task-modal"><button type="button" class="close">×</button><h2>选择今日发布平台</h2><p>下一步将逐个平台显示各自库存，每个平台可以选择不同的视频和数量。</p><div class="today-platform-grid">${activePlatforms.map((platform) => {
        const counts = inventoryCounts(platform.id);
        return `<label class="${draft.platformIds.has(platform.id) ? "selected" : ""}"><input type="checkbox" value="${platform.id}" ${draft.platformIds.has(platform.id) ? "checked" : ""}>${platformOfficialLogoMarkup(platform)}<span><b>${esc(platform.name)}</b><small>原版 ${counts.original} · 二创 ${counts.remix} · 三创 ${counts.third}${counts.unassigned ? ` · 待分配 ${counts.unassigned}` : ""}</small></span></label>`;
      }).join("")}</div><div class="modal-actions"><button type="button" class="ghost cancel">取消</button><button type="button" class="primary next-platform-stock">下一步：选择各平台库存</button></div></div></div>`;
      layer.querySelector(".close").onclick = close;
      layer.querySelector(".cancel").onclick = close;
      protectTaskClickFromScroll(layer.querySelector(".next-platform-stock"));
      layer.querySelectorAll('.today-platform-grid input').forEach((input) => {
        const row = input.closest("label");
        const togglePlatformSelection = (event) => {
          event?.preventDefault();
          event?.stopPropagation();
          withTaskModalScroll(() => {
            const shouldSelect = !draft.platformIds.has(input.value);
            input.checked = shouldSelect;
            if (shouldSelect) {
              draft.platformIds.add(input.value);
            } else {
              draft.platformIds.delete(input.value);
            }
            row?.classList.toggle("selected", shouldSelect);
          }, row || input);
        };
        protectTaskClickFromScroll(input);
        protectTaskClickFromScroll(row);
        input.addEventListener("click", togglePlatformSelection);
        row?.addEventListener("click", togglePlatformSelection);
      });
      layer.querySelector(".next-platform-stock").onclick = () => withTaskModalScroll(() => {
        if (!draft.platformIds.size) return toast("请至少选择一个今日发布平台");
        draft.activePlatformId = [...draft.platformIds][0];
        draft.step = 2;
        renderModal();
      }, layer.querySelector(".next-platform-stock"));
      bindTaskModalScrollGuard();
      restoreScroll();
      return;
    }

    const chosenPlatforms = activePlatforms.filter((platform) => draft.platformIds.has(platform.id));
    if (!chosenPlatforms.some((platform) => platform.id === draft.activePlatformId)) {
      draft.activePlatformId = chosenPlatforms[0]?.id || "";
    }
    const activePlatform = chosenPlatforms.find((platform) => platform.id === draft.activePlatformId);
    const applyDraftDouyinAssignment = (groupId, originalPlatformId, forceSelectPlatformId = "") => {
      const group = state.groups.find((item) => item.id === groupId);
      if (!group) return;
      for (const platformId of DOUYIN_PLATFORM_IDS) {
        draft.selections[platformId] ||= {};
        const wasSelected = Boolean(
          draft.selections[platformId][`${groupId}:original`] ||
            draft.selections[platformId][`${groupId}:remix`],
        );
        delete draft.selections[platformId][`${groupId}:original`];
        delete draft.selections[platformId][`${groupId}:remix`];
        if (
          originalPlatformId &&
          draft.platformIds.has(platformId) &&
          (wasSelected || platformId === forceSelectPlatformId)
        ) {
          const version = douyinCurrentPlatformVersion(platformId, originalPlatformId);
          if (version && douyinVersionOptionAvailable(group, platformId, version)) {
            draft.selections[platformId][`${groupId}:${version}`] = {
              groupId,
              version,
            };
          }
        }
      }
      if (originalPlatformId) draft.douyinAssignments[groupId] = originalPlatformId;
      else delete draft.douyinAssignments[groupId];
    };
    const records = inventoryForPlatform(activePlatform.id, draft.douyinAssignments);
    const selectedItems = draft.selections[activePlatform.id] || {};
    const summary = inventorySelectionSummary(
      chosenPlatforms.map((platform) => ({
        platformId: platform.id,
        items: Object.values(draft.selections[platform.id] || {}),
      })).filter((selection) => selection.items.length),
    );
    const platformSelectionCounts = chosenPlatforms.map((platform) => ({
      platform,
      count: Object.keys(draft.selections[platform.id] || {}).length,
    }));
    layer.innerHTML = `<div class="modal-bg"><form class="modal platform-stock-task-modal"><button type="button" class="close">×</button><div class="task-stock-title"><div><h2>选择各平台库存视频</h2><p>每个平台独立选择；提取后会按平台建立文件夹。</p></div><button type="button" class="ghost back-platform-step">返回选择平台</button></div><div class="task-platform-tabs">${chosenPlatforms.map((platform) => {
      const selectedCount = Object.keys(draft.selections[platform.id] || {}).length;
      return `<button type="button" class="${platform.id === activePlatform.id ? "active" : ""}" data-stock-platform="${platform.id}">${platformOfficialLogoMarkup(platform)}<span>${esc(platform.name)}<small>已选 ${selectedCount}</small></span></button>`;
    }).join("")}</div><div class="platform-stock-list">${records.length ? records.map((record) => {
      const group = record.group;
      if (record.douyinAssignable) {
        const inferredVersion = record.originalPlatformId
          ? douyinCurrentPlatformVersion(activePlatform.id, record.originalPlatformId)
          : "";
        const selectedVersion =
          record.version ||
          (inferredVersion &&
          douyinVersionOptionAvailable(group, activePlatform.id, inferredVersion)
            ? inferredVersion
            : "");
        const selectionKey = selectedVersion ? `${group.id}:${selectedVersion}` : "";
        const checked = Boolean(selectionKey && selectedItems[selectionKey]);
        const otherOriginalPlatformId =
          activePlatform.id === "platform-1" ? "platform-2" : "platform-1";
        const selectValue = record.originalPlatformId || "";
        return `<label class="platform-stock-row douyin-version-row ${checked ? "selected" : ""} ${record.locked ? "locked" : ""}"><input type="checkbox" data-stock-group="${group.id}" data-stock-version="${selectedVersion}" ${checked ? "checked" : ""} ${selectedVersion ? "" : "disabled"}><div><span class="tag facelift">拉皮视频</span><b>${esc(group.title)}</b><small>${esc(group.code)} · ${record.locked ? "抖音归属已锁定" : selectedVersion ? `当前选择：${publishVersionLabel(selectedVersion)}` : "先选择本账号发原版还是二创"}</small></div><select data-douyin-group="${group.id}" data-douyin-version-choice ${record.locked ? "disabled" : ""}><option value="">选择本账号发布版本</option><option value="${activePlatform.id}" ${selectValue === activePlatform.id ? "selected" : ""} ${record.canOriginal ? "" : "disabled"}>本账号发原版</option><option value="${otherOriginalPlatformId}" ${selectValue === otherOriginalPlatformId ? "selected" : ""} ${record.canRemix ? "" : "disabled"}>本账号发二创</option></select></label>`;
      }
      const selectionKey = `${group.id}:${record.version}`;
      const checked = Boolean(selectedItems[selectionKey]);
      return `<label class="platform-stock-row ${checked ? "selected" : ""}"><input type="checkbox" data-stock-group="${group.id}" data-stock-version="${record.version}" ${checked ? "checked" : ""}><div><span class="tag ${group.category}">${group.category === "facelift" ? "拉皮视频" : "老而不衰"}</span><b>${esc(group.title)}</b><small>${esc(group.code)}</small></div><strong>${publishVersionLabel(record.version)}</strong></label>`;
    }).join("") : '<div class="empty"><b>这个平台没有可选库存</b>可能已经发布完成、视频被隐藏、仍在待剪辑或缺少成片。</div>'}</div><label class="allow-repeat"><input type="checkbox" id="task-allow-repeat" ${draft.allowRepeat ? "checked" : ""}>允许重复发布</label><div class="task-platform-selection-counts"><strong>各平台已选视频</strong><div>${platformSelectionCounts.map(({ platform, count }) => `<span data-selection-platform="${platform.id}" class="${count ? "has-selection" : ""}"><b>${esc(platform.name)}</b><i>${count} 条</i></span>`).join("")}</div></div><div class="task-selection-summary"><b>${summary.platforms}</b> 个平台已选视频 · <b>${summary.items}</b> 个发布版本 · <b>${summary.files}</b> 个文件 · 约 <b>${formatBytes(summary.bytes)}</b></div><div class="modal-actions"><button type="button" class="ghost cancel">取消</button><button class="primary">提取各平台素材并打开文件夹</button></div></form></div>`;
    const modal = layer.querySelector("form");
    const updateSelectionUi = () => {
      const selections = chosenPlatforms
        .map((platform) => ({
          platformId: platform.id,
          items: Object.values(draft.selections[platform.id] || {}),
        }))
        .filter((selection) => selection.items.length);
      const nextSummary = inventorySelectionSummary(selections);
      modal.querySelectorAll("[data-stock-platform]").forEach((button) => {
        const count = Object.keys(
          draft.selections[button.dataset.stockPlatform] || {},
        ).length;
        const countLabel = button.querySelector("small");
        if (countLabel) countLabel.textContent = `已选 ${count}`;
      });
      modal.querySelectorAll("[data-selection-platform]").forEach((item) => {
        const count = Object.keys(
          draft.selections[item.dataset.selectionPlatform] || {},
        ).length;
        item.classList.toggle("has-selection", count > 0);
        const countLabel = item.querySelector("i");
        if (countLabel) countLabel.textContent = `${count} 条`;
      });
      modal.querySelector(".task-selection-summary").innerHTML =
        `<b>${nextSummary.platforms}</b> 个平台已选视频 · ` +
        `<b>${nextSummary.items}</b> 个发布版本 · ` +
        `<b>${nextSummary.files}</b> 个文件 · 约 ` +
        `<b>${formatBytes(nextSummary.bytes)}</b>`;
    };
    modal.querySelector(".close").onclick = close;
    modal.querySelector(".cancel").onclick = close;
    protectTaskClickFromScroll(modal.querySelector(".back-platform-step"));
    modal.querySelector(".back-platform-step").onclick = () => withTaskModalScroll(() => {
      draft.step = 1;
      renderModal();
    }, modal.querySelector(".back-platform-step"));
    modal.querySelectorAll("[data-stock-platform]").forEach((button) => {
      protectTaskClickFromScroll(button);
      button.onclick = () => withTaskModalScroll(() => {
        draft.activePlatformId = button.dataset.stockPlatform;
        renderModal();
      }, button);
    });
    modal.querySelectorAll("[data-douyin-group]").forEach((select) => {
      protectTaskClickFromScroll(select);
      select.addEventListener("click", (event) => event.stopPropagation());
      select.addEventListener("mousedown", (event) => event.stopPropagation());
      select.onchange = () => withTaskModalScroll(() => {
        const groupId = select.dataset.douyinGroup;
        applyDraftDouyinAssignment(groupId, select.value, activePlatform.id);
        renderModal();
      }, select);
    });
    modal.querySelectorAll("[data-stock-group]").forEach((input) => {
      const row = input.closest(".platform-stock-row");
      const toggleStockSelection = (event) => {
        event?.preventDefault();
        event?.stopPropagation();
        withTaskModalScroll(() => {
          if (!input.dataset.stockVersion) {
            toast("请先选择本账号发原版还是二创");
            return;
          }
          draft.selections[activePlatform.id] ||= {};
          const selectionKey = `${input.dataset.stockGroup}:${input.dataset.stockVersion}`;
          const shouldSelect = !Boolean(draft.selections[activePlatform.id][selectionKey]);
          input.checked = shouldSelect;
          if (shouldSelect) {
            draft.selections[activePlatform.id][selectionKey] = {
              groupId: input.dataset.stockGroup,
              version: input.dataset.stockVersion,
            };
          } else {
            delete draft.selections[activePlatform.id][selectionKey];
          }
          row?.classList.toggle("selected", shouldSelect);
          updateSelectionUi();
        }, row || input);
      };
      protectTaskClickFromScroll(input);
      protectTaskClickFromScroll(row);
      input.addEventListener("click", toggleStockSelection);
      row?.addEventListener("click", toggleStockSelection);
    });
    protectTaskClickFromScroll(modal.querySelector("#task-allow-repeat"));
    modal.querySelector("#task-allow-repeat").onchange = (event) => withTaskModalScroll(() => {
      draft.allowRepeat = event.target.checked;
    }, event.target);
    modal.onsubmit = async (event) => {
      event.preventDefault();
      const platformSelections = chosenPlatforms.map((platform) => ({
        platformId: platform.id,
        items: Object.values(draft.selections[platform.id] || {}),
      })).filter((selection) => selection.items.length);
      if (!platformSelections.length) return toast("请为至少一个平台选择库存视频");
      const finalSummary = inventorySelectionSummary(platformSelections);
      let allowMissingCovers = false;
      if (finalSummary.missingCovers.length) {
        allowMissingCovers = await confirmAppDialog({
          kicker: "素材不完整",
          title: "部分封面缺失",
          message: `以下封面缺失：\n${finalSummary.missingCovers.join("\n")}\n\n是否只提取现有文件并继续？`,
          confirmLabel: "继续提取",
          tone: "warning",
        });
        if (!allowMissingCovers) return;
      }
      const submit = modal.querySelector(".modal-actions .primary");
      submit.disabled = true;
      submit.textContent = "正在创建并提取…";
      try {
        const result = await api("/api/publish-tasks", {
          method: "POST",
          body: JSON.stringify({
            platformSelections,
            douyinAssignments: draft.douyinAssignments,
            allowRepeat: draft.allowRepeat,
            allowMissingCovers,
          }),
        });
        state = await api("/api/state");
        close();
        showView("publish-tasks");
        render();
        toast(`任务已创建，正在按 ${result.task.platformIds.length} 个平台提取素材`);
      } catch (error) {
        toast(error.message);
        submit.disabled = false;
        submit.textContent = "提取各平台素材并打开文件夹";
      }
    };
    bindTaskModalScrollGuard();
    restoreScroll();
  };
  renderModal();
}

openCreatePublishTask = openPlatformInventoryTask;
const createPublishTaskButton = document.querySelector("#create-publish-task");
if (createPublishTaskButton) {
  createPublishTaskButton.onclick = launchPublishTaskFlow;
}

const CLIENT_VERSION = "2026.08.28.04";
let versionMismatchNotified = false;
window.setInterval(async () => {
  try {
    const health = await api("/api/health");
    if (health.version && health.version !== CLIENT_VERSION && !versionMismatchNotified) {
      versionMismatchNotified = true;
      toast("检测到后台服务版本较旧，请完全关闭后重新打开视频管理器");
    }
  } catch {}
}, 30000);


const showViewBeforeInventory = showView;
showView = function showViewWithInventory(view) {
  showViewBeforeInventory(view);
  document.querySelector("#inventory-view").classList.toggle("hidden", view !== "inventory");
  if (view === "inventory") {
    document.querySelector("#page-title").textContent = "发布库存";
    document.querySelector("#stats").classList.add("hidden");
    renderInventoryPage();
  }
};

document.querySelectorAll(".nav").forEach((button) => {
  if (button.dataset.category) {
    button.onclick = () => {
      operationalCategory = button.dataset.category;
      category = operationalCategory;
      videoVisibility = "visible";
      showView("library");
      document.querySelectorAll(".nav").forEach((item) => item.classList.toggle("active", item === button));
      renderOperationalVideoList();
      renderVisibilityTabs();
    };
  } else if (button.dataset.view) {
    button.onclick = () => {
      if (button.dataset.view === "library") {
        operationalCategory = "all";
        category = "all";
        videoVisibility = "visible";
      }
      showView(button.dataset.view);
      renderVisibilityTabs();
    };
  }
});

const renderBeforeOperationalViews = render;
render = function renderWithOperationalViews() {
  state.groups.forEach((group) => {
    group.hidden = Boolean(group.hidden);
  });
  renderBeforeOperationalViews();
  const visibleGroups = state.groups.filter(
    (group) => !group.hidden && groupHasLibraryAsset(group),
  );
  document.querySelector("#nav-count").textContent = visibleGroups.length;
  document.querySelector("#facelift-count").textContent = visibleGroups.filter((group) => group.category === "facelift").length;
  document.querySelector("#ageless-count").textContent = visibleGroups.filter((group) => group.category === "ageless").length;
  refreshLibraryStats();
  renderVisibilityTabs();
  renderInventoryPage();
};

SLOT_LABELS.original_video_part2 = "原始视频后半段1（可选）";
SLOT_LABELS.original_video_part3 = "原始视频后半段2（可选）";

function candidateHasMaterialForSlot(candidate, slot) {
  return Boolean(candidate.slots?.[slot]) ||
    (candidate.files || []).some((file) => file.slot === slot);
}

function hideEmptyCandidateSlots(article, candidate) {
  const grid = article.querySelector(".slot-grid");
  if (!grid) return;
  grid.querySelectorAll(".slot").forEach((slotCard) => {
    const slot = slotCard.querySelector("[data-slot]")?.dataset.slot;
    if (slot && !candidateHasMaterialForSlot(candidate, slot)) {
      slotCard.remove();
    }
  });
}

const renderCandidatesBeforeExtraParts = renderCandidates;
renderCandidates = function renderCandidatesWithExtraParts() {
  renderCandidatesBeforeExtraParts();
  candidates.forEach((candidate, index) => {
    const article = document.querySelector(`.candidate[data-index="${index}"]`);
    if (article && candidate.autoImportError && !article.querySelector(".auto-import-error")) {
      article
        .querySelector(".candidate-top")
        ?.insertAdjacentHTML(
          "afterend",
          `<div class="auto-import-error">自动归组失败，已保留供人工确认：${esc(candidate.autoImportError)}</div>`,
        );
    }
    if (!article) return;
    hideEmptyCandidateSlots(article, candidate);
    ["third_video", "third_cover_landscape", "third_cover_portrait"].forEach((slot) => {
      if (article.querySelector(`[data-slot="${slot}"]`)) return;
      const thirdFiles = candidate.files.filter((file) => file.slot === slot);
      if (!thirdFiles.length && !candidate.slots?.[slot]) return;
      const thirdLabel = document.createElement("label");
      thirdLabel.className = "slot";
      thirdLabel.innerHTML = `<strong>${SLOT_LABELS[slot]}（可选）</strong><select data-slot="${slot}"><option value="">未关联</option>${candidate.files.map((file) => `<option value="${file.id}" ${candidate.slots?.[slot]?.id === file.id ? "selected" : ""}>${esc(file.filename)}</option>`).join("")}</select>`;
      article.querySelector(".slot-grid").append(thirdLabel);
    });
    if (article.querySelector('[data-slot="original_video_part3"]')) return;
    const part3Files = candidate.files.filter(
      (file) => file.slot === "original_video_part3",
    );
    if (!part3Files.length && !candidate.slots?.original_video_part3) return;
    const label = document.createElement("label");
    label.className = "slot";
    label.innerHTML = `<strong>原始视频后半段2（可选）</strong><select data-slot="original_video_part3"><option value="">未关联</option>${candidate.files.map((file) => `<option value="${file.id}" ${candidate.slots?.original_video_part3?.id === file.id ? "selected" : ""}>${esc(file.filename)}</option>`).join("")}</select>`;
    article.querySelector(".slot-grid").append(label);
    hideEmptyCandidateSlots(article, candidate);
  });
};

const openDrawerBeforeCompactAssets = openDrawer;
openDrawer = function openDrawerWithCompactAssets(id, rerender = false) {
  const group = state.groups.find((item) => item.id === id);
  if (!group) return;
  const allPlatforms = state.platforms;
  const eligiblePlatforms = allPlatforms.filter((platform) =>
    platform.active && platformAcceptsGroup(platform, group),
  );
  state.platforms = eligiblePlatforms;
  try {
    openDrawerBeforeCompactAssets(id, rerender);
  } finally {
    state.platforms = allPlatforms;
  }
  if (group.workflowStatus === "pending_edit") {
    const tag = document.querySelector(".drawer > header .tag");
    tag?.insertAdjacentHTML("afterend", '<span class="tag pending-edit">待剪辑</span>');
    const matrixTitle = [...document.querySelectorAll(".drawer .section-title h2")]
      .find((title) => title.textContent.trim() === "发布矩阵");
    matrixTitle?.closest(".section")?.remove();
  }
  const assetGrid = document.querySelector(".drawer .asset-grid");
  if (assetGrid) {
    [...assetGrid.querySelectorAll(".asset")].forEach((card, index) => {
      const slot = SLOTS[index];
      if (!group.assets?.[slot]) card.remove();
    });
    const part3 = group.assets?.original_video_part3;
    if (part3) {
      const media = `/media?path=${encodeURIComponent(part3.path)}`;
      const card = document.createElement("article");
      card.className = "asset";
      card.innerHTML = `<div class="asset-preview"><video src="${media}" preload="metadata" muted></video></div><b>原始视频后半段2（可选）</b><small>${esc(part3.filename)}</small><div class="asset-actions"><button data-extra-preview>预览</button><button data-extra-open>打开位置</button></div>`;
      assetGrid.append(card);
      card.querySelector("[data-extra-preview]").onclick = () =>
        previewAsset(part3, "original_video_part3");
      card.querySelector("[data-extra-open]").onclick = () =>
        api("/api/open", {
          method: "POST",
          body: JSON.stringify({ path: part3.path, kind: "folder" }),
        }).catch((error) => toast(error.message));
    }
    ["third_video", "third_cover_landscape", "third_cover_portrait"].forEach((slot) => {
      const asset = group.assets?.[slot];
      if (!asset || assetGrid.querySelector(`[data-extra-slot="${slot}"]`)) return;
      const media = `/media?path=${encodeURIComponent(asset.path)}`;
      const card = document.createElement("article");
      card.className = "asset";
      card.dataset.extraSlot = slot;
      card.innerHTML = `<div class="asset-preview">${slot.includes("video") ? `<video src="${media}" preload="metadata" muted></video>` : `<img src="${media}">`}</div><b>${SLOT_LABELS[slot]}</b><small>${esc(asset.filename)}</small><div class="asset-actions"><button data-extra-preview>预览</button><button data-extra-open>打开位置</button></div>`;
      assetGrid.append(card);
      card.querySelector("[data-extra-preview]").onclick = () =>
        previewAsset(asset, slot);
      card.querySelector("[data-extra-open]").onclick = () =>
        api("/api/open", {
          method: "POST",
          body: JSON.stringify({ path: asset.path, kind: "folder" }),
        }).catch((error) => toast(error.message));
    });
    if (!assetGrid.children.length) {
      assetGrid.innerHTML = '<div class="compact-assets-empty">尚未关联任何素材文件</div>';
    }
  }
  const materialTitle = [...document.querySelectorAll(".drawer .section-title h2")]
    .find((title) => title.textContent.trim() === "素材文件");
  const materialHint = materialTitle?.closest(".section-title")?.querySelector("span");
  if (materialHint) {
    materialHint.textContent = `${availableMaterialCount(group)} 个素材已关联`;
  }
  const platforms = eligiblePlatforms;
  const matrix = document.querySelector(".drawer .matrix");
  if (matrix) {
    matrix.querySelectorAll(".matrix-row").forEach((row) => {
      const markButton = row.querySelector("[data-mark]");
      if (!markButton) return;
      const [version] = markButton.dataset.mark.split("|");
      if (!publishVersionAssets(group, version).hasVideo) row.remove();
    });
    if (
      publishVersionAssets(group, "third").hasVideo &&
      !matrix.querySelector('[data-mark^="third|"]')
    ) {
      matrix.insertAdjacentHTML(
        "beforeend",
        `<div class="matrix-row"><span>${publishVersionMatrixLabel("third")}</span>${platforms.map((platform) => publishTargetApplies(group, "third", platform) ? `<button class="check ${group.publishMarks?.[markKey("third", platform.id)] ? "on" : ""}" data-mark="third|${platform.id}">${group.publishMarks?.[markKey("third", platform.id)] ? "✓" : ""}</button>` : '<button class="check not-applicable" type="button" disabled>不发</button>').join("")}</div>`,
      );
      const matrixHint = [...document.querySelectorAll(".drawer .section-title span")]
        .find((item) => item.textContent.includes("原版与二创"));
      if (matrixHint) matrixHint.textContent = "原版、二创与三创分别记录";
    }
    matrix.querySelectorAll("[data-mark]").forEach((button) => {
      const [version, platformId] = button.dataset.mark.split("|");
      const platform = platforms.find((item) => item.id === platformId);
      if (publishTargetApplies(group, version, platform)) return;
      const disabled = document.createElement("button");
      disabled.type = "button";
      disabled.disabled = true;
      disabled.className = "check not-applicable";
      disabled.textContent = "不发";
      disabled.title = "按抖音账号归属规则，本格不计入发布进度";
      button.replaceWith(disabled);
    });
    const platformColumnWidth = 112;
    const minWidth = Math.max(660, 92 + platforms.length * platformColumnWidth);
    const columns = `92px repeat(${platforms.length}, ${platformColumnWidth}px)`;
    matrix.style.setProperty("--matrix-min-width", `${minWidth}px`);
    matrix.style.setProperty("--matrix-platform-count", platforms.length);
    matrix.querySelectorAll(".matrix-row").forEach((row) => {
      row.style.width = `${minWidth}px`;
      row.style.minWidth = `${minWidth}px`;
      row.style.gridTemplateColumns = columns;
    });
  }
  document.querySelectorAll(".drawer [data-mark]").forEach((button) => {
    button.onclick = async () => {
      const scrollState = captureScrollState();
      const [version, platformId] = button.dataset.mark.split("|");
      const key = markKey(version, platformId);
      const nextValue = !group.publishMarks?.[key];
      if (
        nextValue &&
        group.category === "facelift" &&
        DOUYIN_PLATFORM_IDS.includes(platformId) &&
        ["original", "remix"].includes(version)
      ) {
        const originalPlatformId = effectiveDouyinOriginalPlatform(group);
        const proposedOriginalPlatformId =
          version === "original"
            ? platformId
            : platformId === "platform-1"
              ? "platform-2"
              : "platform-1";
        if (originalPlatformId && originalPlatformId !== proposedOriginalPlatformId) {
          toast(
            `${group.title} 的抖音版本已经分配，本账号只能发布${
              platformId === originalPlatformId ? "原版" : "二创"
            }`,
          );
          return;
        }
        group.douyinOriginalPlatformId = proposedOriginalPlatformId;
      }
      group.publishMarks ||= {};
      group.publishMarkTimes ||= {};
      group.publishMarks[key] = nextValue;
      if (nextValue) {
        const publishedAt = new Date().toISOString();
        group.publishMarkTimes[key] = publishedAt;
        state.publishHistory ??= [];
        state.publishHistory.push({
          id: crypto.randomUUID(),
          groupId: group.id,
          version,
          platformId,
          publishedAt,
          source: "manual",
        });
        if (
          group.category === "facelift" &&
          DOUYIN_PLATFORM_IDS.includes(platformId)
        ) {
          group.douyinAssignmentLockedAt ||= publishedAt;
        }
      } else {
        delete group.publishMarkTimes[key];
      }
      group.updatedAt = new Date().toISOString();
      await save();
      restoreScrollState(scrollState);
    };
  });
  const danger = document.querySelector(".drawer .danger");
  if (danger && !document.querySelector(".drawer [data-detail-toggle-hidden]")) {
    const hiddenButton = document.createElement("button");
    hiddenButton.type = "button";
    hiddenButton.className = "detail-hide-video";
    hiddenButton.dataset.detailToggleHidden = group.id;
    hiddenButton.textContent = group.hidden ? "恢复到展示视频" : "隐藏这条视频";
    hiddenButton.onclick = async () => {
      const scrollState = captureScrollState();
      group.hidden = !group.hidden;
      group.hiddenAt = group.hidden ? new Date().toISOString() : "";
      await save();
      restoreScrollState(scrollState);
      toast(group.hidden ? "视频已隐藏" : "视频已恢复展示");
    };
    danger.before(hiddenButton);
  }
};

const renderBeforeScrollPreservation = render;
render = function renderWithScrollPreservation(...args) {
  const scrollState = captureScrollState();
  const result = renderBeforeScrollPreservation(...args);
  restoreScrollState(scrollState);
  return result;
};

const THEME_STORAGE_KEY = "video-manager-theme";
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(mode, persist = true) {
  const normalizedMode = ["system", "light", "dark"].includes(mode)
    ? mode
    : "system";
  const resolvedTheme = normalizedMode === "system"
    ? (systemThemeQuery.matches ? "dark" : "light")
    : normalizedMode;
  document.documentElement.dataset.themeMode = normalizedMode;
  document.documentElement.dataset.theme = resolvedTheme;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === normalizedMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  window.videoManagerWindow?.setTitleBarTheme(resolvedTheme);
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, normalizedMode);
}

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.onclick = () => applyTheme(button.dataset.themeChoice);
});

systemThemeQuery.addEventListener("change", () => {
  if ((localStorage.getItem(THEME_STORAGE_KEY) || "light") === "system") {
    applyTheme("system", false);
  }
});

applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || "light", false);

const closeWindowModal = document.querySelector("#close-window-modal");
const closeWindowTrayButton = document.querySelector("#close-window-tray");
const closeWindowQuitButton = document.querySelector("#close-window-quit");
const closeWindowCancelButton = document.querySelector("#close-window-cancel");
const closeWindowDismissButton = document.querySelector("#close-window-dismiss");

function setCloseWindowModalVisible(visible) {
  if (!closeWindowModal) return;
  closeWindowModal.classList.toggle("hidden", !visible);
  closeWindowModal.setAttribute("aria-hidden", String(!visible));
  if (visible) window.setTimeout(() => closeWindowTrayButton?.focus(), 0);
}

function respondToWindowClose(choice) {
  setCloseWindowModalVisible(false);
  window.videoManagerWindow?.respondToClose(choice);
}

window.videoManagerWindow?.onCloseRequested(() => {
  setCloseWindowModalVisible(true);
});

closeWindowTrayButton?.addEventListener("click", () => respondToWindowClose("tray"));
closeWindowQuitButton?.addEventListener("click", () => respondToWindowClose("quit"));
closeWindowCancelButton?.addEventListener("click", () => respondToWindowClose("cancel"));
closeWindowDismissButton?.addEventListener("click", () => respondToWindowClose("cancel"));
closeWindowModal?.addEventListener("click", (event) => {
  if (event.target === closeWindowModal) respondToWindowClose("cancel");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && closeWindowModal && !closeWindowModal.classList.contains("hidden")) {
    event.preventDefault();
    respondToWindowClose("cancel");
  }
});
