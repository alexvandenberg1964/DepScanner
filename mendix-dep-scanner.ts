#!/usr/bin/env ts-node
/**
 * Mendix Dependency Scanner v5 — Public Cloud Edition
 * ─────────────────────────────────────────────────────────────────────────────
 * What it scans:
 *   - Only Marketplace modules (module.fromAppStore === true)
 *   - Only apps that have a Production environment with a deployed package
 *   - Widgets are skipped (not on Marketplace in the same way)
 *
 * Data sources:
 *
 *   MENDIX VERSION
 *     Deploy API: GET /api/1/apps/<AppId>/environments/Production
 *     Returns MendixVersion of the actual running production package.
 *     Apps without a production environment are skipped entirely.
 *
 *   MARKETPLACE CONTENT API
 *     Endpoint: https://marketplace-api.mendix.com/v1/content
 *     Confirmed working from SoapUI test. Response shape:
 *     { items: [{
 *         contentId: number,
 *         publisher: string,
 *         type: string,
 *         categories: [{ name: string }],
 *         supportCategory: string,        // "Platform" | "Partner" | "Community"
 *         licenseUrl: string,
 *         isPrivate: boolean,
 *         latestVersion: {
 *           name: string,
 *           versionId: string,
 *           versionNumber: string,
 *           minSupportedMendixVersion: string,
 *           publicationDate: string
 *         }
 *     }] }
 *     Auth: MxToken <PAT> header.
 *
 *   BRANCH AUTO-DETECTION
 *     repository.getInfo() → type "svn" → "trunk", type "git" → "main"
 *
 * Authentication:
 *   export MENDIX_TOKEN="<pat>"          # https://warden.mendix.com
 *                                          scope: mx:modelrepository:repo:write
 *   export MENDIX_USERNAME="you@co.nl"  # Mendix login email
 *   export MENDIX_API_KEY="<key>"       # Mendix Profile → API Keys
 *
 * Usage:
 *   npx ts-node mendix-dep-scanner.ts --all-apps --format json --output report.json
 *   npx ts-node mendix-dep-scanner.ts --list-apps
 *   npx ts-node mendix-dep-scanner.ts --app <project-id> [--app <id> ...]
 *
 * Install:
 *   npm install mendixplatformsdk mendixmodelsdk dotenv
 *   npm install -D typescript ts-node @types/node @types/dotenv
 *
 * Create a .env file in the project root:
 *   MENDIX_TOKEN=your-pat-from-warden.mendix.com
 *   MENDIX_USERNAME=you@postnl.nl
 *   MENDIX_API_KEY=your-api-key
 */

import * as dotenv from "dotenv";
dotenv.config();

import { MendixPlatformClient, setPlatformConfig } from "mendixplatformsdk";
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";

// ─── CLI ──────────────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "all-apps":       { type: "boolean", default: false },
    "list-apps":      { type: "boolean", default: false },
    app:              { type: "string",  multiple: true },
    branch:           { type: "string" },
    exclude:          { type: "string",  multiple: true },
    concurrency:      { type: "string",  default: "3" },
    format:           { type: "string",  default: "table" },
    output:           { type: "string" },
    "no-marketplace": { type: "boolean", default: false },
    verbose:          { type: "boolean", default: false },
    help:             { type: "boolean", default: false },
  },
});

if (flags.help || (!flags["all-apps"] && !flags["list-apps"] && !flags.app?.length)) {
  console.log(`
Mendix Dependency Scanner v5

Modes:
  --all-apps                   Scan every app with a Production environment
  --list-apps                  Print app list and exit
  --app <project-id>           Scan specific app(s) by Project ID (repeatable)

Options:
  --branch <n>              Override branch (default: auto-detected per app)
  --exclude <pattern>          Skip apps whose name matches this regex (repeatable)
  --concurrency <n>            Parallel scans (default: 3)
  --format json|table|markdown Output format (default: table)
  --output <file>              Write to file instead of stdout
  --no-marketplace             Skip Marketplace Content API calls
  --verbose                    Debug output
  --help                       This help

Environment:
  MENDIX_TOKEN      PAT from https://warden.mendix.com
                    Scope needed: mx:modelrepository:repo:write
  MENDIX_USERNAME   Your Mendix login email
  MENDIX_API_KEY    API key from Mendix Profile → API Keys

Notes:
  - Apps without a Production environment are skipped automatically
  - Only Marketplace modules (fromAppStore=true) are shown; custom app modules are excluded
`.trim());
  process.exit(0);
}

