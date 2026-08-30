"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Category = "facelift" | "ageless";
type Version = "original" | "remix";
type AssetSlot =
  | "original_video"
  | "original_video_part2"
  | "edited_video"
  | "original_cover_landscape"
  | "original_cover_portrait"
  | "remix_video"
  | "remix_cover_landscape"
  | "remix_cover_portrait";

type Platform = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
};

type Asset = {
  id: string;
  slot: AssetSlot;
  path: string;
  filename: string;
  size: number;
  modifiedAt: string;
  width?: number;
  height?: number;
  duration?: number;
  available: boolean;
  thumbnail?: string;
};

type VideoGroup = {
  id: string;
  category: Category;
  code: string;
  title: string;
  notes: string;
  assets: Partial<Record<AssetSlot, Asset>>;
  publishMarks: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
};

type ScanSource = {
  id: string;
  path: string;
  lastScannedAt?: string;
};

type AppState = {
  groups: VideoGroup[];
  platforms: Platform[];
  sources: ScanSource[];
  updatedAt: string;
};

const DEFAULT_PLATFORMS = [
  "抖音1号",
  "抖音2号",
  "视频号",
  "搜狐号",
  "小红书",
  "百家号",
  "哔哩哔哩",
  "微博号",
];

const SLOT_LABELS: Record<AssetSlot, string> = {
  original_video: "原始视频前半段",
  original_video_part2: "原始视频后半段（可选）",
  edited_video: "原版字幕成片",
  original_cover_landscape: "原版横封面",
  original_cover_portrait: "原版竖封面",
  remix_video: "二创视频",
  remix_cover_landscape: "二创横封面",
  remix_cover_portrait: "二创竖封面",
};

const EMPTY_STATE: AppState = {
  groups: [],
  platforms: DEFAULT_PLATFORMS.map((name, index) => ({
    id: `platform-${index + 1}`,
    name,
    sortOrder: index,
    active: true,
  })),
  sources: [],
  updatedAt: new Date(0).toISOString(),
};

const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function markKey(version: Version, platformId: string) {
  return `${version}:${platformId}`;
}

