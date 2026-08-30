import {
  handleImageOptimization,
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Platform = {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
};
type Asset = {
  id: string;
  slot: string;
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
  category: string;
  code: string;
  title: string;
  notes: string;
  assets: Record<string, Asset>;
  publishMarks: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
};
type ScanSource = { id: string; path: string; lastScannedAt?: string };
type AppState = {
  groups: VideoGroup[];
  platforms: Platform[];
  sources: ScanSource[];
  updatedAt: string;
};
type Row = Record<string, unknown>;

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

function json(data: unknown, status = 200, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function ownerFor(request: Request) {
  const email = request.headers.get("oai-authenticated-user-email");
  if (email) return email.toLowerCase();
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    return "local-preview@video-manager";
  return null;
}

async function ensureSchema(db: D1Database) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS video_groups (
      owner TEXT NOT NULL, id TEXT NOT NULL, category TEXT NOT NULL,
      code TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, id)
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS video_groups_owner_category_code
      ON video_groups(owner, category, code)`,
    `CREATE TABLE IF NOT EXISTS assets (
      owner TEXT NOT NULL, id TEXT NOT NULL, group_id TEXT NOT NULL,
      slot TEXT NOT NULL, path TEXT NOT NULL, filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0, modified_at TEXT NOT NULL,
      width INTEGER, height INTEGER, duration INTEGER,
      available INTEGER NOT NULL DEFAULT 1, thumbnail TEXT,
      PRIMARY KEY (owner, id)
    )`,
    `CREATE INDEX IF NOT EXISTS assets_owner_group ON assets(owner, group_id)`,
    `CREATE TABLE IF NOT EXISTS platform_accounts (
      owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (owner, id)
    )`,
    `CREATE TABLE IF NOT EXISTS publish_marks (
      owner TEXT NOT NULL, group_id TEXT NOT NULL, version TEXT NOT NULL,
      platform_id TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, group_id, version, platform_id)
    )`,
    `CREATE TABLE IF NOT EXISTS scan_sources (
      owner TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL,
      last_scanned_at TEXT, PRIMARY KEY (owner, id)
    )`,
    `CREATE TABLE IF NOT EXISTS sync_metadata (
      owner TEXT PRIMARY KEY, updated_at TEXT NOT NULL
    )`,
  ];
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

async function readState(db: D1Database, owner: string): Promise<AppState> {
  await ensureSchema(db);
  const [groupsResult, assetsResult, platformsResult, marksResult, sourcesResult, metaResult] =
    await db.batch([
      db.prepare("SELECT * FROM video_groups WHERE owner = ? ORDER BY updated_at DESC").bind(owner),
      db.prepare("SELECT * FROM assets WHERE owner = ?").bind(owner),
      db.prepare("SELECT * FROM platform_accounts WHERE owner = ? ORDER BY sort_order, name").bind(owner),
      db.prepare("SELECT * FROM publish_marks WHERE owner = ?").bind(owner),
      db.prepare("SELECT * FROM scan_sources WHERE owner = ? ORDER BY path").bind(owner),
      db.prepare("SELECT updated_at FROM sync_metadata WHERE owner = ?").bind(owner),
    ]);
  const groupRows = (groupsResult.results ?? []) as Row[];
  const assetRows = (assetsResult.results ?? []) as Row[];
  const platformRows = (platformsResult.results ?? []) as Row[];
  const markRows = (marksResult.results ?? []) as Row[];
  const sourceRows = (sourcesResult.results ?? []) as Row[];
  const metaRows = (metaResult.results ?? []) as Row[];

  let platforms = platformRows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    sortOrder: Number(row.sort_order),
    active: Boolean(row.active),
  }));
  if (!platforms.length) {
    platforms = DEFAULT_PLATFORMS.map((name, index) => ({
      id: `platform-${index + 1}`,
      name,
      sortOrder: index,
      active: true,
    }));
  }

  const assetsByGroup = new Map<string, Record<string, Asset>>();
  for (const row of assetRows) {
    const groupAssets = assetsByGroup.get(String(row.group_id)) ?? {};
    groupAssets[String(row.slot)] = {
      id: String(row.id),
      slot: String(row.slot),
      path: String(row.path),
      filename: String(row.filename),
      size: Number(row.size),
      modifiedAt: String(row.modified_at),
      width: row.width == null ? undefined : Number(row.width),
      height: row.height == null ? undefined : Number(row.height),
      duration: row.duration == null ? undefined : Number(row.duration),
      available: Boolean(row.available),
      thumbnail: row.thumbnail == null ? undefined : String(row.thumbnail),
    };
    assetsByGroup.set(String(row.group_id), groupAssets);
  }

  const marksByGroup = new Map<string, Record<string, boolean>>();
  for (const row of markRows) {
    const marks = marksByGroup.get(String(row.group_id)) ?? {};
    marks[`${String(row.version)}:${String(row.platform_id)}`] = Boolean(row.published);
    marksByGroup.set(String(row.group_id), marks);
  }

  return {
    groups: groupRows.map((row) => ({
      id: String(row.id),
      category: String(row.category),
      code: String(row.code),
      title: String(row.title),
      notes: String(row.notes),
      assets: assetsByGroup.get(String(row.id)) ?? {},
      publishMarks: marksByGroup.get(String(row.id)) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    })),
    platforms,
    sources: sourceRows.map((row) => ({
      id: String(row.id),
      path: String(row.path),
      lastScannedAt: row.last_scanned_at == null ? undefined : String(row.last_scanned_at),
    })),
    updatedAt: String(metaRows[0]?.updated_at ?? new Date(0).toISOString()),
  };
}

async function writeState(db: D1Database, owner: string, state: AppState) {
  await ensureSchema(db);
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM publish_marks WHERE owner = ?").bind(owner),
    db.prepare("DELETE FROM assets WHERE owner = ?").bind(owner),
    db.prepare("DELETE FROM video_groups WHERE owner = ?").bind(owner),
    db.prepare("DELETE FROM platform_accounts WHERE owner = ?").bind(owner),
    db.prepare("DELETE FROM scan_sources WHERE owner = ?").bind(owner),
  ];

  for (const platform of state.platforms ?? []) {
    statements.push(
      db.prepare(
        "INSERT INTO platform_accounts(owner,id,name,sort_order,active) VALUES(?,?,?,?,?)",
      ).bind(owner, platform.id, platform.name, platform.sortOrder, platform.active ? 1 : 0),
    );
  }
  for (const group of state.groups ?? []) {
    statements.push(
      db.prepare(
        "INSERT INTO video_groups(owner,id,category,code,title,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      ).bind(owner, group.id, group.category, group.code, group.title, group.notes ?? "", group.createdAt, group.updatedAt),
    );
    for (const asset of Object.values(group.assets ?? {})) {
      if (!asset) continue;
      statements.push(
        db.prepare(
          `INSERT INTO assets(owner,id,group_id,slot,path,filename,size,modified_at,width,height,duration,available,thumbnail)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          owner, asset.id, group.id, asset.slot, asset.path, asset.filename,
          asset.size ?? 0, asset.modifiedAt, asset.width ?? null, asset.height ?? null,
          asset.duration ?? null, asset.available ? 1 : 0, asset.thumbnail ?? null,
        ),
      );
    }
    for (const [key, published] of Object.entries(group.publishMarks ?? {})) {
      const separator = key.indexOf(":");
      if (separator < 1) continue;
      const version = key.slice(0, separator);
      const platformId = key.slice(separator + 1);
      statements.push(
        db.prepare(
          "INSERT INTO publish_marks(owner,group_id,version,platform_id,published,updated_at) VALUES(?,?,?,?,?,?)",
        ).bind(owner, group.id, version, platformId, published ? 1 : 0, group.updatedAt),
      );
    }
  }
  for (const source of state.sources ?? []) {
    statements.push(
      db.prepare(
        "INSERT INTO scan_sources(owner,id,path,last_scanned_at) VALUES(?,?,?,?)",
      ).bind(owner, source.id, source.path, source.lastScannedAt ?? null),
    );
  }
  statements.push(
    db.prepare(
      `INSERT INTO sync_metadata(owner,updated_at) VALUES(?,?)
       ON CONFLICT(owner) DO UPDATE SET updated_at=excluded.updated_at`,
    ).bind(owner, state.updatedAt || new Date().toISOString()),
  );
  await db.batch(statements);
}

async function handleApi(request: Request, env: Env) {
  const owner = ownerFor(request);
  if (!owner) return json({ error: "请先登录后使用。" }, 401);
  if (!env.DB) return json({ error: "数据库尚未连接。" }, 503);
  if (request.method === "GET") return json(await readState(env.DB, owner));
  if (request.method === "PUT") {
    const body = (await request.json()) as AppState;
    if (!Array.isArray(body.groups) || !Array.isArray(body.platforms))
      return json({ error: "数据格式不正确。" }, 400);
    await writeState(env.DB, owner, body);
    return json({ ok: true, updatedAt: body.updatedAt });
  }
  return json({ error: "Method not allowed" }, 405);
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/state") {
      try {
        return await handleApi(request, env);
      } catch (error) {
        console.error("state api failed", error);
        return json({ error: "数据服务暂时不可用。" }, 500);
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
