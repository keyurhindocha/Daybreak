/**
 * server.ts -- Web UI entry point
 *
 * Starts a local HTTP server (default port 3456) that serves:
 *   - A single-page web UI (ui.html) for managing wallpapers
 *   - A REST API for quote/wallpaper operations
 *
 * API routes:
 *   GET  /api/today              - Current quote and wallpaper status
 *   POST /api/generate           - Generate (or shuffle) a new wallpaper
 *   POST /api/generate/iphone    - Generate an iPhone-sized wallpaper
 *   GET  /api/wallpaper/today    - Serve today's wallpaper as PNG
 *   GET  /api/wallpaper/iphone   - Serve today's iPhone wallpaper as PNG
 *   GET  /api/archive            - List all archived wallpapers
 *   GET  /api/archive/:filename  - Serve an archived wallpaper (with optional ?thumb=1)
 *   GET  /api/sources            - List all quote sources with active status
 *   PUT  /api/sources            - Update which sources are active
 *   GET  /api/settings           - Current display/render settings
 *   PUT  /api/settings           - Update display/render settings
 *   GET  /api/schedule           - Scheduler status (platform-aware)
 *   PUT  /api/schedule/time      - Update scheduled time (reinstalls if active)
 *   POST /api/schedule/install   - Install the daily scheduler
 *   POST /api/schedule/uninstall - Remove the daily scheduler
 *
 * Usage:  npm run ui   (or:  npx tsx src/server.ts)
 */

import http from "http";
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import sharp from "sharp";

import { loadConfig } from "./config.js";
import { detectPlatform, openUrl } from "./utils/platform.js";
import { loadQuoteSources, selectDailyQuote, selectRandomQuote } from "./quotes/loader.js";
import {
  ensureCacheDirs,
  hasCachedWallpaper,
  getCachedWallpaperPath,
  getCachedBackgroundPath,
  cleanOldCache,
} from "./images/cache.js";
import { fetchBackgroundImage } from "./images/unsplash.js";
import { renderWallpaper, type RenderOptions } from "./canvas/renderer.js";
import { archiveWallpaper } from "./wallpaper/archive.js";
import { setWallpaper } from "./wallpaper/setter.js";
import { getTodayString } from "./utils/date.js";
import { registerFonts, getResolvedFontFamily } from "./canvas/fonts.js";
import type { QuoteSource } from "./quotes/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Quote state persistence
//
// Tracks which quote is currently displayed on the wallpaper. This is saved
// to {cachePath}/current-quote.json so the web UI can show the active quote
// without re-running the selection algorithm.
// ---------------------------------------------------------------------------

interface QuoteState {
  date: string;
  text: string;
  author: string;
  sourceId: string;
  sourceName: string;
  sourceTheme: string;
}

function getStatePath(): string {
  const config = loadConfig();
  return resolve(config.cachePath, "current-quote.json");
}

function saveQuoteState(quote: { text: string; author: string; source: { id: string; name: string; theme: string } }) {
  const state: QuoteState = {
    date: getTodayString(),
    text: quote.text,
    author: quote.author,
    sourceId: quote.source.id,
    sourceName: quote.source.name,
    sourceTheme: quote.source.theme,
  };
  const config = loadConfig();
  ensureCacheDirs(config);
  writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
}

