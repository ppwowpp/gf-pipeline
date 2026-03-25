#!/usr/bin/env node

/**
 * generate-dashboards.js
 * Generates Grafana dashboards from JSON configs + template
 *
 * Usage:
 *   node scripts/generate-dashboards.js --env=prd
 *   node scripts/generate-dashboards.js --env=prd --file=project_a
 *   node scripts/generate-dashboards.js --env=prd --file=project_a,project_b
 *   node scripts/generate-dashboards.js --env=all
 *   node scripts/generate-dashboards.js --env=all --dry-run
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── CLI Args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const TARGET_ENV = args.env || "all";
// --file=project_a  or  --file=project_a,project_b  (no .json extension needed)
// "all" = process every file in the env dir (default)
const TARGET_FILE = args.file || "all";
const DRY_RUN = args["dry-run"] === true || args["dry-run"] === "true";
const VERBOSE = args.verbose === true || args.verbose === "true";

// ─── Paths ───────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const CONFIGS_DIR = path.join(ROOT, "configs");
const TEMPLATE_PATH = path.join(ROOT, "templates", "template_dashboard.json");
const OUTPUT_DIR = path.join(ROOT, "output");

const VALID_ENVS = ["dev", "sit", "uat", "prd"];

// ─── Required config fields ──────────────────────────────────────────────────
const REQUIRED_FIELDS = ["project", "product", "apis", "operation", "binsize", "env"];

// ─── Azure resource map per env (override via AZURE_RESOURCE_<ENV> env vars) ─
const AZURE_RESOURCE_MAP = {
  dev: process.env.AZURE_RESOURCE_DEV || "/subscriptions/CHANGE_ME/resourceGroups/rg-dev/providers/Microsoft.ApiManagement/service/apim-dev",
  sit: process.env.AZURE_RESOURCE_SIT || "/subscriptions/CHANGE_ME/resourceGroups/rg-sit/providers/Microsoft.ApiManagement/service/apim-sit",
  uat: process.env.AZURE_RESOURCE_UAT || "/subscriptions/CHANGE_ME/resourceGroups/rg-uat/providers/Microsoft.ApiManagement/service/apim-uat",
  prd: process.env.AZURE_RESOURCE_PRD || "/subscriptions/43eb09a8-038e-46d9-9a1f-dcefeed0376c/resourceGroups/rg-dsbcommon-az-asse-prd-001/providers/Microsoft.ApiManagement/service/apim-dsbcommon-az-asse-prd-001",
};

// ─── Logger ──────────────────────────────────────────────────────────────────
const log = {
  info:    (msg) => console.log(`[INFO]  ${msg}`),
  warn:    (msg) => console.warn(`[WARN]  ${msg}`),
  error:   (msg) => console.error(`[ERROR] ${msg}`),
  debug:   (msg) => VERBOSE && console.log(`[DEBUG] ${msg}`),
  success: (msg) => console.log(`[OK]    ${msg}`),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert array of strings to KQL in(...) list.
 *
 * Template is read as a raw string, substituted, then JSON.parsed — so the
 * value we inject must be valid *inside* a JSON string literal.
 * A KQL string literal uses plain double-quotes: "value"
 * Inside a JSON string those quotes must be escaped as \"
 *
 * ["test", "test2"]  →  \"test\", \"test2\"
 *
 * The single backslash is enough because we're building a JS string that will
 * be embedded into a JSON string value; JSON.parse will then interpret \" as ".
 */
function toKqlList(arr) {
  return arr.map((item) => `\\"${item}\\"`).join(", ");
}

/**
 * Generate a deterministic UID from env + project.
 *
 * Format: <env>-<16 hex chars>   e.g. "prd-a3f9c2d18e4b7f01"
 * - Deterministic: same env+project always produces the same uid
 * - Human-readable: env prefix makes it easy to spot in Grafana
 * - Collision-resistant: 16 hex chars = 64 bits of entropy
 * - Grafana-safe: only lowercase letters, digits, hyphens; max 40 chars
 */
function generateUID(env, project) {
  const hash = crypto
    .createHash("sha256")
    .update(`${env}-${project}`)
    .digest("hex");
  return `${env}-${hash.substring(0, 16)}`;
}

/**
 * Re-number all panel ids sequentially (1-based) within a dashboard.
 *
 * Template panel ids are hardcoded. If panels are ever added/reordered,
 * duplicate ids would silently break Grafana links and alert references.
 * This ensures every generated dashboard always has clean, unique panel ids.
 */
function reassignPanelIds(panels) {
  let nextId = 1;
  for (const panel of panels) {
    panel.id = nextId++;
    // Recurse into collapsed row children
    if (Array.isArray(panel.panels) && panel.panels.length > 0) {
      for (const child of panel.panels) {
        child.id = nextId++;
      }
    }
  }
}