const VERBOSE         = flags.verbose         ?? false;
const NO_MARKETPLACE  = flags["no-marketplace"] ?? false;
const BRANCH_OVERRIDE = flags.branch;
const CONCURRENCY     = Math.max(1, parseInt(flags.concurrency ?? "3", 10));
const EXCLUDES        = (flags.exclude ?? []).map(p => new RegExp(p, "i"));

const PAT     = process.env.MENDIX_TOKEN    ?? "";
const MX_USER = process.env.MENDIX_USERNAME ?? "";
const MX_AKEY = process.env.MENDIX_API_KEY  ?? "";
const MX_PAT = process.env.MENDIX_MARKETPLACE_TOKEN  ?? PAT;

if (!PAT) {
  console.error("ERROR: MENDIX_TOKEN is not set. Create a PAT at https://warden.mendix.com");
  process.exit(1);
}
if ((flags["all-apps"] || flags["list-apps"]) && (!MX_USER || !MX_AKEY)) {
  console.error("ERROR: --all-apps / --list-apps require MENDIX_USERNAME and MENDIX_API_KEY.");
  process.exit(1);
}

function dbg(...args: unknown[]) { if (VERBOSE) console.error("[debug]", ...args); }

// ─── Types ────────────────────────────────────────────────────────────────────

interface DeployApp {
  AppId: string;       // subdomain, e.g. "myapp"
  Name: string;
  ProjectId: string;   // UUID — used by Platform SDK
  Url: string;
}

interface ProductionInfo {
  mxVersion: string;   // from Deploy API MendixVersion field
  modelVersion: string; // from Deploy API ModelVersion field
}

interface Dependency {
  type: "module";
  name: string;
  version: string;           // appStoreVersion from model
  packageId: number | null;  // appStorePackageId = contentId in Marketplace API
  marketplace?: MarketplaceInfo;
}

interface MarketplaceInfo {
  found: boolean;
  contentId?: number;
  name?: string;
  url?: string;
  publisher?: string;
  supportCategory?: string;        // "Platform" | "Partner" | "Community"
  licenseUrl?: string;
  latestVersionNumber?: string;    // absolute latest, regardless of Mx compat
  minSupportedMendixVersion?: string; // min Mx for latest version
  bestCompatibleVersion?: string;  // highest version compatible with the app's Mx version
  bestCompatibleMinMx?: string;    // min Mx required for that best compatible version
  updateAvailable?: boolean;       // true if bestCompatibleVersion > installedVersion
  latestIsNewer?: boolean;         // true if latestVersionNumber > bestCompatibleVersion
  mxCompatible?: boolean;          // whether the LATEST version is compatible
  mxCompatibilityNote?: string;
}

interface AppReport {
  appId: string;
  appSubdomain: string;
  appName: string;
  appUrl: string;
  mxVersion: string;
  modelVersion: string;
  repoType: string;
  branch: string;
  scanStatus: "ok" | "error" | "skipped";
  scanError?: string;
  deps: Dependency[];
}

// ─── Deploy API ───────────────────────────────────────────────────────────────

const DEPLOY_HEADERS = {
  "Content-Type":    "application/json",
  "Mendix-Username": MX_USER,
  "Mendix-ApiKey":   MX_AKEY,
};