function loadQuoteState(): QuoteState | null {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return null;
  try {
    const state: QuoteState = JSON.parse(readFileSync(statePath, "utf-8"));
    if (state.date !== getTodayString()) return null;
    return state;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, { error: message }, status);
}

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readConfigFile(): Record<string, unknown> {
  const config = loadConfig();
  const configPath = resolve(config.projectRoot, "data", "config.json");
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function writeConfigFile(data: Record<string, unknown>) {
  const config = loadConfig();
  const configPath = resolve(config.projectRoot, "data", "config.json");
  writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
}

function getAllSources(): QuoteSource[] {
  const config = loadConfig();
  const quotesDir = resolve(config.projectRoot, "data", "quotes");
  const files = readdirSync(quotesDir).filter((f) => f.endsWith(".json"));
  return files.map((f) =>
    JSON.parse(readFileSync(resolve(quotesDir, f), "utf-8"))
  );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleToday(res: http.ServerResponse) {
  const config = loadConfig();

  // If a wallpaper was already generated (possibly via shuffle), use the saved quote
  const savedState = loadQuoteState();
  if (savedState) {
    sendJson(res, {
      date: savedState.date,
      quote: {
        text: savedState.text,
        author: savedState.author,
        source: { id: savedState.sourceId, name: savedState.sourceName, theme: savedState.sourceTheme },
      },
      hasWallpaper: hasCachedWallpaper(config),
    });
    return;
  }

  // No wallpaper generated yet today — show the deterministic daily quote
  const sources = loadQuoteSources(config);
  const quote = selectDailyQuote(sources);
  sendJson(res, {
    date: getTodayString(),
    quote: {
      text: quote.text,
      author: quote.author,
      source: { id: quote.source.id, name: quote.source.name, theme: quote.source.theme },
    },
    hasWallpaper: hasCachedWallpaper(config),
  });
}

async function handleGenerate(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    let shuffle = false;
    try {
      const body = (await parseBody(req)) as Record<string, unknown>;
      shuffle = body.shuffle === true;
    } catch {}

    const config = loadConfig();
    ensureCacheDirs(config);

    // Clear today's cache
    const cachedWallpaper = getCachedWallpaperPath(config);
    const cachedBg = getCachedBackgroundPath(config, getTodayString());
    if (existsSync(cachedWallpaper)) unlinkSync(cachedWallpaper);
    if (existsSync(cachedBg)) unlinkSync(cachedBg);

    // Run pipeline
    const sources = loadQuoteSources(config);
    const quote = shuffle ? selectRandomQuote(sources) : selectDailyQuote(sources);
    const backgroundPath = await fetchBackgroundImage(config, quote.source.theme);
    const wallpaperBuffer = await renderWallpaper(config, quote, backgroundPath);
    const archivedPath = archiveWallpaper(config, wallpaperBuffer);
    writeFileSync(getCachedWallpaperPath(config), wallpaperBuffer);
    setWallpaper(archivedPath, config.setAllDisplays);
    saveQuoteState(quote);
    cleanOldCache(config);

    sendJson(res, {
      success: true,
      date: getTodayString(),
      quote: { text: quote.text, author: quote.author },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    sendError(res, 500, message);
  }
}

const IPHONE_WIDTH = 1290;
const IPHONE_HEIGHT = 2796;

async function handleGenerateIphone(res: http.ServerResponse) {
  try {
    const config = loadConfig();
    ensureCacheDirs(config);

    // Use the same quote that's on the desktop wallpaper
    const savedState = loadQuoteState();
    const sources = loadQuoteSources(config);
    let quote;
    if (savedState) {
      // Reconstruct a SelectedQuote-like object from saved state
      const matchingSource = sources.find(s => s.id === savedState.sourceId);
      quote = {
        text: savedState.text,
        author: savedState.author,
        source: matchingSource ?? { id: savedState.sourceId, name: savedState.sourceName, theme: savedState.sourceTheme, quotes: [] },
      };
    } else {
      quote = selectDailyQuote(sources);
    }

    // Fetch background (reuses cached if available)
    const backgroundPath = await fetchBackgroundImage(config, quote.source.theme);

    // Render at iPhone resolution
    const iphoneBuffer = await renderWallpaper(config, quote, backgroundPath, {
      width: IPHONE_WIDTH,
      height: IPHONE_HEIGHT,
    });

    // Save to archive with -iphone suffix
    const iphonePath = resolve(config.archivePath, `${getTodayString()}-iphone.png`);
    if (!existsSync(config.archivePath)) {
      const { mkdirSync } = await import("fs");
      mkdirSync(config.archivePath, { recursive: true });
    }
    writeFileSync(iphonePath, iphoneBuffer);

    sendJson(res, {
      success: true,
      date: getTodayString(),
      path: iphonePath,
      quote: { text: quote.text, author: quote.author },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    sendError(res, 500, message);
  }
}

async function handleWallpaperIphone(res: http.ServerResponse) {
  const config = loadConfig();
  const iphonePath = resolve(config.archivePath, `${getTodayString()}-iphone.png`);

  if (!existsSync(iphonePath)) {
    sendError(res, 404, "No iPhone wallpaper generated today. Generate one first.");
    return;
  }

  const data = readFileSync(iphonePath);
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
  res.end(data);
}

async function handleWallpaperToday(res: http.ServerResponse) {
  const config = loadConfig();
  const cachedPath = getCachedWallpaperPath(config);
  const archivePath = resolve(config.archivePath, `${getTodayString()}.png`);
  const filePath = existsSync(cachedPath) ? cachedPath : archivePath;

  if (!existsSync(filePath)) {
    sendError(res, 404, "No wallpaper generated today");
    return;
  }

  const data = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
  res.end(data);
}

async function handleArchiveList(res: http.ServerResponse) {
  const config = loadConfig();
  if (!existsSync(config.archivePath)) {
    sendJson(res, { wallpapers: [] });
    return;
  }

  const files = readdirSync(config.archivePath)
    .filter((f) => /^\d{4}-\d{2}-\d{2}(_\d{6})?\.png$/.test(f))
    .sort()
    .reverse();

  sendJson(res, {
    wallpapers: files.map((f) => ({
      date: f.slice(0, 10),
      filename: f,
    })),
  });
}

async function handleArchiveImage(res: http.ServerResponse, filename: string, thumb: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}(_\d{6})?(-iphone)?\.png$/.test(filename)) {
    sendError(res, 400, "Invalid filename");
    return;
  }

  const config = loadConfig();
  const filePath = resolve(config.archivePath, filename);
  if (!existsSync(filePath)) {
    sendError(res, 404, "Not found");
    return;
  }

  if (thumb) {
    const buffer = await sharp(filePath).resize(400).png().toBuffer();
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-cache" });
    res.end(buffer);
  } else {
    const data = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(data);
  }
}

async function handleSources(res: http.ServerResponse) {
  const config = loadConfig();
  const allSources = getAllSources();
  sendJson(res, {
    sources: allSources.map((s) => ({
      id: s.id,
      name: s.name,
      theme: s.theme,
      quoteCount: s.quotes.length,
      active: config.activeSources.includes(s.id),
    })),
  });
}

async function handleUpdateSources(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await parseBody(req)) as { activeSources: string[] };
  if (!Array.isArray(body.activeSources)) {
    sendError(res, 400, "activeSources must be an array");
    return;
  }

  const configData = readConfigFile();
  configData.activeSources = body.activeSources;
  writeConfigFile(configData);
  sendJson(res, { success: true, activeSources: body.activeSources });
}

async function handleSettings(res: http.ServerResponse) {
  const config = loadConfig();
  sendJson(res, {
    background: config.background,
    font: config.font,
    setAllDisplays: config.setAllDisplays,
    resolution: config.resolution,
  });
}

async function handleUpdateSettings(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = (await parseBody(req)) as Record<string, unknown>;
  const configData = readConfigFile();

  // background values are interpolated into an SVG for sharp/librsvg, so
  // only accept plain numbers in range.
  if (body.background) {
    const { darkenOpacity, blurSigma } = body.background as { darkenOpacity?: unknown; blurSigma?: unknown };
    if (!isNumberInRange(darkenOpacity, 0, 1) || !isNumberInRange(blurSigma, 0, 100)) {
      sendError(res, 400, "background.darkenOpacity must be 0–1 and blurSigma 0–100");
      return;
    }
    configData.background = { darkenOpacity, blurSigma };
  }
  if (body.font) {
    const { quote, attribution } = body.font as { quote?: unknown; attribution?: unknown };
    if (!isFontName(quote) || !isFontName(attribution)) {
      sendError(res, 400, "font names must be short strings");
      return;
    }
    configData.font = { quote, attribution };
  }
  if (body.resolution) {
    const { width, height } = body.resolution as { width?: unknown; height?: unknown };
    if (!isValidDimension(width) || !isValidDimension(height)) {
      sendError(res, 400, "resolution width/height must be integers between 100 and 8192");
      return;
    }
    configData.resolution = { width, height };
  }
  if (typeof body.setAllDisplays === "boolean") configData.setAllDisplays = body.setAllDisplays;

  writeConfigFile(configData);
  sendJson(res, { success: true });
}

function isNumberInRange(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function isFontName(s: unknown): s is string {
  return typeof s === "string" && s.length <= 100 && !/["\\]/.test(s);
}

function isValidDimension(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 100 && (n as number) <= 8192;
}

async function handlePlatform(res: http.ServerResponse) {
  registerFonts();
  sendJson(res, {
    platform: detectPlatform(),
    resolvedFont: getResolvedFontFamily(),
  });
}

async function handleSchedule(res: http.ServerResponse) {
  const platform = detectPlatform();
  const config = loadConfig();

  let installed = false;
  let loaded = false;
  let lastLog = "";
  let lastErr = "";

  if (platform === "macos") {
    const plistDest = resolve(
      config.cachePath, "..", "..", "Library", "LaunchAgents", "com.inspiration.daily.plist"
    );
    installed = existsSync(plistDest);
    try {
      const output = execSync("launchctl list 2>/dev/null", { encoding: "utf-8" });
      loaded = output.includes("com.inspiration.daily");
    } catch {}
    try { lastLog = execSync("tail -20 /tmp/inspiration.log 2>/dev/null", { encoding: "utf-8" }); } catch {}
    try { lastErr = execSync("tail -10 /tmp/inspiration.err 2>/dev/null", { encoding: "utf-8" }); } catch {}
  } else if (platform === "windows") {
    try {
      const output = execSync('schtasks /Query /TN "DailyInspiration" 2>nul', { encoding: "utf-8" });
      installed = true;
      loaded = output.includes("Ready") || output.includes("Running");
    } catch {}
  } else {
    // Linux/ChromeOS — check crontab
    try {
      const output = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
      installed = output.includes("inspiration");
      loaded = installed;
    } catch {}
  }

  const { hour, minute } = config.scheduledTime;
  const formattedTime = `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;

  sendJson(res, {
    platform,
    installed,
    loaded,
    status: loaded ? "running" : installed ? "installed" : "not installed",
    scheduledTime: formattedTime,
    scheduledHour: hour,
    scheduledMinute: minute,
    lastLog,
    lastErr,
  });
}

function buildScheduleEnv(config: ReturnType<typeof loadConfig>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SCHEDULE_HOUR: String(config.scheduledTime.hour),
    SCHEDULE_MINUTE: String(config.scheduledTime.minute),
  };
}

async function handleScheduleInstall(res: http.ServerResponse) {
  try {
    const config = loadConfig();
    const platform = detectPlatform();
    let script: string;
    let cmd: string;

    if (platform === "macos") {
      script = resolve(config.projectRoot, "scripts", "install-launchd.sh");
      cmd = `bash "${script}"`;
    } else if (platform === "windows") {
      script = resolve(config.projectRoot, "scripts", "install-task-scheduler.ps1");
      cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
    } else {
      script = resolve(config.projectRoot, "scripts", "install-cron.sh");
      cmd = `bash "${script}"`;
    }

    const output = execSync(cmd, { encoding: "utf-8", env: buildScheduleEnv(config) });
    sendJson(res, { success: true, output });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to install";
    sendError(res, 500, message);
  }
}

async function handleScheduleUpdateTime(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = (await parseBody(req)) as { hour: number; minute: number };
    const hour = Number(body.hour);
    const minute = Number(body.minute);

    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      sendError(res, 400, "hour must be an integer 0–23");
      return;
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      sendError(res, 400, "minute must be an integer 0–59");
      return;
    }

    const configData = readConfigFile();
    configData.scheduledTime = { hour, minute };
    writeConfigFile(configData);

    // If already installed, reinstall with the new time
    const platform = detectPlatform();
    const config = loadConfig();
    const scheduleEnv = buildScheduleEnv(config);
    let reinstalled = false;

    try {
      let isInstalled = false;
      if (platform === "macos") {
        const plistDest = resolve(config.cachePath, "..", "..", "Library", "LaunchAgents", "com.inspiration.daily.plist");
        isInstalled = existsSync(plistDest);
      } else if (platform === "windows") {
        try { execSync('schtasks /Query /TN "DailyInspiration" 2>nul', { encoding: "utf-8" }); isInstalled = true; } catch {}
      } else {
        try { const out = execSync("crontab -l 2>/dev/null", { encoding: "utf-8" }); isInstalled = out.includes("inspiration"); } catch {}
      }

      if (isInstalled) {
        let script: string;
        let cmd: string;
        if (platform === "macos") {
          script = resolve(config.projectRoot, "scripts", "install-launchd.sh");
          cmd = `bash "${script}"`;
        } else if (platform === "windows") {
          script = resolve(config.projectRoot, "scripts", "install-task-scheduler.ps1");
          cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`;
        } else {
          script = resolve(config.projectRoot, "scripts", "install-cron.sh");
          cmd = `bash "${script}"`;
        }
        execSync(cmd, { encoding: "utf-8", env: scheduleEnv });
        reinstalled = true;
      }
    } catch {}

    sendJson(res, { success: true, hour, minute, reinstalled });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to update schedule time";
    sendError(res, 500, message);
  }
}

