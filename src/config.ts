/**
 * config.ts
 *
 * Loads application configuration by merging:
 *   1. data/config.json   -- user-editable settings (sources, resolution, fonts, etc.)
 *   2. .env               -- secrets (Unsplash API key)
 *   3. Computed paths      -- archive and cache directories derived from the user's home dir
 *
 * The resulting AppConfig is passed to virtually every other module.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { getHomedir } from "./utils/platform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

/**
 * Reads a .env file (if present) and populates process.env for any keys
 * that aren't already set. This avoids requiring a third-party dotenv package.
 */
function loadEnvFile(): void {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/** The fully resolved configuration object used across the app. */
export interface AppConfig {
  activeSources: string[];
  resolution: { width: number; height: number };
  font: { quote: string; attribution: string };
  background: { darkenOpacity: number; blurSigma: number };
  /** Absolute path to the wallpaper archive folder (e.g. ~/Pictures/DailyQuotes). */
  archivePath: string;
  /** Whether to apply the wallpaper to all displays (macOS only). */
  setAllDisplays: boolean;
  /** Time of day for the daily scheduler (hour 0-23, minute 0-59). */
  scheduledTime: { hour: number; minute: number };
  /** Unsplash API access key loaded from .env. */
  unsplashAccessKey: string;
  /** Absolute path to the project root directory. */
  projectRoot: string;
  /** Absolute path to the cache directory (~/.cache/inspiration). */
  cachePath: string;
}

/**
 * Loads and returns the merged application configuration.
 *
 * Call this at the start of every entry point (CLI and web server).
 * The config is intentionally not cached as a singleton so that the
 * web UI can re-read config.json after the user changes settings.
 */
export function loadConfig(): AppConfig {
  loadEnvFile();
  const configPath = resolve(PROJECT_ROOT, "data", "config.json");
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));

  const unsplashAccessKey = process.env.UNSPLASH_ACCESS_KEY ?? "";
  if (!unsplashAccessKey) {
    console.warn(
      "Warning: UNSPLASH_ACCESS_KEY not set. Copy .env.example to .env and add your key."
    );
  }

  // Resolve ~ to the actual home directory (cross-platform via os.homedir)
  const home = getHomedir();
  const archivePath = raw.archivePath.replace("~", home);
  const cachePath = resolve(home, ".cache", "inspiration");

  return {
    activeSources: raw.activeSources,
    resolution: raw.resolution,
    font: raw.font,
    background: raw.background,
    archivePath,
    setAllDisplays: raw.setAllDisplays,
    scheduledTime: raw.scheduledTime ?? { hour: 7, minute: 0 },
    unsplashAccessKey,
    projectRoot: PROJECT_ROOT,
    cachePath,
  };
}
