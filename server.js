const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const SEED_PATH = path.join(DATA_DIR, "seed.json");
const PORT = Number(process.env.PORT || 3000);

loadDotEnv();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function ensureState() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) fs.copyFileSync(SEED_PATH, STATE_PATH);
}

function readState() {
  ensureState();
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function badRequest(res, message, details = {}) {
  json(res, 400, { error: "bad_request", message, details });
}

function env(name) {
  return process.env[name] || "";
}

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function envConfigured(...keys) {
  return keys.every((key) => Boolean(env(key)));
}

function configuredScopes() {
  return (env("TIKTOK_SCOPES") || "user.info.basic")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      const type = req.headers["content-type"] || "";
      if (type.includes("application/json")) {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error("Invalid JSON body"));
        }
        return;
      }
      resolve({ raw });
    });
  });
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function base64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const codeVerifier = base64Url(crypto.randomBytes(64));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

function pct(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function summarizeDashboard(state) {
  const videos = state.videos;
  const totalViews = videos.reduce((sum, item) => sum + Number(item.views || 0), 0);
  const totalLikes = videos.reduce((sum, item) => sum + Number(item.likes || 0), 0);
  const totalShares = videos.reduce((sum, item) => sum + Number(item.shares || 0), 0);
  const totalFollowers = state.accounts.reduce((sum, item) => sum + Number(item.followers || 0), 0);
  const followerDelta = state.accounts.reduce((sum, item) => sum + Number(item.followersDelta || 0), 0);
  const topVideos = [...videos]
    .map((video) => ({
      ...video,
      likeRate: pct(video.likes, video.views),
      shareRate: pct(video.shares, video.views),
      saveRate: pct(video.saves, video.views),
      followerRate: pct(video.followersGained, video.views)
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 10);
  const accountRanks = state.accounts
    .map((account) => {
      const ownedVideos = videos.filter((video) => video.accountId === account.id);
      return {
        ...account,
        views: ownedVideos.reduce((sum, item) => sum + Number(item.views || 0), 0),
        posts: ownedVideos.length
      };
    })
    .sort((a, b) => b.views - a.views);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      accounts: state.accounts.length,
      followers: totalFollowers,
      followerDelta,
      views: totalViews,
      engagementRate: pct(totalLikes + totalShares, totalViews),
      scheduled: state.scheduledPosts.filter((post) => post.status === "scheduled").length
    },
    accounts: accountRanks,
    topVideos,
    scheduledPosts: state.scheduledPosts,
    trend: buildTrend(videos)
  };
}

function buildTrend(videos) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (6 - index));
    const base = videos.reduce((sum, video) => {
      const videoDate = new Date(video.publishedAt);
      const distance = Math.abs((date - videoDate) / 86400000);
      return sum + Math.max(0, Number(video.views || 0) * (1 - distance / 8));
    }, 0);
    return {
      date: date.toISOString().slice(5, 10),
      views: Math.round(base + 18000 + index * 4200),
      followers: Math.round(120 + index * 36 + base / 1800)
    };
  });
}

