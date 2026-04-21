#!/usr/bin/env ts-node
/**
 * Mendix Dependency Scanner v6 — Public Cloud Edition
 * ─────────────────────────────────────────────────────────────────────────────
 * What it scans:
 *   - ALL apps accessible to your PAT — no production environment filtering
 *   - Only Marketplace modules (module.fromAppStore === true)
 *
 * Data sources:
 *
 *   APP LIST
 *     Deploy API: GET https://deploy.mendix.com/api/1/apps
 *     Auth: MENDIX_TOKEN (PAT) only — no Deploy API credentials needed.
 *
 *   MENDIX VERSION
 *     Read from the model itself: model.root.mendixVersion after loading the
 *     Project unit. This reflects the Studio Pro version the model was saved
 *     with — no Deploy API or production environment required.
 *
 *   BRANCH AUTO-DETECTION
 *     repository.getInfo() → type "svn" → "trunk", type "git" → "main"
 *
 *   MARKETPLACE CONTENT API
 *     GET https://marketplace-api.mendix.com/v1/content/{packageId}
 *     GET https://marketplace-api.mendix.com/v1/content/{packageId}/versions
 *     Auth: MxToken <PAT> header.
 *     Response: single MktItem object (not wrapped in { items: [] })
 *
 * Authentication (.env file):
 *   MENDIX_TOKEN=your-pat-from-warden.mendix.com
 *   MENDIX_USERNAME=you@postnl.nl
 *   MENDIX_API_KEY=your-api-key-from-mendix-profile
 *
 * Usage:
 *   npx ts-node mendix-dep-scanner.ts --all-apps --format json --output report.json
 *   npx ts-node mendix-dep-scanner.ts --list-apps
 *   npx ts-node mendix-dep-scanner.ts --app <project-id> [--app <id> ...]
 *
 * Install:
 *   npm install mendixplatformsdk mendixmodelsdk dotenv
 *   npm install -D typescript ts-node @types/node
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
Mendix Dependency Scanner v6

Modes:
  --all-apps                   Scan every app accessible to your PAT
  --list-apps                  Print app list and exit
  --app <project-id>           Scan specific app(s) by Project ID (repeatable)

Options:
  --branch <name>              Override branch (default: auto-detected per app)
  --exclude <pattern>          Skip apps whose name matches this regex (repeatable)
  --concurrency <n>            Parallel scans (default: 3)
  --format json|table|markdown Output format (default: table)
  --output <file>              Write to file instead of stdout
  --no-marketplace             Skip Marketplace Content API calls
  --verbose                    Debug output
  --help                       This help

Environment:
  MENDIX_TOKEN      PAT from https://warden.mendix.com
                    Scope: mx:modelrepository:repo:write
  MENDIX_USERNAME   Mendix login email  (needed for --all-apps / --list-apps)
  MENDIX_API_KEY    API key from Mendix Profile → API Keys  (same)

Notes:
  - All apps accessible to the PAT are scanned — no production filtering
  - Mendix version is read from the model (Studio Pro save version)
  - Only Marketplace modules (fromAppStore=true) are included
`.trim());
  process.exit(0);
}

const VERBOSE        = flags.verbose         ?? false;
const NO_MARKETPLACE = flags["no-marketplace"] ?? false;
const BRANCH_OVERRIDE = flags.branch;
const CONCURRENCY    = Math.max(1, parseInt(flags.concurrency ?? "3", 10));
const EXCLUDES       = (flags.exclude ?? []).map(p => new RegExp(p, "i"));

const PAT     = process.env.MENDIX_TOKEN    ?? "";
const MX_USER = process.env.MENDIX_USERNAME ?? "";
const MX_AKEY = process.env.MENDIX_API_KEY  ?? "";

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

interface AppMeta {
  appId:       string;  // Project UUID
  name:        string;
  url:         string;
  subdomain?:  string;  // Deploy API AppId (subdomain), used to fetch Mx version
}

interface Dependency {
  type: "module";
  name: string;
  version: string;
  packageId: number | null;
  marketplace?: MarketplaceInfo;
}

interface MarketplaceInfo {
  found: boolean;
  contentId?: number;
  name?: string;
  url?: string;
  publisher?: string;
  supportCategory?: string;
  licenseUrl?: string;
  latestVersionNumber?: string;
  minSupportedMendixVersion?: string;
  bestCompatibleVersion?: string;
  bestCompatibleMinMx?: string;
  updateAvailable?: boolean;
  latestIsNewer?: boolean;
  mxCompatible?: boolean;
  mxCompatibilityNote?: string;
}

interface AppReport {
  appId: string;
  appName: string;
  appUrl: string;
  mxVersion: string;
  repoType: string;
  branch: string;
  scanStatus: "ok" | "error";
  scanError?: string;
  deps: Dependency[];
}

// ─── App list — Deploy API ────────────────────────────────────────────────────
// Confirmed working: GET https://deploy.mendix.com/api/1/apps
// Auth: Mendix-Username + Mendix-ApiKey headers
// Returns all apps the user has access to (licensed + free apps on Mendix Cloud)

interface DeployApp {
  AppId:     string;   // subdomain
  Name:      string;
  ProjectId: string;   // UUID — used by Platform SDK and as appId
  Url:       string;
}

async function fetchAllApps(): Promise<AppMeta[]> {
  console.error("[Deploy API] Fetching app list...");
  const res = await fetch("https://deploy.mendix.com/api/1/apps", {
    headers: {
      "Content-Type":    "application/json",
      "Mendix-Username": MX_USER,
      "Mendix-ApiKey":   MX_AKEY,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Deploy API ${res.status}: ${await res.text().catch(() => "")}`);
  const apps = await res.json() as DeployApp[];
  console.error(`[Deploy API] Found ${apps.length} apps`);
  return apps.map(a => ({
    appId:     a.ProjectId,
    name:      a.Name,
    url:       a.Url ?? "",
    subdomain: a.AppId,
  }));
}


// ─── Deploy API — Mx version lookup ──────────────────────────────────────────
// Fetches the Mendix runtime version from the Production environment.
// This is optional — if it fails or no production exists, mxVersion stays "Unknown".
// Tries Production → Acceptance → Test in order.

async function fetchMxVersionFromDeploy(appSubdomain: string): Promise<string> {
  if (!MX_USER || !MX_AKEY || !appSubdomain) return "Unknown";
  for (const mode of ["Production", "Acceptance", "Test"]) {
    try {
      const res = await fetch(`https://deploy.mendix.com/api/1/apps/${appSubdomain}/environments/${mode}`, {
        headers: {
          "Content-Type":    "application/json",
          "Mendix-Username": MX_USER,
          "Mendix-ApiKey":   MX_AKEY,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const env = await res.json() as { MendixVersion?: string };
      if (env?.MendixVersion) {
        dbg(`Mx version from ${mode} env: ${env.MendixVersion}`);
        return env.MendixVersion;
      }
    } catch { /* try next */ }
  }
  return "Unknown";
}

