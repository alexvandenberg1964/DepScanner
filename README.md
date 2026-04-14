# Mendix Dependency Scanner

Scans Mendix Public Cloud apps for Marketplace module versions and enriches results with the latest available versions, Mendix runtime compatibility, and support tier information from the Mendix Marketplace API.

## What it does

- Lists all Marketplace modules (`fromAppStore === true`) across your Mendix apps
- Skips apps that have no Production environment or no deployed package
- Looks up each module in the Marketplace Content API to retrieve:
  - Latest available version (absolute)
  - Best compatible version for the app's current Mendix runtime
  - Whether an update is available
  - Runtime compatibility notes
  - Support category (Platform / Partner / Community)
  - Publisher and license URL

## Prerequisites

- Node.js >= 18
- A Mendix Personal Access Token (PAT) from [warden.mendix.com](https://warden.mendix.com)
- A Mendix API Key from your Mendix Profile

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `MENDIX_TOKEN` | PAT from warden.mendix.com. Required scopes: `mx:modelrepository:repo:write`, `mx:marketplace-content:read` |
| `MENDIX_USERNAME` | Your Mendix login email (e.g. `you@postnl.nl`) |
| `MENDIX_API_KEY` | API key from Mendix Profile → API Keys |
| `MENDIX_MARKETPLACE_TOKEN` | PAT with `mx:marketplace-content:read` scope (can be same as `MENDIX_TOKEN`) |

## Usage

### List all accessible apps

```bash
npm run list
# or
npx ts-node mendix-dep-scanner.ts --list-apps
```

### Scan all apps

```bash
npm run scan:all
# or
npx ts-node mendix-dep-scanner.ts --all-apps
```

### Scan specific apps

```bash
npx ts-node mendix-dep-scanner.ts --app <project-id> [--app <project-id> ...]
```

### Full CLI reference

```
Mendix Dependency Scanner v5

Modes:
  --all-apps                   Scan every app with a Production environment
  --list-apps                  Print app list and exit
  --app <project-id>           Scan specific app(s) by Project ID (repeatable)

Options:
  --branch <n>                 Override branch (default: auto-detected per app)
  --exclude <pattern>          Skip apps whose name matches this regex (repeatable)
  --concurrency <n>            Parallel scans (default: 3)
  --format json|table|markdown Output format (default: table)
  --output <file>              Write to file instead of stdout
  --no-marketplace             Skip Marketplace Content API calls
  --verbose                    Debug output
  --help                       This help
```

### Output examples

**Table (default)**
```bash
npx ts-node mendix-dep-scanner.ts --all-apps
```

**JSON report to file**
```bash
npx ts-node mendix-dep-scanner.ts --all-apps --format json --output report.json
```

**Markdown report**
```bash
npx ts-node mendix-dep-scanner.ts --all-apps --format markdown --output report.md
```

## Branch auto-detection

The scanner automatically detects the VCS type per app:
- SVN repositories → scans `trunk`
- Git repositories → scans `main`

Override with `--branch <name>` to force a specific branch for all apps.

## Version compatibility logic

For each module, the scanner finds the **best compatible version**: the highest Marketplace version whose `minSupportedMendixVersion` is less than or equal to the app's running Mendix version. This is the version you can safely install today.

It also reports the **absolute latest version**, which may require a higher Mendix runtime than what is currently deployed.

## Build (optional)

Compile to JavaScript for faster execution without `ts-node`:

```bash
npm run build
npm run scan:built
```

Output goes to `./dist/`.

## Dependencies

| Package | Purpose |
|---|---|
| `mendixplatformsdk` | Platform SDK — app/branch/working copy management |
| `mendixmodelsdk` | Model SDK — reads module metadata from the model |
| `dotenv` | Loads credentials from `.env` |