function supportChecklist() {
  return {
    developerAccount: "zhushuai@wangyundian.com",
    appName: "TikTok AI Matrix OS",
    requiredFromYou: [
      "TikTok Developers 后台创建/确认 app，并提供 Client key 与 Client secret",
      "配置 Redirect URI: http://localhost:3000/api/tiktok/oauth/callback 和未来正式域名回调地址",
      "申请并通过 Login Kit / Display API / Content Posting API 权限审核",
      "确认 Content Posting API 是否允许 Direct Post；未审核或 Sandbox 时通常只能发私密测试内容",
      "准备首批要接入的 TikTok 账号清单、国家、店铺、账号负责人、每日发布上限",
      "导出 TikTok Analytics / Shop 后台 CSV 样例，用于补齐官方 API 暂不开放的数据字段",
      "提供 OpenAI/Claude/Gemini API Key 中至少一个，用于正式 AI 日报",
      "确认视频存储方案：AWS S3 或 Cloudflare R2 的 bucket、region、访问密钥",
      "提供正式部署域名，TikTok OAuth 与发布 API 审核一般需要稳定 HTTPS 域名",
      "提供风控规则：每账号每日最多发布几条、最小间隔、禁用词、相似内容阈值"
    ],
    scopes: configuredScopes(),
    futureScopes: [
      "video.list",
      "video.publish"
    ],
    currentEnv: {
      tiktokClientKey: Boolean(env("TIKTOK_CLIENT_KEY")),
      tiktokClientSecret: Boolean(env("TIKTOK_CLIENT_SECRET")),
      redirectUri: env("TIKTOK_REDIRECT_URI") || "http://localhost:3000/api/tiktok/oauth/callback",
      aiProvider: env("AI_PROVIDER") || "local",
      storageProvider: env("STORAGE_PROVIDER") || "local"
    },
    apiLimitNotes: [
      "Display API 适合读取用户基础资料和公开视频列表/基础指标。",
      "Content Posting API 需要 TikTok 审核，发布能力、隐私级别和账号资格会受 app 状态限制。",
      "粉丝画像、Shop 经营转化、部分推荐流量诊断字段通常需要后台导出 CSV 或额外平台 API。"
    ]
  };
}

function createLocalReport(state) {
  const dashboard = summarizeDashboard(state);
  const best = dashboard.topVideos[0];
  const weak = [...dashboard.topVideos].sort((a, b) => a.views - b.views)[0];
  const riskyAccounts = dashboard.accounts.filter((account) => account.status !== "healthy");
  return {
    id: uid("report"),
    title: "TikTok AI 日报",
    generatedAt: new Date().toISOString(),
    mode: env("OPENAI_API_KEY") ? "ai-ready" : "local-rules",
    summary: [
      `昨日最佳视频是 ${best.title}，播放 ${best.views.toLocaleString()}，分享率 ${best.shareRate}%。`,
      `矩阵总粉丝 ${dashboard.kpis.followers.toLocaleString()}，净增长 ${dashboard.kpis.followerDelta.toLocaleString()}。`,
      riskyAccounts.length
        ? `需要关注 ${riskyAccounts.map((account) => account.handle).join(", ")} 的账号健康。`
        : "当前账号健康状态稳定。"
    ],
    bestVideo: {
      title: best.title,
      reason: "强 Hook + 拼装过程可视化 + 结果反馈明确，适合翻拍和矩阵复制。",
      remixIdeas: [
        "把开头 2 秒改成失败/反差画面，提高停留。",
        "同结构复制到机甲肩甲、武器、透明件三个细分类目。",
        "添加商品挂车时保持前 70% 内容为纯展示，降低营销感。"
      ]
    },
    dropDiagnosis: {
      title: weak.title,
      risk: weak.views < 10000 ? "possible_distribution_drop" : "normal",
      notes: [
        "播放低但标题偏教程向，建议改成问题式 Hook。",
        "如果连续 3 条低于账号 30 日中位播放 40%，再标记为疑似限流。",
        "排查重复素材、过密发布和跨账号同标题。"
      ]
    },
    tomorrow: {
      bestTimes: ["US 19:00-22:00", "UK 18:30-21:30"],
      topics: [
        "机甲拼装前后对比",
        "稀有手办开箱反转",
        "TikTok Shop 低营销感场景展示"
      ],
      titleAngles: [
        "Stop doing this before panel lining",
        "I did not expect this kit to fit",
        "The cheapest display trick that looks premium"
      ]
    }
  };
}

function parseCsv(raw) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const next = raw[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      i += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift() || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header.trim(), values[index] || ""])));
}