// ─── Marketplace Content API ──────────────────────────────────────────────────

const MKT_BASE = "https://marketplace-api.mendix.com/v1/content";
const mktCache = new Map<string, unknown>();

async function mktGet<T>(url: string): Promise<T | null> {
  if (NO_MARKETPLACE) return null;
  if (mktCache.has(url)) return mktCache.get(url) as T;
  try {
    const res = await fetch(url, {
      headers: {
        "Accept":        "application/json",
        "Authorization": `MxToken ${PAT}`,
        "User-Agent":    "mendix-dep-scanner/6.0 (PostNL)",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      dbg(`Marketplace ${res.status} → ${url} | ${body.slice(0, 200)}`);
      return null;
    }
    const text = await res.text();
    dbg(`Marketplace ← ${url.replace(MKT_BASE, "")}: ${text.slice(0, 120)}`);
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
  const bestVer   = bestCompatible?.versionNumber ?? latest;
  const bestMinMx = bestCompatible?.minSupportedMendixVersion ?? latestMin;

  const updateAvailable = currentVersion && bestVer !== "Unknown"
    ? semverCmp(currentVersion, bestVer) < 0 : false;
  const latestIsNewer = bestVer !== "Unknown" && latest !== "Unknown" && bestVer !== latest
    ? semverCmp(bestVer, latest) < 0 : false;

  let mxCompatible: boolean | undefined;
  let mxCompatibilityNote: string | undefined;
  if (latestMin && mxVersion && mxVersion !== "Unknown") {
    mxCompatible = semverCmp(mxVersion, latestMin) >= 0;
    mxCompatibilityNote = mxCompatible
      ? `✓ Compatible (requires Mx >= ${latestMin})`
      : `⚠ Latest requires Mx >= ${latestMin}, project uses ${mxVersion}`;
  }

  return {
    found:                     true,
    contentId:                 item.contentId,
    name:                      item.latestVersion?.name ?? "Unknown",
    url:                       `https://marketplace.mendix.com/link/component/${item.contentId}`,
    publisher:                 item.publisher,
    supportCategory:           item.supportCategory,
    licenseUrl:                item.licenseUrl,
    latestVersionNumber:       latest,
    minSupportedMendixVersion: latestMin ?? undefined,
    bestCompatibleVersion:     bestVer,
    bestCompatibleMinMx:       bestMinMx ?? undefined,
    updateAvailable,
    latestIsNewer,
    mxCompatible,
    mxCompatibilityNote,
  };
}

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

  const item = await mktGet<MktItem>(`${MKT_BASE}/${packageId}`);
  if (!item || typeof item.contentId !== "number") {
    dbg(`No valid response from GET /content/${packageId} for "${name}"`);
    return { found: false };
  }

  // Fetch all versions to find the best one compatible with this app's Mx version
  let bestCompatible: MktVersion | null = null;
  if (mxVersion && mxVersion !== "Unknown") {
    const raw = await mktGet<unknown>(`${MKT_BASE}/${packageId}/versions`);
    const versions: MktVersion[] = Array.isArray(raw)
      ? raw as MktVersion[]
      : Array.isArray((raw as Record<string, unknown>)?.["items"])
        ? (raw as Record<string, unknown>)["items"] as MktVersion[]
        : Array.isArray((raw as Record<string, unknown>)?.["versions"])
          ? (raw as Record<string, unknown>)["versions"] as MktVersion[]
          : [];

    dbg(`Versions for "${name}": ${versions.length} entries`);

    if (versions.length) {
      const compatible = versions.filter(v =>
        v.minSupportedMendixVersion &&
        semverCmp(mxVersion, v.minSupportedMendixVersion) >= 0
      );
      if (compatible.length) {
        compatible.sort((a, b) => semverCmp(b.versionNumber, a.versionNumber));
        bestCompatible = compatible[0];
        dbg(`Best compatible for "${name}" (Mx ${mxVersion}): ${bestCompatible.versionNumber}`);
      } else {
        dbg(`No compatible version for "${name}" with Mx ${mxVersion}`);
      }
    }
  }

  dbg(`Hit: "${name}" → contentId ${item.contentId}`);
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

// ─── Model scan ───────────────────────────────────────────────────────────────

async function scanApp(
  client: MendixPlatformClient,
  appId: string,
  meta: Partial<AppMeta> = {}
): Promise<AppReport> {

  const base: AppReport = {
    appId,
    appName:    meta.name ?? appId,
    appUrl:     meta.url  ?? "",
    mxVersion:  "Unknown",
    repoType:   "Unknown",
    branch:     BRANCH_OVERRIDE ?? "auto",
    scanStatus: "ok",
    deps:       [],
  };

  try {
    const app = client.getApp(appId);

    // ── Branch auto-detect ────────────────────────────────────────────────────
    let branchToUse = BRANCH_OVERRIDE ?? "main";
    try {
      const repoInfo = await app.getRepository().getInfo();
      base.repoType = repoInfo.type ?? "Unknown";
      if (!BRANCH_OVERRIDE) branchToUse = repoInfo.type === "svn" ? "trunk" : "main";
      console.error(`      Repo: ${base.repoType} → branch "${branchToUse}"`);
    } catch (e) {
      dbg("repo.getInfo() failed:", (e as Error).message);
    }
    base.branch = branchToUse;

    // ── Open model ────────────────────────────────────────────────────────────
    const wc    = await app.createTemporaryWorkingCopy(branchToUse);
    const model = await wc.openModel();

    // ── Read Mx version from Deploy API ──────────────────────────────────────
    // Fetches from the Production/Acceptance/Test environment of the app.
    // Non-blocking: if unavailable, mxVersion stays "Unknown" and scan continues.
    if (meta.subdomain) {
      base.mxVersion = await fetchMxVersionFromDeploy(meta.subdomain);
    }
    console.error(`      Mx ver: ${base.mxVersion}`);

    // ── Collect Marketplace modules ───────────────────────────────────────────
    const allModules = model.allModules();
    let mktCount = 0;
    for (const mod of allModules) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = mod as any;
      if (!m.fromAppStore) continue;
      mktCount++;
      base.deps.push({
        type:      "module",
        name:      m.name            ?? "Unknown",
        version:   m.appStoreVersion ?? "Unknown",
        packageId: m.appStorePackageId ? Number(m.appStorePackageId) : null,
      });
    }
    console.error(`      Modules: ${allModules.length} total, ${mktCount} Marketplace`);

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
    dep.marketplace = await lookupMarketplace(dep.name, dep.packageId, dep.version, report.mxVersion);
    done++;
    process.stderr.write(`\r[Marketplace] ${done}/${total} — ${dep.name.slice(0, 52).padEnd(52)}`);
    await new Promise(r => setTimeout(r, 200));
  }
  process.stderr.write("\n");
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function pLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
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
  const lines: string[] = [];
  const W = { name: 40, cur: 10, lat: 10, upd: 7, compat: 36, tier: 22, pub: 22 };
  const hdr = ["Module".padEnd(W.name),"Installed".padEnd(W.cur),"Latest".padEnd(W.lat),"Update?".padEnd(W.upd),"Mx Compat".padEnd(W.compat),"Support".padEnd(W.tier),"Publisher".padEnd(W.pub)].join(" │ ");
  const sep = Object.values(W).map(w => "─".repeat(w + 2)).join("┼");
  for (const r of reports) {
    lines.push(`\n${"═".repeat(155)}`);
    if (r.scanStatus === "error") { lines.push(`  ✗ ${r.appName}\n  ${r.scanError}`); continue; }
    lines.push(`  ${r.appName}   Repo: ${r.repoType}/${r.branch}   Mx: ${r.mxVersion}`);
    lines.push("═".repeat(155), " " + hdr, " " + sep);
    for (const d of r.deps) {
      const m = d.marketplace;
      lines.push(" " + [
        d.name.slice(0,W.name).padEnd(W.name),
        (d.version||"?").slice(0,W.cur).padEnd(W.cur),
        (m?.latestVersionNumber??"n/a").slice(0,W.lat).padEnd(W.lat),
        (m?.updateAvailable?"  YES ":m?.found?"  no  ":"   — ").padEnd(W.upd),
        (m?.mxCompatibilityNote??"n/a").slice(0,W.compat).padEnd(W.compat),
        (m?.supportCategory??"n/a").slice(0,W.tier).padEnd(W.tier),
        (m?.publisher??"n/a").slice(0,W.pub).padEnd(W.pub),
      ].join(" │ "));
    }
    const upd = r.deps.filter(d=>d.marketplace?.updateAvailable).length;
    const wrn = r.deps.filter(d=>d.marketplace?.mxCompatible===false).length;
    lines.push(`\n  ↑ Updates: ${upd}   ⚠ Compat warnings: ${wrn}`);
  }
  return lines.join("\n");
}

function formatMarkdown(reports: AppReport[]): string {
  const lines = ["# Mendix Marketplace Module Report", "", `_Generated: ${new Date().toISOString()}_`, ""];
  for (const r of reports) {
    lines.push(`## ${r.appName}`, "");
    if (r.scanStatus === "error") { lines.push(`> ⚠ **Scan failed:** ${r.scanError}`, ""); continue; }
    lines.push(`| | |`,`|-|-|`,`| **App ID** | \`${r.appId}\` |`,`| **Mx** | ${r.mxVersion} |`,`| **Repo** | ${r.repoType}/${r.branch} |`,`| **Modules** | ${r.deps.length} |`,"");
    lines.push("| Module | Installed | Latest | Update? | Mx Compat | Support | Publisher |");
    lines.push("|--------|-----------|--------|---------|-----------|---------|-----------|");
    for (const d of r.deps) {
      const m = d.marketplace;
      lines.push(`| ${m?.url?`[${d.name}](${m.url})`:d.name} | ${d.version||"?"} | ${m?.latestVersionNumber??"n/a"} | ${m?.updateAvailable?"✅":"✔"} | ${m?.mxCompatibilityNote??"n/a"} | ${m?.supportCategory??"n/a"} | ${m?.publisher??"n/a"} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.error("\n🔍 Mendix Dependency Scanner v6 — All Apps\n");

  setPlatformConfig({ mendixToken: PAT });
  const client = new MendixPlatformClient();

  let appsToScan: AppMeta[] = [];

  if (flags["all-apps"] || flags["list-apps"]) {
    const all = await fetchAllApps();
    const filtered = all.filter(a => !EXCLUDES.some(rx => rx.test(a.name)));
    if (EXCLUDES.length) console.error(`[Filter] Excluded ${all.length - filtered.length} apps`);
    appsToScan = filtered;
  }

  if (flags.app?.length) {
    for (const id of flags.app) {
      if (!appsToScan.some(a => a.appId === id))
        appsToScan.push({ appId: id, name: id, url: "" });
    }
  }

  if (flags["list-apps"]) {
    console.log("\nApps:\n");
    console.log(["Project ID".padEnd(38), "Name"].join("  "));
    console.log("─".repeat(80));
    for (const a of appsToScan) console.log([a.appId.padEnd(38), a.name].join("  "));
    console.log(`\nTotal: ${appsToScan.length}`);
    return;
  }

  if (!appsToScan.length) {
    console.error("No apps to scan. Use --all-apps or --app <project-id>.");
    process.exit(1);
  }

  console.error(`\n[Scan] ${appsToScan.length} app(s) · concurrency: ${CONCURRENCY}`);
  console.error(`[Scan] Branch: ${BRANCH_OVERRIDE ? `"${BRANCH_OVERRIDE}" (override)` : "auto-detected"}`);

  const reports = await pLimit(appsToScan, CONCURRENCY, async (app, i) => {
    console.error(`\n[${i + 1}/${appsToScan.length}] ${app.name}`);
    const report = await scanApp(client, app.appId, app);
    await enrichReport(report);
    return report;
  });

  const ok      = reports.filter(r => r.scanStatus === "ok");
  const allDeps = ok.flatMap(r => r.deps);

  const fullReport = {
    scannedAt: new Date().toISOString(),
    apps:      reports,
    summary: {
      appsTotal:    reports.length,
      appsScanned:  ok.length,
      appsFailed:   reports.filter(r => r.scanStatus === "error").length,
      totalModules: allDeps.length,
      updatesAvail: allDeps.filter(d => d.marketplace?.updateAvailable).length,
      compatWarns:  allDeps.filter(d => d.marketplace?.mxCompatible === false).length,
      bySupport: {
        Platform:  allDeps.filter(d => d.marketplace?.supportCategory === "Platform").length,
        Partner:   allDeps.filter(d => d.marketplace?.supportCategory === "Partner").length,
        Community: allDeps.filter(d => d.marketplace?.supportCategory === "Community").length,
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
  Apps        : ${s.appsTotal}  (✓ ${s.appsScanned}  ✗ ${s.appsFailed})
  Modules     : ${s.totalModules}
  Updates     : ${s.updatesAvail}
  Compat warns: ${s.compatWarns}
  Platform    : ${s.bySupport.Platform}
  Partner     : ${s.bySupport.Partner}
  Community   : ${s.bySupport.Community}
  Not Found   : ${s.bySupport.NotFound}
────────────────────────────────────`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
