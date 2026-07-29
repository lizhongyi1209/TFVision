// Server-side settings persistence to data/settings.json (gitignored).
// The API token lives here, on the local machine, never shipped to the browser.
// Single-user local app — no multi-tenant layer (unlike TVision's tenant.server.ts).

import { promises as fs } from "fs";
import path from "path";
import type { PublicSettings, Settings } from "./types";
import { DEFAULT_ROUTE, normalizeRouteName } from "./networkRoutes";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const DEFAULTS: Settings = {
  apiKey: "",
  route: DEFAULT_ROUTE,
  defaults: { model: "Nano Banana Pro", resolution: "2K", billing: "特价", aspectRatio: "auto" },
};

export async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULTS,
      ...parsed,
      route: normalizeRouteName(parsed.route),
      defaults: { ...DEFAULTS.defaults, ...(parsed.defaults || {}) },
    };
  } catch {
    return { ...DEFAULTS, defaults: { ...DEFAULTS.defaults } };
  }
}

export async function writeSettings(patch: Partial<Settings> & { clearApiKey?: boolean }): Promise<Settings> {
  const cur = await readSettings();
  const { clearApiKey, ...rest } = patch;
  const next: Settings = {
    ...cur,
    ...rest,
    defaults: { ...cur.defaults, ...(rest.defaults || {}) },
  };
  if (clearApiKey) next.apiKey = "";
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export function toPublic(s: Settings): PublicSettings {
  const { apiKey, ...rest } = s;
  const masked = apiKey ? `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}` : "";
  return { ...rest, hasApiKey: !!apiKey, apiKeyMasked: masked };
}