function normalizeImportedVideo(row, accountId) {
  const lookup = (names) => names.map((name) => row[name]).find((value) => value !== undefined && value !== "");
  const views = Number(lookup(["views", "Views", "播放量", "video views"]) || 0);
  const likes = Number(lookup(["likes", "Likes", "点赞", "likes count"]) || 0);
  const shares = Number(lookup(["shares", "Shares", "分享", "shares count"]) || 0);
  const comments = Number(lookup(["comments", "Comments", "评论"]) || 0);
  const saves = Number(lookup(["saves", "Saves", "收藏", "收藏数"]) || 0);
  return {
    id: lookup(["video_id", "Video ID", "视频ID"]) || uid("csv"),
    accountId,
    title: lookup(["title", "Title", "标题", "Video title"]) || "Imported TikTok video",
    hook: lookup(["hook", "Hook", "开头"]) || "",
    market: lookup(["market", "Market", "国家"]) || "US",
    publishedAt: lookup(["published_at", "Published time", "发布时间"]) || new Date().toISOString(),
    views,
    likes,
    comments,
    shares,
    saves,
    followersGained: Number(lookup(["followers_gained", "New followers", "新增粉丝"]) || 0),
    source: "csv"
  };
}

async function tiktokFetch(endpoint, options = {}) {
  const response = await fetch(`https://open.tiktokapis.com${endpoint}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || "TikTok API request failed");
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function exchangeCode(code, codeVerifier) {
  const params = new URLSearchParams({
    client_key: env("TIKTOK_CLIENT_KEY"),
    client_secret: env("TIKTOK_CLIENT_SECRET"),
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: env("TIKTOK_REDIRECT_URI") || "http://localhost:3000/api/tiktok/oauth/callback"
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.message || "TikTok token exchange failed");
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function refreshToken(refreshTokenValue) {
  const params = new URLSearchParams({
    client_key: env("TIKTOK_CLIENT_KEY"),
    client_secret: env("TIKTOK_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue
  });
  const response = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.message || "TikTok token refresh failed");
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function handleApi(req, res, url) {
  const state = readState();

  if (req.method === "GET" && url.pathname === "/api/support") {
    return json(res, 200, supportChecklist());
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    return json(res, 200, summarizeDashboard(state));
  }

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    return json(res, 200, { accounts: state.accounts });
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const input = await body(req);
    const account = {
      id: uid("acc"),
      handle: input.handle || "@new_account",
      displayName: input.displayName || input.handle || "New TikTok Account",
      market: input.market || "US",
      shop: input.shop || "",
      status: "watch",
      followers: 0,
      followersDelta: 0,
      dailyPostLimit: Number(input.dailyPostLimit || env("MAX_DAILY_POSTS_PER_ACCOUNT") || 3),
      tokenStatus: "manual",
      lastSync: null
    };
    state.accounts.push(account);
    writeState(state);
    return json(res, 201, { account });
  }

  if (req.method === "GET" && url.pathname === "/api/tiktok/oauth/start") {
    if (!envConfigured("TIKTOK_CLIENT_KEY")) {
      return badRequest(res, "TikTok Client key is missing. Add it to .env before starting OAuth.", supportChecklist().currentEnv);
    }
    const stateToken = crypto.randomBytes(16).toString("hex");
    const pkce = createPkcePair();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    state.oauthStates = (state.oauthStates || []).filter((item) => item.expiresAt > Date.now());
    state.oauthStates.push({
      state: stateToken,
      codeVerifier: pkce.codeVerifier,
      expiresAt
    });
    writeState(state);
    const params = new URLSearchParams({
      client_key: env("TIKTOK_CLIENT_KEY"),
      scope: url.searchParams.get("scope") || configuredScopes().join(","),
      response_type: "code",
      redirect_uri: env("TIKTOK_REDIRECT_URI") || "http://localhost:3000/api/tiktok/oauth/callback",
      state: stateToken,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256"
    });
    return redirect(res, `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
  }

  if (req.method === "GET" && url.pathname === "/api/tiktok/oauth/callback") {
    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    const oauthRecord = (state.oauthStates || []).find((item) => item.state === returnedState && item.expiresAt > Date.now());
    if (!code) return badRequest(res, "OAuth callback is missing code.");
    if (!oauthRecord) return badRequest(res, "OAuth state expired or invalid. Please start TikTok login again.");
    if (!envConfigured("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET")) {
      return badRequest(res, "TikTok Client key/secret missing; cannot exchange OAuth code.");
    }
    const token = await exchangeCode(code, oauthRecord.codeVerifier);
    const account = {
      id: uid("acc"),
      handle: token.open_id ? `@${token.open_id.slice(0, 8)}` : "@authorized_account",
      displayName: "Authorized TikTok Account",
      market: "US",
      shop: "",
      status: "healthy",
      followers: 0,
      followersDelta: 0,
      dailyPostLimit: Number(env("MAX_DAILY_POSTS_PER_ACCOUNT") || 3),
      tokenStatus: "active",
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      openId: token.open_id,
      expiresAt: Date.now() + Number(token.expires_in || 86400) * 1000,
      lastSync: null
    };
    state.accounts.push(account);
    state.oauthStates = (state.oauthStates || []).filter((item) => item.state !== returnedState && item.expiresAt > Date.now());
    writeState(state);
    return redirect(res, "/?connected=1");
  }

  if (req.method === "POST" && url.pathname === "/api/tiktok/creator-info") {
    const input = await body(req);
    const account = state.accounts.find((item) => item.id === input.accountId);
    if (!account?.accessToken) return badRequest(res, "Account has no active TikTok access token.");
    const data = await tiktokFetch("/v2/post/publish/creator_info/query/", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.accessToken}` },
      body: "{}"
    });
    return json(res, 200, data);
  }

  if (req.method === "POST" && url.pathname === "/api/tiktok/token/refresh") {
    const input = await body(req);
    const account = state.accounts.find((item) => item.id === input.accountId);
    if (!account?.refreshToken) return badRequest(res, "Account has no TikTok refresh token.");
    if (!envConfigured("TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET")) {
      return badRequest(res, "TikTok Client key/secret missing; cannot refresh token.");
    }
    const token = await refreshToken(account.refreshToken);
    account.accessToken = token.access_token;
    account.refreshToken = token.refresh_token || account.refreshToken;
    account.expiresAt = Date.now() + Number(token.expires_in || 86400) * 1000;
    account.tokenStatus = "active";
    writeState(state);
    return json(res, 200, { accountId: account.id, tokenStatus: account.tokenStatus, expiresAt: account.expiresAt });
  }

  if (req.method === "POST" && url.pathname === "/api/posts/schedule") {
    const input = await body(req);
    if (!input.accountId || !input.title || !input.publishAt) {
      return badRequest(res, "accountId, title and publishAt are required.");
    }
    const dailyPosts = state.scheduledPosts.filter((post) => post.accountId === input.accountId && post.publishAt?.slice(0, 10) === input.publishAt.slice(0, 10));
    const account = state.accounts.find((item) => item.id === input.accountId);
    const limit = Number(account?.dailyPostLimit || env("MAX_DAILY_POSTS_PER_ACCOUNT") || 3);
    const riskScore = riskScoreForPost(input, state);
    const status = dailyPosts.length >= limit || riskScore >= 70 ? "needs_review" : "scheduled";
    const post = {
      id: uid("post"),
      accountId: input.accountId,
      title: input.title,
      market: input.market || account?.market || "US",
      publishAt: input.publishAt,
      status,
      assetName: input.assetName || "uploaded-video.mp4",
      riskScore
    };
    state.scheduledPosts.push(post);
    writeState(state);
    return json(res, 201, { post });
  }

  if (req.method === "POST" && url.pathname === "/api/posts/publish") {
    const input = await body(req);
    const account = state.accounts.find((item) => item.id === input.accountId);
    if (!account) return badRequest(res, "Unknown accountId.");
    if (!account.accessToken) {
      return json(res, 202, {
        mode: "mock",
        message: "No TikTok access token yet. Post queued locally; connect OAuth before real publish.",
        postId: input.postId || null
      });
    }
    if (!input.videoUrl) {
      return badRequest(res, "Direct Post requires videoUrl. Configure S3/R2 and pass a public HTTPS video URL.");
    }
    const data = await tiktokFetch("/v2/post/publish/video/init/", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.accessToken}` },
      body: JSON.stringify({
        post_info: {
          title: input.title || "TikTok AI Matrix OS scheduled post",
          privacy_level: input.privacyLevel || "SELF_ONLY",
          disable_duet: Boolean(input.disableDuet),
          disable_comment: Boolean(input.disableComment),
          disable_stitch: Boolean(input.disableStitch),
          video_cover_timestamp_ms: Number(input.coverTimestampMs || 1000)
        },
        source_info: {
          source: "PULL_FROM_URL",
          video_url: input.videoUrl
        }
      })
    });
    return json(res, 200, { mode: "official_api", data });
  }

  if (req.method === "POST" && url.pathname === "/api/sync/videos") {
    const input = await body(req);
    const account = state.accounts.find((item) => item.id === input.accountId);
    if (!account) return badRequest(res, "Unknown accountId.");
    if (!account.accessToken) {
      account.lastSync = new Date().toISOString();
      writeState(state);
      return json(res, 200, {
        mode: "mock",
        message: "No active token, marked mock sync time only.",
        account
      });
    }
    const data = await tiktokFetch("/v2/video/list/?fields=id,title,video_description,duration,cover_image_url,share_url,view_count,like_count,comment_count,share_count", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.accessToken}` },
      body: JSON.stringify({ max_count: 20 })
    });
    account.lastSync = new Date().toISOString();
    writeState(state);
    return json(res, 200, { mode: "official_api", data });
  }

  if (req.method === "POST" && url.pathname === "/api/import/csv") {
    const input = await body(req);
    if (!input.accountId || !input.csv) return badRequest(res, "accountId and csv are required.");
    const rows = parseCsv(input.csv);
    const imported = rows.map((row) => normalizeImportedVideo(row, input.accountId));
    state.videos.push(...imported);
    writeState(state);
    return json(res, 201, { imported: imported.length, videos: imported });
  }

  if (req.method === "GET" && url.pathname === "/api/reports/daily") {
    const latest = state.reports.at(-1) || createLocalReport(state);
    return json(res, 200, latest);
  }

  if (req.method === "POST" && url.pathname === "/api/reports/daily") {
    const report = createLocalReport(state);
    state.reports.push(report);
    writeState(state);
    return json(res, 201, report);
  }

  return notFound(res);
}

function riskScoreForPost(input, state) {
  const title = String(input.title || "").toLowerCase();
  const duplicateTitle = state.scheduledPosts.some((post) => similarity(title, String(post.title || "").toLowerCase()) > 0.72);
  const sameAccountSameDay = state.scheduledPosts.filter((post) => post.accountId === input.accountId && post.publishAt?.slice(0, 10) === input.publishAt?.slice(0, 10)).length;
  const promotional = /(buy|discount|link in bio|shop now|coupon|deal)/i.test(title);
  return Math.min(100, (duplicateTitle ? 35 : 0) + sameAccountSameDay * 18 + (promotional ? 20 : 0) + 12);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const setA = new Set(a.split(/\W+/).filter(Boolean));
  const setB = new Set(b.split(/\W+/).filter(Boolean));
  const intersection = [...setA].filter((word) => setB.has(word)).length;
  const union = new Set([...setA, ...setB]).size;
  return union ? intersection / union : 0;
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return notFound(res);
  const ext = path.extname(filePath);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    json(res, error.status || 500, {
      error: "server_error",
      message: error.message,
      details: error.details || undefined
    });
  }
});

server.listen(PORT, () => {
  console.log(`TikTok AI Matrix OS running at http://localhost:${PORT}`);
});
