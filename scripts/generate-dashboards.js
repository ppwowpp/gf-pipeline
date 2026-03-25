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
  info: (msg) => console.log(`[INFO]  ${msg}`),
  warn: (msg) => console.warn(`[WARN]  ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => VERBOSE && console.log(`[DEBUG] ${msg}`),
  success: (msg) => console.log(`[OK]    ${msg}`),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert array of strings to KQL in(...) list.
 * The template query strings are stored as JSON string values, so double-quotes
 * must be escaped as \" — same as the rest of the KQL in the template.
 * ["test", "test2"] → "\"test\", \"test2\""
 */
function toKqlList(arr) {
  return arr.map((item) => `\\"${item}\\"`).join(", ");
}

/**
 * Generate a deterministic short UID from env+project.
 * Grafana uses this to identify dashboards — must be unique per project+env.
 */
function generateUID(env, project) {
  const hash = crypto
    .createHash("sha256")
    .update(`${env}-${project}`)
    .digest("hex");
  return hash.substring(0, 14);
}

/**
 * Validate required fields in config
 * Returns { valid: bool, missing: [] }
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
 * Perform all placeholder replacements in template string
 */
function applyTemplate(templateStr, config, azureResource) {
  const projectUpper = config.project.toUpperCase();
  const envUpper = config.env.toUpperCase();
  const apisKql = toKqlList(config.apis);
  const operationsKql = toKqlList(config.operation);
  const uid = generateUID(config.env, config.project);

  const replacements = {
    "{{project}}": config.project,
    "{{product}}": config.product,
    "{{binsize}}": config.binsize,
    "{{env}}": config.env,
    "{{PROJECT_UPPER}}": projectUpper,
    "{{env_upper}}": envUpper,
    "{{APIS_KQL_LIST}}": apisKql,
    "{{OPERATIONS_KQL_LIST}}": operationsKql,
    "{{AZURE_RESOURCE}}": azureResource,
    "{{DASHBOARD_UID}}": uid,
  };

  let result = templateStr;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  return result;
}

/**
 * Validate that the generated JSON is a valid Grafana dashboard structure
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
  if (errors.length > 0) {
    log.error(`Schema validation failed for ${fileName}:`);
    errors.forEach((e) => log.error(`  - ${e}`));
    return false;
  }

  // Warn on any unreplaced placeholders
  const jsonStr = JSON.stringify(dashboard);
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

  // Read config
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

  // ── FIX: Grafana "Access denied" on import ──────────────────────────────
  // When importing, Grafana uses "id" to look up an existing dashboard.
  // If a dashboard with that id belongs to another org/folder, it blocks import.
  // Setting id: null tells Grafana to always create a new dashboard.
  // uid stays intact so re-imports update the same dashboard instead of duplicating.
  dashboard.id = null;
  // ────────────────────────────────────────────────────────────────────────

  // Schema validation
  const schemaOk = validateDashboardSchema(dashboard, fileName);
  if (!schemaOk) {
    stats.failed++;
    return;
  }

  // Output path
  const outputPath = path.join(OUTPUT_DIR, config.env, `dashboard_${config.project}.json`);

  if (DRY_RUN) {
    log.info(`[DRY-RUN] Would write: ${outputPath}`);
    log.info(`  Title : ${dashboard.title}`);
    log.info(`  UID   : ${dashboard.uid}`);
    log.info(`  id    : ${dashboard.id} (null = safe to import)`);
    log.info(`  APIs  : ${config.apis.join(", ")}`);
    log.info(`  Ops   : ${config.operation.join(", ")}`);
    stats.generated++;
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

  // Build list of files to process
  let allFiles = fs.readdirSync(envDir).filter((f) => f.endsWith(".json"));

  if (allFiles.length === 0) {
    log.warn(`No JSON config files found in ${envDir} — skipping`);
    return;
  }

  // ── Filter by --file= if specified ───────────────────────────────────────
  let filesToProcess;
  if (TARGET_FILE === "all") {
    filesToProcess = allFiles;
  } else {
    // Accept "project_a", "project_a.json", or "project_a,project_b"
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
  log.info(`Grafana Dashboard Generator`);
  log.info(`Target env  : ${TARGET_ENV}`);
  log.info(`Target file : ${TARGET_FILE}`);
  log.info(`Dry run     : ${DRY_RUN}`);
  log.info(`Template    : ${TEMPLATE_PATH}`);
  log.info("=".repeat(60));

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

  const stats = { generated: 0, skipped: 0, failed: 0 };

  const envsToProcess = TARGET_ENV === "all" ? VALID_ENVS : [TARGET_ENV];

  for (const env of envsToProcess) {
    if (!VALID_ENVS.includes(env)) {
      log.error(`Invalid env "${env}". Valid options: ${VALID_ENVS.join(", ")}`);
      process.exit(1);
    }
    processEnv(env, templateStr, stats);
  }

  // Summary
  log.info("=".repeat(60));
  log.info(`Summary:`);
  log.info(`  Generated : ${stats.generated}`);
  log.info(`  Skipped   : ${stats.skipped}`);
  log.info(`  Failed    : ${stats.failed}`);
  log.info("=".repeat(60));

  if (stats.failed > 0) {
    log.error("Some dashboards failed to generate. Check logs above.");
    process.exit(1);
  }

  if (stats.generated === 0 && stats.skipped === 0) {
    log.error("No dashboards were generated. Check your configs directory.");
    process.exit(1);
  }
}

main();