function nextCode(groups: VideoGroup[], category: Category) {
  const prefix = category === "facelift" ? "LP" : "LS";
  const max = groups
    .filter((group) => group.category === category)
    .map((group) => Number(group.code.replace(/\D/g, "")) || 0)
    .reduce((a, b) => Math.max(a, b), 0);
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

function completeness(group: VideoGroup) {
  const requiredSlots = (Object.keys(SLOT_LABELS) as AssetSlot[]).filter(
    (slot) => slot !== "original_video_part2",
  );
  const complete = requiredSlots.filter(
    (slot) => group.assets[slot]?.available,
  ).length;
  return { complete, percent: Math.round((complete / 7) * 100) };
}

function publishProgress(group: VideoGroup, platforms: Platform[]) {
  const active = platforms.filter((platform) => platform.active);
  const total = active.length * 2;
  const done = active.reduce(
    (sum, platform) =>
      sum +
      Number(Boolean(group.publishMarks[markKey("original", platform.id)])) +
      Number(Boolean(group.publishMarks[markKey("remix", platform.id)])),
    0,
  );
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export default function VideoManager() {
  const [state, setState] = useState<AppState>(EMPTY_STATE);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [category, setCategory] = useState<Category | "all">("all");
  const [query, setQuery] = useState("");
  const [assetFilter, setAssetFilter] = useState<"all" | "complete" | "missing">(
    "all",
  );
  const [publishFilter, setPublishFilter] = useState<
    "all" | "unpublished" | "complete"
  >("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"group" | "settings" | null>(null);
  const [toast, setToast] = useState("");
  const [localConnected, setLocalConnected] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("load failed");
      const data = (await response.json()) as AppState;
      setState(data);
    } catch {
      setState(EMPTY_STATE);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    fetch("http://127.0.0.1:47128/api/health", { mode: "cors" })
      .then((response) => {
        if (response.ok) setLocalConnected(true);
      })
      .catch(() => setLocalConnected(false));
  }, [load]);

  const persist = useCallback(async (next: AppState) => {
    const payload = { ...next, updatedAt: new Date().toISOString() };
    setState(payload);
    setSaveState("saving");
    try {
      const response = await fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("save failed");
      if (localConnected) {
        await fetch("http://127.0.0.1:47128/api/state", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => undefined);
      }
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } catch {
      setSaveState("error");
    }
  }, [localConnected]);

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return state.groups.filter((group) => {
      if (category !== "all" && group.category !== category) return false;
      if (
        keyword &&
        !`${group.code} ${group.title} ${group.notes}`
          .toLowerCase()
          .includes(keyword)
      )
        return false;
      const asset = completeness(group);
      if (assetFilter === "complete" && asset.complete !== 7) return false;
      if (assetFilter === "missing" && asset.complete === 7) return false;
      const publishing = publishProgress(group, state.platforms);
      if (publishFilter === "complete" && publishing.done !== publishing.total)
        return false;
      if (publishFilter === "unpublished" && publishing.done === publishing.total)
        return false;
      return true;
    });
  }, [state, category, query, assetFilter, publishFilter]);

  const selected =
    state.groups.find((group) => group.id === selectedId) ?? null;

  const stats = useMemo(() => {
    const completeAssets = state.groups.filter(
      (group) => completeness(group).complete === 7,
    ).length;
    const published = state.groups.filter((group) => {
      const progress = publishProgress(group, state.platforms);
      return progress.total > 0 && progress.done === progress.total;
    }).length;
    const totalMarks = state.groups.reduce(
      (sum, group) => sum + publishProgress(group, state.platforms).done,
      0,
    );
    return { completeAssets, published, totalMarks };
  }, [state]);

  function addGroup(form: FormData) {
    const groupCategory = form.get("category") as Category;
    const now = new Date().toISOString();
    const group: VideoGroup = {
      id: uid(),
      category: groupCategory,
      code:
        String(form.get("code") || "").trim() ||
        nextCode(state.groups, groupCategory),
      title: String(form.get("title") || "").trim() || "未命名视频",
      notes: String(form.get("notes") || "").trim(),
      assets: {},
      publishMarks: {},
      createdAt: now,
      updatedAt: now,
    };
    void persist({ ...state, groups: [group, ...state.groups] });
    setSelectedId(group.id);
    setDialog(null);
    setToast("视频记录已创建");
  }

  function updateGroup(patch: Partial<VideoGroup>) {
    if (!selected) return;
    void persist({
      ...state,
      groups: state.groups.map((group) =>
        group.id === selected.id
          ? { ...group, ...patch, updatedAt: new Date().toISOString() }
          : group,
      ),
    });
  }

  function togglePublish(version: Version, platformId: string) {
    if (!selected) return;
    const key = markKey(version, platformId);
    updateGroup({
      publishMarks: {
        ...selected.publishMarks,
        [key]: !selected.publishMarks[key],
      },
    });
  }

  function deleteSelected() {
    if (!selected) return;
    if (!window.confirm(`确定删除“${selected.title}”的管理记录吗？原文件不会被删除。`))
      return;
    void persist({
      ...state,
      groups: state.groups.filter((group) => group.id !== selected.id),
    });
    setSelectedId(null);
    setToast("管理记录已删除，原文件未受影响");
  }

  async function mergeLocal() {
    try {
      const response = await fetch("http://127.0.0.1:47128/api/state");
      if (!response.ok) throw new Error();
      const local = (await response.json()) as AppState;
      const byId = new Map(state.groups.map((group) => [group.id, group]));
      for (const group of local.groups) {
        const current = byId.get(group.id);
        if (!current || group.updatedAt > current.updatedAt) byId.set(group.id, group);
      }
      const platforms = local.platforms.length ? local.platforms : state.platforms;
      await persist({
        ...state,
        groups: [...byId.values()],
        platforms,
        sources: local.sources,
      });
      setToast("本机记录已合并");
    } catch {
      setToast("未连接到本机桌面版");
    }
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `视频管理器备份-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function importBackup(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as AppState;
      if (!Array.isArray(parsed.groups) || !Array.isArray(parsed.platforms))
        throw new Error();
      await persist({ ...parsed, updatedAt: new Date().toISOString() });
      setToast("备份恢复完成");
    } catch {
      setToast("备份文件无法识别");
    }
  }

  if (!loaded) {
    return (
      <main className="loading-screen">
        <div className="loading-mark">影</div>
        <p>正在整理你的内容工作台…</p>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">影</div>
          <div>
            <strong>视频素材管理器</strong>
            <span>素材到发布，一目了然</span>
          </div>
        </div>
        <nav aria-label="内容分类">
          {[
            ["all", "总览", state.groups.length],
            [
              "facelift",
              "拉皮视频",
              state.groups.filter((group) => group.category === "facelift").length,
            ],
            [
              "ageless",
              "老而不衰视频",
              state.groups.filter((group) => group.category === "ageless").length,
            ],
          ].map(([value, label, count]) => (
            <button
              key={String(value)}
              className={category === value ? "nav-item active" : "nav-item"}
              onClick={() => setCategory(value as Category | "all")}
            >
              <span>{label}</span>
              <em>{count}</em>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setDialog("settings")}>
            <span>设置与备份</span><em>⌘</em>
          </button>
          <div className="connection">
            <i className={localConnected ? "online" : ""} />
            {localConnected ? "本机素材已连接" : "当前为在线记录模式"}
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">CONTENT LIBRARY</p>
            <h1>{category === "all" ? "内容总览" : category === "facelift" ? "拉皮视频" : "老而不衰视频"}</h1>
          </div>
          <div className="top-actions">
            {localConnected && (
              <button className="button ghost" onClick={mergeLocal}>同步本机记录</button>
            )}
            <span className={`save-state ${saveState}`}>{saveState === "saving" ? "保存中…" : saveState === "error" ? "保存失败" : "已自动保存"}</span>
            <button className="button primary" onClick={() => setDialog("group")}>＋ 新建视频</button>
          </div>
        </header>

        <section className="stats-grid" aria-label="总览统计">
          <article className="stat-card warm">
            <span>全部视频组</span><strong>{state.groups.length}</strong><small>两大内容分类</small>
          </article>
          <article className="stat-card">
            <span>素材已齐全</span><strong>{stats.completeAssets}</strong><small>七项必需素材完整</small>
          </article>
          <article className="stat-card">
            <span>全平台完成</span><strong>{stats.published}</strong><small>原版与二创均完成</small>
          </article>
          <article className="stat-card">
            <span>累计发布</span><strong>{stats.totalMarks}</strong><small>平台发布勾选</small>
          </article>
        </section>

        <section className="filter-row">
          <label className="search">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、编号或备注" />
          </label>
          <select value={assetFilter} onChange={(event) => setAssetFilter(event.target.value as typeof assetFilter)}>
            <option value="all">全部素材状态</option>
            <option value="complete">素材完整</option>
            <option value="missing">素材缺失</option>
          </select>
          <select value={publishFilter} onChange={(event) => setPublishFilter(event.target.value as typeof publishFilter)}>
            <option value="all">全部发布状态</option>
            <option value="unpublished">尚未全部发布</option>
            <option value="complete">已全平台完成</option>
          </select>
        </section>

        <section className="content-panel">
          <div className="panel-heading">
            <div><h2>视频清单</h2><span>共 {groups.length} 条</span></div>
            <span className="hint">点击一条记录查看素材与发布矩阵</span>
          </div>
          {groups.length === 0 ? (
            <div className="empty-state">
              <div>◫</div>
              <h3>{state.groups.length ? "没有符合筛选条件的内容" : "从第一条视频开始"}</h3>
              <p>{state.groups.length ? "尝试调整分类或筛选条件。" : "新建记录，或从本机桌面版扫描素材目录。"}</p>
              {!state.groups.length && <button className="button primary" onClick={() => setDialog("group")}>新建视频记录</button>}
            </div>
          ) : (
            <div className="video-list">
              {groups.map((group) => {
                const assets = completeness(group);
                const publishing = publishProgress(group, state.platforms);
                return (
                  <button className="video-row" key={group.id} onClick={() => setSelectedId(group.id)}>
                    <div className="row-cover">
                      {group.assets.original_cover_landscape?.thumbnail ? (
                        <img src={group.assets.original_cover_landscape.thumbnail} alt="" />
                      ) : <span>{group.category === "facelift" ? "拉" : "老"}</span>}
                    </div>
                    <div className="row-main">
                      <span className={`category-tag ${group.category}`}>{group.category === "facelift" ? "拉皮视频" : "老而不衰"}</span>
                      <h3>{group.title}</h3>
                      <p>{group.code} · {group.notes || "暂无备注"}</p>
                    </div>
                    <div className="progress-block">
                      <span>素材 {assets.complete}/7</span>
                      <div><i style={{ width: `${assets.percent}%` }} /></div>
                    </div>
                    <div className="progress-block publish">
                      <span>发布 {publishing.done}/{publishing.total}</span>
                      <div><i style={{ width: `${publishing.percent}%` }} /></div>
                    </div>
                    <span className="chevron">›</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </section>

      {selected && (
        <div className="drawer-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSelectedId(null);
        }}>
          <aside className="detail-drawer" aria-label="视频详情">
            <header>
              <div>
                <span className={`category-tag ${selected.category}`}>{selected.category === "facelift" ? "拉皮视频" : "老而不衰"}</span>
                <h2>{selected.title}</h2>
                <p>{selected.code}</p>
              </div>
              <button className="icon-button" onClick={() => setSelectedId(null)} aria-label="关闭">×</button>
            </header>
            <div className="drawer-scroll">
              <section className="detail-section">
                <div className="section-title"><h3>基本信息</h3><span>自动保存</span></div>
                <div className="form-grid">
                  <label><span>标题</span><input value={selected.title} onChange={(event) => updateGroup({ title: event.target.value })} /></label>
                  <label><span>编号</span><input value={selected.code} onChange={(event) => updateGroup({ code: event.target.value })} /></label>
                  <label className="wide"><span>备注</span><textarea value={selected.notes} onChange={(event) => updateGroup({ notes: event.target.value })} placeholder="记录选题、人物或剪辑说明" /></label>
                </div>
              </section>
              <section className="detail-section">
                <div className="section-title"><h3>素材文件</h3><span>{completeness(selected).complete}/7 项必需素材已就绪</span></div>
                <div className="asset-grid">
                  {(Object.keys(SLOT_LABELS) as AssetSlot[]).map((slot) => {
                    const asset = selected.assets[slot];
                    return (
                      <article className={asset?.available ? "asset-card ready" : "asset-card"} key={slot}>
                        <div className="asset-preview">
                          {asset?.thumbnail ? <img src={asset.thumbnail} alt="" /> : <span>{slot.includes("video") ? "▶" : "▧"}</span>}
                        </div>
                        <div><strong>{SLOT_LABELS[slot]}</strong><small>{asset ? asset.filename : "尚未关联文件"}</small></div>
                        <i>{asset?.available ? "已就绪" : "缺失"}</i>
                      </article>
                    );
                  })}
                </div>
                {!localConnected && <p className="notice">素材文件只保存在你的电脑上。请打开桌面版扫描、关联或预览原文件。</p>}
              </section>
              <section className="detail-section">
                <div className="section-title"><h3>发布矩阵</h3><span>原版与二创分开记录</span></div>
                <div className="publish-table">
                  <div className="publish-head"><span>版本</span>{state.platforms.filter((p) => p.active).map((p) => <strong key={p.id}>{p.name}</strong>)}</div>
                  {(["original", "remix"] as Version[]).map((version) => (
                    <div className="publish-line" key={version}>
                      <span>{version === "original" ? "原视频" : "二创视频"}</span>
                      {state.platforms.filter((p) => p.active).map((platform) => {
                        const checked = Boolean(selected.publishMarks[markKey(version, platform.id)]);
                        return <button className={checked ? "publish-check checked" : "publish-check"} onClick={() => togglePublish(version, platform.id)} key={platform.id} aria-label={`${platform.name}${checked ? "取消发布" : "标记已发布"}`}>{checked ? "✓" : ""}</button>;
                      })}
                    </div>
                  ))}
                </div>
              </section>
              <button className="danger-button" onClick={deleteSelected}>删除这条管理记录</button>
            </div>
          </aside>
        </div>
      )}

      {dialog === "group" && (
        <div className="modal-backdrop">
          <form className="modal" action={addGroup}>
            <div className="modal-heading"><div><p className="eyebrow">NEW RECORD</p><h2>新建视频记录</h2></div><button type="button" className="icon-button" onClick={() => setDialog(null)}>×</button></div>
            <label><span>内容分类</span><select name="category" defaultValue={category === "ageless" ? "ageless" : "facelift"}><option value="facelift">拉皮视频</option><option value="ageless">老而不衰视频</option></select></label>
            <label><span>标题</span><input name="title" required autoFocus placeholder="例如：院长讲面部松弛的三个层次" /></label>
            <label><span>编号（可留空自动生成）</span><input name="code" placeholder="LP-0001" /></label>
            <label><span>备注</span><textarea name="notes" placeholder="选题来源、剪辑要求或发布说明" /></label>
            <div className="modal-actions"><button type="button" className="button ghost" onClick={() => setDialog(null)}>取消</button><button className="button primary">创建记录</button></div>
          </form>
        </div>
      )}

      {dialog === "settings" && (
        <div className="modal-backdrop">
          <div className="modal settings-modal">
            <div className="modal-heading"><div><p className="eyebrow">SETTINGS</p><h2>设置与备份</h2></div><button className="icon-button" onClick={() => setDialog(null)}>×</button></div>
            <section><div className="section-title"><h3>发布账号</h3><span>可改名、排序或停用</span></div>
              <div className="platform-list">
                {state.platforms.map((platform) => <div key={platform.id}><input value={platform.name} onChange={(event) => void persist({...state, platforms: state.platforms.map((item) => item.id === platform.id ? {...item, name: event.target.value} : item)})} /><button className={platform.active ? "status-pill active" : "status-pill"} onClick={() => void persist({...state, platforms: state.platforms.map((item) => item.id === platform.id ? {...item, active: !item.active} : item)})}>{platform.active ? "使用中" : "已停用"}</button></div>)}
              </div>
              <button className="button ghost full" onClick={() => void persist({...state, platforms: [...state.platforms, {id: uid(), name: `新平台${state.platforms.length + 1}`, sortOrder: state.platforms.length, active: true}]})}>＋ 添加发布账号</button>
            </section>
            <section><div className="section-title"><h3>数据备份</h3><span>JSON 格式，可完整恢复</span></div>
              <div className="backup-actions"><button className="button ghost" onClick={exportBackup}>导出备份</button><label className="button ghost file-button">恢复备份<input type="file" accept=".json,application/json" onChange={(event) => event.target.files?.[0] && void importBackup(event.target.files[0])} /></label></div>
            </section>
          </div>
        </div>
      )}
      {toast && <button className="toast" onClick={() => setToast("")}>{toast}</button>}
    </main>
  );
}