/**
 * Validate required fields in config.
 * Returns { valid: bool, missing: string[] }
 */
function validateConfig(config) {
  const missing = REQUIRED_FIELDS.filter((f) => {
    const val = config[f];
    if (val === undefined || val === null) return true;
    if (Array.isArray(val) && val.length === 0) return true;
    if (typeof val === "string" && val.trim() === "") return true;
    return false;
  });
  return { valid: missing.length === 0, missing };
}

/**
 * Perform all placeholder replacements in template string.
 */
function applyTemplate(templateStr, config, azureResource) {
  const projectUpper = config.project.toUpperCase();
  const envUpper     = config.env.toUpperCase();
  const apisKql      = toKqlList(config.apis);
  const operationsKql = toKqlList(config.operation);
  const uid          = generateUID(config.env, config.project);

  const replacements = {
    "{{project}}":             config.project,
    "{{product}}":             config.product,
    "{{binsize}}":             config.binsize,
    "{{env}}":                 config.env,
    "{{PROJECT_UPPER}}":       projectUpper,
    "{{env_upper}}":           envUpper,
    "{{APIS_KQL_LIST}}":       apisKql,
    "{{OPERATIONS_KQL_LIST}}": operationsKql,
    "{{AZURE_RESOURCE}}":      azureResource,
    "{{DASHBOARD_UID}}":       uid,
  };

  let result = templateStr;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

/**
 * Validate that the generated JSON is a valid Grafana dashboard structure.
 * Returns true if valid, false otherwise (errors are logged).
 */
function validateDashboardSchema(dashboard, fileName) {
  const errors = [];

  if (!dashboard.panels || !Array.isArray(dashboard.panels))
    errors.push("Missing or invalid 'panels' array");
  if (!dashboard.title || typeof dashboard.title !== "string")
    errors.push("Missing or invalid 'title'");
  if (!dashboard.schemaVersion)
    errors.push("Missing 'schemaVersion'");
  if (!dashboard.templating?.list)
    errors.push("Missing 'templating.list'");
  if (!dashboard.uid || typeof dashboard.uid !== "string")
    errors.push("Missing or invalid 'uid'");

  if (errors.length > 0) {
    log.error(`Schema validation failed for ${fileName}:`);
    errors.forEach((e) => log.error(`  - ${e}`));
    return false;
  }

  // Warn on any unreplaced placeholders
  const jsonStr   = JSON.stringify(dashboard);
  const remaining = jsonStr.match(/\{\{[A-Z_a-z]+\}\}/g);
  if (remaining) {
    const unique = [...new Set(remaining)];
    log.warn(`Unreplaced placeholders in ${fileName}: ${unique.join(", ")}`);
  }

  return true;
}

// ─── Core: process a single config file ──────────────────────────────────────
function processConfig(configPath, templateStr, stats) {
  const fileName = path.basename(configPath);
  log.debug(`Processing: ${configPath}`);

  // Read & parse config
  let config;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch (err) {
    log.warn(`Skipping ${fileName} — cannot parse JSON: ${err.message}`);
    stats.skipped++;
    return;
  }

  // Validate required fields
  const { valid, missing } = validateConfig(config);
  if (!valid) {
    log.warn(`Skipping ${fileName} — missing required fields: ${missing.join(", ")}`);
    stats.skipped++;
    return;
  }

  // Validate env matches directory name
  const envFromDir = path.basename(path.dirname(configPath));
  if (config.env !== envFromDir) {
    log.warn(`Skipping ${fileName} — config.env "${config.env}" does not match directory "${envFromDir}"`);
    stats.skipped++;
    return;
  }

  const azureResource = AZURE_RESOURCE_MAP[config.env] || AZURE_RESOURCE_MAP.prd;

  // Apply template substitutions
  let rendered;
  try {
    rendered = applyTemplate(templateStr, config, azureResource);
  } catch (err) {
    log.error(`Failed to apply template for ${fileName}: ${err.message}`);
    stats.failed++;
    return;
  }

  // Parse rendered JSON
  let dashboard;
  try {
    dashboard = JSON.parse(rendered);
  } catch (err) {
    log.error(`Generated invalid JSON for ${fileName}: ${err.message}`);
    stats.failed++;
    return;
  }

  // ── Grafana import safety ────────────────────────────────────────────────
  // id: null → Grafana always creates/updates by uid, never by numeric id.
  //            Prevents "Access denied" when importing across orgs/folders.
  dashboard.id = null;

  // Reassign panel ids sequentially so they are always unique within the
  // dashboard, regardless of what the template or future edits contain.
  if (Array.isArray(dashboard.panels)) {
    reassignPanelIds(dashboard.panels);
  }
  // ────────────────────────────────────────────────────────────────────────

  // Schema validation
  if (!validateDashboardSchema(dashboard, fileName)) {
    stats.failed++;
    return;
  }

  // Output path
  const outputPath = path.join(OUTPUT_DIR, config.env, `dashboard_${config.project}.json`);

  if (DRY_RUN) {
    log.info(`[DRY-RUN] Would write : ${outputPath}`);
    log.info(`  Title  : ${dashboard.title}`);
    log.info(`  UID    : ${dashboard.uid}`);
    log.info(`  id     : ${dashboard.id} (null = safe to import)`);
    log.info(`  Panels : ${dashboard.panels.length}`);
    log.info(`  APIs   : ${config.apis.join(", ")}`);
    log.info(`  Ops    : ${config.operation.join(", ")}`);
    stats.dryRun++;
    return;
  }

  // Ensure output dir exists
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Write output
  try {
    fs.writeFileSync(outputPath, JSON.stringify(dashboard, null, 2), "utf-8");
    log.success(`Generated: ${outputPath}  (uid: ${dashboard.uid})`);
    stats.generated++;
  } catch (err) {
    log.error(`Failed to write ${outputPath}: ${err.message}`);
    stats.failed++;
  }
}

// ─── Core: process configs in an env directory ───────────────────────────────
function processEnv(env, templateStr, stats) {
  const envDir = path.join(CONFIGS_DIR, env);

  if (!fs.existsSync(envDir)) {
    log.warn(`Config directory not found: ${envDir} — skipping`);
    return;
  }

  const allFiles = fs.readdirSync(envDir).filter((f) => f.endsWith(".json"));

  if (allFiles.length === 0) {
    log.warn(`No JSON config files found in ${envDir} — skipping`);
    return;
  }

  // ── Filter by --file= if specified ───────────────────────────────────────
  let filesToProcess;
  if (TARGET_FILE === "all") {
    filesToProcess = allFiles;
  } else {
    const requested = TARGET_FILE.split(",").map((f) =>
      f.trim().endsWith(".json") ? f.trim() : `${f.trim()}.json`
    );
    filesToProcess = requested.filter((f) => {
      if (allFiles.includes(f)) return true;
      log.warn(`File not found in configs/${env}/: ${f} — skipping`);
      return false;
    });
  }

  if (filesToProcess.length === 0) {
    log.warn(`No matching files to process in ${envDir}`);
    return;
  }

  log.info(`Processing env: ${env} (${filesToProcess.length}/${allFiles.length} file(s))`);

  for (const file of filesToProcess) {
    processConfig(path.join(envDir, file), templateStr, stats);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  log.info("=".repeat(60));
  log.info("Grafana Dashboard Generator");
  log.info(`Target env  : ${TARGET_ENV}`);
  log.info(`Target file : ${TARGET_FILE}`);
  log.info(`Dry run     : ${DRY_RUN}`);
  log.info(`Template    : ${TEMPLATE_PATH}`);
  log.info("=".repeat(60));

  // ── Validate env argument(s) before doing any work ───────────────────────
  const envsToProcess = TARGET_ENV === "all" ? VALID_ENVS : [TARGET_ENV];
  for (const env of envsToProcess) {
    if (!VALID_ENVS.includes(env)) {
      log.error(`Invalid env "${env}". Valid options: ${VALID_ENVS.join(", ")}`);
      process.exit(1);
    }
  }

  // Load & validate template
  if (!fs.existsSync(TEMPLATE_PATH)) {
    log.error(`Template not found: ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  let templateStr;
  try {
    templateStr = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    JSON.parse(templateStr); // pre-validate JSON
  } catch (err) {
    log.error(`Invalid template JSON: ${err.message}`);
    process.exit(1);
  }

  const stats = { generated: 0, skipped: 0, failed: 0, dryRun: 0 };

  for (const env of envsToProcess) {
    processEnv(env, templateStr, stats);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  log.info("=".repeat(60));
  log.info("Summary:");
  if (DRY_RUN) {
    log.info(`  Would generate : ${stats.dryRun}`);
  } else {
    log.info(`  Generated      : ${stats.generated}`);
  }
  log.info(`  Skipped        : ${stats.skipped}`);
  log.info(`  Failed         : ${stats.failed}`);
  log.info("=".repeat(60));

  if (stats.failed > 0) {
    log.error("Some dashboards failed to generate. Check logs above.");
    process.exit(1);
  }

  const totalProcessed = DRY_RUN ? stats.dryRun : stats.generated;
  if (totalProcessed === 0 && stats.skipped === 0) {
    log.error("No dashboards were generated. Check your configs directory.");
    process.exit(1);
  }
}

main();