async function handleScheduleUninstall(res: http.ServerResponse) {
  try {
    const config = loadConfig();
    const platform = detectPlatform();
    let cmd: string;

    if (platform === "macos") {
      const script = resolve(config.projectRoot, "scripts", "install-launchd.sh");
      cmd = `bash "${script}" uninstall`;
    } else if (platform === "windows") {
      const script = resolve(config.projectRoot, "scripts", "install-task-scheduler.ps1");
      cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Uninstall`;
    } else {
      const script = resolve(config.projectRoot, "scripts", "install-cron.sh");
      cmd = `bash "${script}" uninstall`;
    }

    const output = execSync(cmd, { encoding: "utf-8" });
    sendJson(res, { success: true, output });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to uninstall";
    sendError(res, 500, message);
  }
}

// ---------------------------------------------------------------------------
// Router -- maps HTTP method + path to the appropriate handler
// ---------------------------------------------------------------------------

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // The UI is served from this same origin, so no CORS headers are sent:
  // other websites must not be able to drive this API from the browser.
  // The Host check blocks DNS-rebinding; the Origin check blocks cross-site
  // form/fetch posts, which browsers send without a CORS preflight.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
    sendError(res, 403, "Forbidden host");
    return;
  }
  const origin = req.headers.origin;
  if (method !== "GET" && origin !== undefined && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ""))) {
    sendError(res, 403, "Forbidden origin");
    return;
  }

  try {
    // Serve frontend
    if (path === "/" && method === "GET") {
      const htmlPath = resolve(__dirname, "ui.html");
      const html = readFileSync(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // API routes
    if (path === "/api/today" && method === "GET") return await handleToday(res);
    if (path === "/api/generate" && method === "POST") return await handleGenerate(req, res);
    if (path === "/api/generate/iphone" && method === "POST") return await handleGenerateIphone(res);
    if (path === "/api/wallpaper/iphone" && method === "GET") return await handleWallpaperIphone(res);
    if (path === "/api/wallpaper/today" && method === "GET") return await handleWallpaperToday(res);
    if (path === "/api/archive" && method === "GET") return await handleArchiveList(res);
    if (path === "/api/sources" && method === "GET") return await handleSources(res);
    if (path === "/api/sources" && method === "PUT") return await handleUpdateSources(req, res);
    if (path === "/api/settings" && method === "GET") return await handleSettings(res);
    if (path === "/api/settings" && method === "PUT") return await handleUpdateSettings(req, res);
    if (path === "/api/platform" && method === "GET") return await handlePlatform(res);
    if (path === "/api/schedule" && method === "GET") return await handleSchedule(res);
    if (path === "/api/schedule/install" && method === "POST") return await handleScheduleInstall(res);
    if (path === "/api/schedule/uninstall" && method === "POST") return await handleScheduleUninstall(res);
    if (path === "/api/schedule/time" && method === "PUT") return await handleScheduleUpdateTime(req, res);

    // Archive image: /api/archive/2026-03-25.png
    if (path.startsWith("/api/archive/") && method === "GET") {
      const filename = path.slice("/api/archive/".length);
      const thumb = url.searchParams.get("thumb") === "1";
      return await handleArchiveImage(res, filename, thumb);
    }

    sendError(res, 404, "Not found");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("Server error:", message);
    sendError(res, 500, message);
  }
}

// ---------------------------------------------------------------------------
// Start the server and open the browser
// ---------------------------------------------------------------------------

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  console.log(`\n  Inspiration UI running at http://localhost:${PORT}\n`);
  try {
    execSync(openUrl(`http://localhost:${PORT}`));
  } catch {}
});