async function deployGet<T>(path: string): Promise<T | null> {
  if (!MX_USER || !MX_AKEY) return null;
  try {
    const res = await fetch(`https://deploy.mendix.com/api/1${path}`, {
      headers: DEPLOY_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) { dbg(`Deploy API ${res.status} → ${path}`); return null; }
    return await res.json() as T;
  } catch (e) {
    dbg("Deploy API error:", (e as Error).message);
    return null;
  }
}

async function fetchAllApps(): Promise<DeployApp[]> {
  console.error("[Deploy API] Fetching app list...");
  const res = await fetch("https://deploy.mendix.com/api/1/apps", {
    headers: DEPLOY_HEADERS,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Deploy API ${res.status}: ${await res.text().catch(() => "")}`);
  const apps = await res.json() as DeployApp[];
  console.error(`[Deploy API] Found ${apps.length} apps`);
  return apps;
}

/**
 * Fetch Production environment info for an app.
 * Returns null if the app has no Production environment or no deployed package.
 * This is used both to get the Mendix version AND to filter out apps with no production.
 */
async function fetchProductionInfo(appSubdomain: string): Promise<ProductionInfo | null> {
  if (!appSubdomain || !MX_USER || !MX_AKEY) return null;

  const env = await deployGet<{
    Status?: string;
    MendixVersion?: string;
    ModelVersion?: string;
    Mode?: string;
  }>(`/apps/${appSubdomain}/environments/Production`);

  // No production environment, or environment exists but has no package deployed yet
  if (!env || !env.MendixVersion) {
    dbg(`No production info for "${appSubdomain}"`);
    return null;
  }

  return {
    mxVersion:    env.MendixVersion,
    modelVersion: env.ModelVersion ?? "Unknown",
  };
}

// ─── Marketplace Content API ──────────────────────────────────────────────────
//
// Confirmed endpoint from SoapUI test: https://marketplace-api.mendix.com/v1/content
// Auth: MxToken <PAT> in Authorization header
// Response: { items: [{ contentId, publisher, type, categories, supportCategory,
//                       licenseUrl, isPrivate, latestVersion: { name, versionNumber,
//                       minSupportedMendixVersion, ... } }] }

const MKT_BASE = "https://marketplace-api.mendix.com/v1/content";
const mktCache = new Map<string, unknown>();

async function mktGet<T>(url: string): Promise<T | null> {
  if (NO_MARKETPLACE) return null;
  if (mktCache.has(url)) return mktCache.get(url) as T;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept":        "application/json",
        "Authorization": `MxToken ${MX_PAT}`,
        "User-Agent":    "mendix-dep-scanner/5.0 (PostNL)",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      dbg(`Marketplace ${res.status} → ${url} | body: ${body.slice(0, 300)}`);
      return null;
    }
    const text = await res.text();
    dbg(`Marketplace response for ${url.replace("https://marketplace-api.mendix.com/v1/content","")}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text) as T;
    mktCache.set(url, data);
    return data;
  } catch (e) {
    dbg("Marketplace error:", (e as Error).message);
    return null;
  }
}

interface MktItem {
  contentId: number;
  publisher: string;
  type: string;
  categories: Array<{ name: string }>;
  supportCategory: string;
  licenseUrl: string;
  isPrivate: boolean;
  latestVersion: {
    name: string;
    versionId: string;
    versionNumber: string;
    minSupportedMendixVersion: string;
    publicationDate: string;
  };
}

interface MktResponse { items: MktItem[]; }

interface MktVersion {
  versionNumber: string;
  minSupportedMendixVersion: string;
  publicationDate: string;
}

function buildMarketplaceInfo(
  item: MktItem,
  currentVersion: string,
  mxVersion: string,
  bestCompatible: MktVersion | null
): MarketplaceInfo {
  const latest    = item.latestVersion?.versionNumber ?? "Unknown";
  const latestMin = item.latestVersion?.minSupportedMendixVersion ?? null;

  // Best compatible: highest version whose minSupportedMendixVersion <= app's Mx version.
  // Falls back to the latest version when no versions list is available.
  const bestVer    = bestCompatible?.versionNumber ?? latest;
  const bestMinMx  = bestCompatible?.minSupportedMendixVersion ?? latestMin;

  // updateAvailable: is there a COMPATIBLE version newer than what's installed?
  const updateAvailable = currentVersion && bestVer !== "Unknown"
    ? semverCmp(currentVersion, bestVer) < 0
    : false;

  // latestIsNewer: the absolute latest is ahead of the best compatible version
  const latestIsNewer = bestVer !== "Unknown" && latest !== "Unknown" && bestVer !== latest
    ? semverCmp(bestVer, latest) < 0
    : false;

  // mxCompatible: can the LATEST version run on this app's Mx version?
  let mxCompatible: boolean | undefined;
  let mxCompatibilityNote: string | undefined;
  if (latestMin && mxVersion && mxVersion !== "Unknown") {
    mxCompatible = semverCmp(mxVersion, latestMin) >= 0;
    mxCompatibilityNote = mxCompatible
      ? `✓ Compatible (requires Mx >= ${latestMin})`
      : `⚠ Latest requires Mx >= ${latestMin}, project uses ${mxVersion}`;
  }

  return {
    found:                    true,
    contentId:                item.contentId,
    name:                     item.latestVersion?.name ?? "Unknown",
    url:                      `https://marketplace.mendix.com/link/component/${item.contentId}`,
    publisher:                item.publisher,
    supportCategory:          item.supportCategory,
    licenseUrl:               item.licenseUrl,
    latestVersionNumber:      latest,
    minSupportedMendixVersion: latestMin ?? undefined,
    bestCompatibleVersion:    bestVer,
    bestCompatibleMinMx:      bestMinMx ?? undefined,
    updateAvailable,
    latestIsNewer,
    mxCompatible,
    mxCompatibilityNote,
  };
}

/**
 * Look up a module on the Marketplace by contentId.
 *
 * Step 1: GET /v1/content/{packageId}          — base module info + absolute latest version
 * Step 2: GET /v1/content/{packageId}/versions  — all versions with their minSupportedMendixVersion
 *
 * From the versions list we find the BEST COMPATIBLE version: the highest version
 * whose minSupportedMendixVersion is <= the app's Mx version. This is what you
 * should actually update to — not the absolute latest which may require a newer runtime.
 *
 * Both are reported:
 *   bestCompatibleVersion — safe to install on this app today
 *   latestVersionNumber   — the absolute latest (may require a higher Mx version)
 */
async function lookupMarketplace(
  name: string,
  packageId: number | null,
  currentVersion: string,
  mxVersion: string
): Promise<MarketplaceInfo> {

  if (!packageId || packageId <= 0) {
    dbg(`No packageId for "${name}" — skipping Marketplace lookup`);
    return { found: false };
  }

  // Step 1: fetch base content
  const item = await mktGet<MktItem>(`${MKT_BASE}/${packageId}`);
  if (!item || typeof item.contentId !== "number") {
    dbg(`No valid response from GET /content/${packageId} for "${name}"`);
    return { found: false };
  }

  // Step 2: fetch all versions to find best compatible with app's Mx version
  let bestCompatible: MktVersion | null = null;
  if (mxVersion && mxVersion !== "Unknown") {
    // The /versions endpoint may return a raw array OR { items: [] } OR { versions: [] }
    // We normalise all three shapes into a plain array.
    const raw = await mktGet<unknown>(`${MKT_BASE}/${packageId}/versions`);
    const versions: MktVersion[] = Array.isArray(raw)
      ? raw as MktVersion[]
      : Array.isArray((raw as Record<string, unknown>)?.["items"])
        ? (raw as Record<string, unknown>)["items"] as MktVersion[]
        : Array.isArray((raw as Record<string, unknown>)?.["versions"])
          ? (raw as Record<string, unknown>)["versions"] as MktVersion[]
          : [];

    dbg(`Versions for "${name}" (contentId ${packageId}): ${versions.length} entries`);

    if (versions.length) {
      // Filter: keep only versions whose minSupportedMendixVersion <= app's Mx version
      const compatible = versions.filter(v =>
        v.minSupportedMendixVersion && semverCmp(mxVersion, v.minSupportedMendixVersion) >= 0
      );
      if (compatible.length) {
        // Sort descending, pick highest compatible version
        compatible.sort((a, b) => semverCmp(b.versionNumber, a.versionNumber));
        bestCompatible = compatible[0];
        dbg(`Best compatible for "${name}" (Mx ${mxVersion}): ${bestCompatible.versionNumber} (latest: ${item.latestVersion?.versionNumber})`);
      } else {
        dbg(`No compatible version for "${name}" with Mx ${mxVersion} — all require a higher runtime`);
      }
    }
  }

  return buildMarketplaceInfo(item, currentVersion, mxVersion, bestCompatible);
}

function semverCmp(a: string, b: string): number {
  const clean = (s: string) => s.replace(/[^\d.]/g, "").split(".").map(Number);
  const pa = clean(a), pb = clean(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ─── Platform SDK + Model SDK scan ───────────────────────────────────────────

async function scanApp(
  client: MendixPlatformClient,
  projectId: string,
  meta: Partial<DeployApp> = {}
): Promise<AppReport> {

  const base: AppReport = {
    appId:        projectId,
    appSubdomain: meta.AppId  ?? "",
    appName:      meta.Name   ?? projectId,
    appUrl:       meta.Url    ?? "",
    mxVersion:    "Unknown",
    modelVersion: "Unknown",
    repoType:     "Unknown",
    branch:       BRANCH_OVERRIDE ?? "auto",
    scanStatus:   "ok",
    deps:         [],
  };

  try {
    // ── Step 1: Check Production environment — skip if none ─────────────────
    // Apps without a production environment are not relevant for dependency governance.
    if (base.appSubdomain) {
      const prodInfo = await fetchProductionInfo(base.appSubdomain);
      if (!prodInfo) {
        console.error(`      ⊘ No production environment — skipping`);
        base.scanStatus = "skipped";
        return base;
      }
      base.mxVersion    = prodInfo.mxVersion;
      base.modelVersion = prodInfo.modelVersion;
      console.error(`      Mx ver: ${base.mxVersion}  Model: ${base.modelVersion}`);
    }

    // ── Step 2: Enrich app name from Platform SDK if needed ─────────────────
    const app = client.getApp(projectId);
    if (!meta.Name || meta.Name === projectId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = await (app as any).getInfo?.();
        if (info?.name) base.appName = info.name;
      } catch { /* non-fatal */ }
    }
    console.error(`\n[SDK] ${base.appName} (${projectId})`);

    // ── Step 3: Auto-detect repo type → correct branch ──────────────────────
    let branchToUse = BRANCH_OVERRIDE ?? "main";
    try {
      const repo = app.getRepository();
      const repoInfo = await repo.getInfo();
      base.repoType = repoInfo.type ?? "Unknown";
      if (!BRANCH_OVERRIDE) {
        branchToUse = repoInfo.type === "svn" ? "trunk" : "main";
      }
      console.error(`      Repo: ${base.repoType} → branch "${branchToUse}"`);
    } catch (e) {
      dbg("repo.getInfo() failed:", (e as Error).message);
    }
    base.branch = branchToUse;

    // ── Step 4: Open model — collect Marketplace modules only ───────────────
    const wc    = await app.createTemporaryWorkingCopy(branchToUse);
    const model = await wc.openModel();

    const allModules = model.allModules();
    let marketplaceModuleCount = 0;

    for (const mod of allModules) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = mod as any;

      // Skip custom app modules — only interested in Marketplace modules
      if (!m.fromAppStore) continue;

      marketplaceModuleCount++;
      base.deps.push({
        type:            "module",
        name:            m.name ?? "Unknown",
        version:         m.appStoreVersion ?? "Unknown",
        packageId:       m.appStorePackageId ? Number(m.appStorePackageId) : null,
      });
    }

    console.error(`      Modules: ${allModules.length} total, ${marketplaceModuleCount} from Marketplace`);

  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error(`      ✗ FAILED: ${msg}`);
    base.scanStatus = "error";
    base.scanError  = msg;
  }

  return base;
}

// ─── Marketplace enrichment ───────────────────────────────────────────────────

async function enrichReport(report: AppReport): Promise<void> {
  if (report.scanStatus !== "ok" || !report.deps.length) return;

  const total = report.deps.length;
  console.error(`\n[Marketplace] Enriching ${total} modules for "${report.appName}"...`);
  let done = 0;

  for (const dep of report.deps) {
    dep.marketplace = await lookupMarketplace(
      dep.name,
      dep.packageId,
      dep.version,
      report.mxVersion
    );
    done++;
    process.stderr.write(`\r[Marketplace] ${done}/${total} — ${dep.name.slice(0, 52).padEnd(52)}`);
    await new Promise(r => setTimeout(r, 200)); // gentle throttle
  }
  process.stderr.write("\n");
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function pLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatTable(reports: AppReport[]): string {
  const W = { name: 40, cur: 10, lat: 10, upd: 7, compat: 36, tier: 22, publisher: 22, lic: 40 };
  const sep = Object.values(W).map(w => "─".repeat(w + 2)).join("┼");
  const hdr = [
    "Module Name".padEnd(W.name), "Installed".padEnd(W.cur),
    "Latest".padEnd(W.lat), "Update?".padEnd(W.upd), "Mx Compatibility".padEnd(W.compat),
    "Support".padEnd(W.tier), "Publisher".padEnd(W.publisher), "License URL".padEnd(W.lic),
  ].join(" │ ");

  const lines: string[] = [];
  const okReports = reports.filter(r => r.scanStatus !== "skipped");

  for (const r of okReports) {
    lines.push(`\n${"═".repeat(190)}`);
    if (r.scanStatus === "error") {
      lines.push(`  ✗ ${r.appName}  (${r.appId})\n  Error: ${r.scanError}`);
      continue;
    }
    lines.push(`  ${r.appName}`);
    lines.push(`  URL: ${r.appUrl || "—"}   Repo: ${r.repoType}/${r.branch}   Mx: ${r.mxVersion}   Model: ${r.modelVersion}`);
    lines.push("═".repeat(190), " " + hdr, " " + sep);

    if (!r.deps.length) {
      lines.push("  (no Marketplace modules found)");
      continue;
    }

    for (const d of r.deps) {
      const m = d.marketplace;
      const compat = m?.mxCompatibilityNote ?? "n/a";
      lines.push(" " + [
        d.name.slice(0, W.name).padEnd(W.name),
        (d.version || "?").slice(0, W.cur).padEnd(W.cur),
        (m?.latestVersionNumber ?? "n/a").slice(0, W.lat).padEnd(W.lat),
        (m?.updateAvailable ? "  YES " : m?.found ? "  no  " : "   —  ").padEnd(W.upd),
        compat.slice(0, W.compat).padEnd(W.compat),
        (m?.supportCategory ?? "n/a").slice(0, W.tier).padEnd(W.tier),
        (m?.publisher ?? "n/a").slice(0, W.publisher).padEnd(W.publisher),
        (m?.licenseUrl ?? "n/a").slice(0, W.lic).padEnd(W.lic),
      ].join(" │ "));
    }

    const upd   = r.deps.filter(d => d.marketplace?.updateAvailable).length;
    const warns = r.deps.filter(d => d.marketplace?.mxCompatible === false).length;
    lines.push(`\n  ↑ Updates: ${upd}   ⚠ Compat warnings: ${warns}`);
  }

  const skipped = reports.filter(r => r.scanStatus === "skipped").length;
  if (skipped) lines.push(`\n(${skipped} app${skipped > 1 ? "s" : ""} skipped — no production environment)`);

  return lines.join("\n");
}

function formatMarkdown(reports: AppReport[]): string {
  const lines = [
    "# Mendix Marketplace Module Report",
    "",
    `_Generated: ${new Date().toISOString()}_`,
    `_Apps with production: ${reports.filter(r => r.scanStatus !== "skipped").length} / ${reports.length}_`,
    "",
  ];

  for (const r of reports) {
    if (r.scanStatus === "skipped") continue;

    lines.push(`## ${r.appName}`, "");
    if (r.scanStatus === "error") {
      lines.push(`> ⚠ **Scan failed:** ${r.scanError}`, "");
      continue;
    }

    lines.push(`| | |`, `|-|-|`);
    lines.push(`| **App ID** | \`${r.appId}\` |`);
    lines.push(`| **URL** | ${r.appUrl || "—"} |`);
    lines.push(`| **Repo** | ${r.repoType} / branch: ${r.branch} |`);
    lines.push(`| **Mendix version** | ${r.mxVersion} |`);
    lines.push(`| **Model version** | ${r.modelVersion} |`);
    lines.push(`| **Marketplace modules** | ${r.deps.length} |`, "");

    if (!r.deps.length) { lines.push("_No Marketplace modules found._", ""); continue; }

    lines.push("| Module | Installed | Latest | Update? | Mx Compatibility | Support | Publisher | License |");
    lines.push("|--------|-----------|--------|---------|-----------------|---------|-----------|---------|");

    for (const d of r.deps) {
      const m = d.marketplace;
      const nameCell = m?.url ? `[${d.name}](${m.url})` : d.name;
      const updateCell = m?.updateAvailable ? "✅ YES" : m?.found ? "✔ no" : "—";
      const compatCell = m?.mxCompatibilityNote ?? "n/a";
      const licCell = m?.licenseUrl ? `[License](${m.licenseUrl})` : "n/a";
      lines.push(`| ${nameCell} | ${d.version || "?"} | ${m?.latestVersionNumber ?? "n/a"} | ${updateCell} | ${compatCell} | ${m?.supportCategory ?? "n/a"} | ${m?.publisher ?? "n/a"} | ${licCell} |`);
    }

    const upd   = r.deps.filter(d => d.marketplace?.updateAvailable).length;
    const warns = r.deps.filter(d => d.marketplace?.mxCompatible === false).length;
    if (upd || warns) lines.push(``, `> ↑ Updates: **${upd}**   ⚠ Compat warnings: **${warns}**`);
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.error("\n🔍 Mendix Dependency Scanner v5 — Public Cloud\n");

  setPlatformConfig({ mendixToken: PAT });
  const client = new MendixPlatformClient();

  // Resolve app list
  let appsToScan: DeployApp[] = [];

  if (flags["all-apps"] || flags["list-apps"]) {
    const all = await fetchAllApps();
    const filtered = all.filter(a => !EXCLUDES.some(rx => rx.test(a.Name)));
    if (EXCLUDES.length) console.error(`[Filter] Excluded ${all.length - filtered.length} apps by pattern`);
    appsToScan = filtered;
  }

  if (flags.app?.length) {
    for (const id of flags.app) {
      if (!appsToScan.some(a => a.ProjectId === id))
        appsToScan.push({ ProjectId: id, AppId: "", Name: id, Url: "" });
    }
  }

  if (flags["list-apps"]) {
    console.log("\nApps accessible to your API key:\n");
    console.log(["ProjectId (UUID)".padEnd(38), "AppId (subdomain)".padEnd(30), "Name"].join("  "));
    console.log("─".repeat(90));
    for (const a of appsToScan)
      console.log([a.ProjectId.padEnd(38), (a.AppId || "").padEnd(30), a.Name].join("  "));
    console.log(`\nTotal: ${appsToScan.length} apps`);
    return;
  }

  if (!appsToScan.length) {
    console.error("No apps to scan. Use --all-apps or --app <project-id>.");
    process.exit(1);
  }

  console.error(`\n[Scan] ${appsToScan.length} app(s) · concurrency: ${CONCURRENCY}`);
  if (BRANCH_OVERRIDE) console.error(`[Scan] Branch override: "${BRANCH_OVERRIDE}"`);
  else                 console.error(`[Scan] Branch: auto-detected per app (SVN→trunk, Git→main)`);
  console.error(`[Scan] Apps without Production environment will be skipped`);

  const metaMap = new Map(appsToScan.map(a => [a.ProjectId, a]));

  const reports = await pLimit(appsToScan, CONCURRENCY, async (app, i) => {
    console.error(`\n[${i + 1}/${appsToScan.length}] ${app.Name}`);
    const report = await scanApp(client, app.ProjectId, metaMap.get(app.ProjectId));
    if (report.scanStatus === "ok") await enrichReport(report);
    return report;
  });

  // Build summary stats (exclude skipped apps)
  const active  = reports.filter(r => r.scanStatus === "ok");
  const allDeps = active.flatMap(r => r.deps);

  const fullReport = {
    scannedAt: new Date().toISOString(),
    apps: reports,
    summary: {
      appsTotal:     reports.length,
      appsScanned:   active.length,
      appsSkipped:   reports.filter(r => r.scanStatus === "skipped").length,
      appsFailed:    reports.filter(r => r.scanStatus === "error").length,
      totalModules:  allDeps.length,
      updatesAvail:  allDeps.filter(d => d.marketplace?.updateAvailable).length,
      compatWarns:   allDeps.filter(d => d.marketplace?.mxCompatible === false).length,
      bySupport: {
        Platform:  allDeps.filter(d => d.marketplace?.supportCategory === "Platform").length,
        Partner:   allDeps.filter(d => d.marketplace?.supportCategory === "Partner").length,
        Community: allDeps.filter(d => d.marketplace?.supportCategory === "Community").length,
        Unknown:   allDeps.filter(d => d.marketplace?.found && !d.marketplace.supportCategory).length,
        NotFound:  allDeps.filter(d => !d.marketplace?.found).length,
      },
    },
  };

  const fmt = flags.format ?? "table";
  const output =
    fmt === "json"     ? JSON.stringify(fullReport, null, 2) :
    fmt === "markdown" ? formatMarkdown(reports) :
                         formatTable(reports);

  if (flags.output) {
    await writeFile(flags.output, output, "utf8");
    console.error(`\n✅ Report written to: ${flags.output}`);
  } else {
    console.log(output);
  }

  const s = fullReport.summary;
  console.error(`
Summary
────────────────────────────────────
  Apps total          : ${s.appsTotal}
    Scanned           : ${s.appsScanned}
    Skipped (no prod) : ${s.appsSkipped}
    Failed            : ${s.appsFailed}
  Marketplace modules : ${s.totalModules}
    Updates available : ${s.updatesAvail}
    Compat warnings   : ${s.compatWarns}
  Support breakdown   :
    Platform          : ${s.bySupport.Platform}
    Partner           : ${s.bySupport.Partner}
    Community         : ${s.bySupport.Community}
    Not on Marketplace: ${s.bySupport.NotFound}
────────────────────────────────────`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
