#!/usr/bin/env bash
# scripts/generate_kql.sh
set -euo pipefail

TEMPLATE_FILE="templates/tps.kql.tmpl"
CONFIGS_DIR="configs"
OUTPUT_BASE="kql"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# ["a","b","c"]  →  ("a","b","c")
json_array_to_kql() {
  local json_arr="$1"
  # extract values, join with '","', wrap in ("...")
  echo "$json_arr" \
    | jq -r '[.[] ] | "(" + (map("\"" + . + "\"") | join(",")) + ")"'
}

# ---------------------------------------------------------------------------
# main loop
# ---------------------------------------------------------------------------

for config_file in "$CONFIGS_DIR"/*.json; do
  [[ -f "$config_file" ]] || continue
  echo "Processing: $config_file"

  # parse fields
  project=$(jq -r '.project'   "$config_file")
  product=$(jq -r '.product'   "$config_file")
  binsize=$(jq -r '.binsize'   "$config_file")
  env=$(jq -r '.env'      "$config_file")

  apis_list=$(json_array_to_kql "$(jq -c '.apis'      "$config_file")")
  operation_list=$(json_array_to_kql "$(jq -c '.operation' "$config_file")")

  # output path
  out_dir="$OUTPUT_BASE/$env"
  out_file="$out_dir/${project}_tps.kql"
  mkdir -p "$out_dir"

  # render template — use | as sed delimiter to avoid clash with KQL pipes
  sed \
    -e "s|{{product}}|$product|g" \
    -e "s|{{project}}|$project|g" \
    -e "s|{{apis_list}}|$apis_list|g" \
    -e "s|{{operation_list}}|$operation_list|g" \
    -e "s|{{binsize}}|$binsize|g" \
    "$TEMPLATE_FILE" > "$out_file"

  echo "  → $out_file"
done