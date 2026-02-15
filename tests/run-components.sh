#!/bin/bash
# Component test runner with mock isolation groups.
#
# bun's mock.module() is process-wide, so when one test file mocks a module,
# every other file in the same bun process sees the mock instead of the real
# module. This script groups test files so that no file runs in the same
# process as a file that mocks its component module.
#
# Grouping rationale:
#   Group 1 — Studio.test.tsx (mocks sidebar, schema-explorer, QueryEditor,
#             studio/index, ConnectionModal, CommandPalette, SchemaDiagram,
#             DataProfiler, CodeGenerator, TestDataGenerator, CreateTableModal,
#             SaveQueryModal, etc.)
#   Group 2 — Sidebar.test.tsx (mocks ConnectionsList, schema-explorer)
#   Group 3 — BottomPanel.test.tsx (mocks ResultsGrid, QueryHistory,
#             DataCharts, SchemaDiff, SavedQueries, VisualExplain, etc.)
#   Group 4 — AdminDashboard.test.tsx (mocks OverviewTab, OperationsTab,
#             MonitoringEmbed, SecurityTab, AuditTab)
#   Group 5 — SecurityTab.test.tsx (mocks MaskingSettings)
#   Group 6 — All remaining files (safe together — only mock libraries,
#             ui primitives, or sub-components with no test files)

set -e

PASS=0
FAIL=0
TOTAL_GROUPS=12
EXTRA_BUN_ARGS=("$@")
GROUP_INDEX=0
COVERAGE_MODE=0
COVERAGE_BASE_DIR=""

for arg in "${EXTRA_BUN_ARGS[@]}"; do
  if [ "$arg" = "--coverage" ]; then
    COVERAGE_MODE=1
  fi
  if [[ "$arg" == --coverage-dir=* ]]; then
    COVERAGE_BASE_DIR="${arg#--coverage-dir=}"
  fi
done

run_group() {
  local label="$1"
  shift
  GROUP_INDEX=$((GROUP_INDEX + 1))
  echo ""
  echo "=== $label ==="

  local RUN_ARGS=()
  for arg in "${EXTRA_BUN_ARGS[@]}"; do
    if [[ "$arg" == --coverage-dir=* ]]; then
      continue
    fi
    RUN_ARGS+=("$arg")
  done

  if [ "$COVERAGE_MODE" -eq 1 ] && [ -n "$COVERAGE_BASE_DIR" ]; then
    RUN_ARGS+=("--coverage-dir=${COVERAGE_BASE_DIR}/group-${GROUP_INDEX}")
  fi

  if bun test "${RUN_ARGS[@]}" "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAILED: $label"
  fi
}

# Group 1: Studio (isolated — mocks almost every child component)
run_group "Group 1/6: Studio" \
  tests/components/Studio.test.tsx

# Group 2: Sidebar (isolated — mocks ConnectionsList, SchemaExplorer)
run_group "Group 2/6: Sidebar" \
  tests/components/sidebar/Sidebar.test.tsx

# Group 3: BottomPanel (isolated — mocks ResultsGrid, QueryHistory, DataCharts, SchemaDiff)
run_group "Group 3/6: BottomPanel" \
  tests/components/studio/BottomPanel.test.tsx

# Group 4: AdminDashboard (isolated — mocks OverviewTab, OperationsTab, SecurityTab, AuditTab)
run_group "Group 4/6: AdminDashboard" \
  tests/components/admin/AdminDashboard.test.tsx

# Group 5: SecurityTab (isolated — mocks MaskingSettings)
run_group "Group 5/6: SecurityTab" \
  tests/components/admin/SecurityTab.test.tsx

# Group 6: MonitoringDashboard (isolated - mocks all monitoring tabs)
run_group "Group 6/7: MonitoringDashboard" \
  tests/components/monitoring/MonitoringDashboard.test.tsx

# Group 7: Results-grid subcomponents (isolated from ResultsGrid.test.tsx mocks)
run_group "Group 7/10: Results-grid subcomponents" \
  tests/components/results-grid/StatsBar.test.tsx \
  tests/components/results-grid/ResultCard.test.tsx \
  tests/components/results-grid/RowDetailSheet.test.tsx

# Group 8: SavedQueries (isolated - mocks @/lib/storage)
run_group "Group 8/10: SavedQueries" \
  tests/components/SavedQueries.test.tsx

# Group 9: StudioHeaders + TableItem (isolated - mock dropdown-menu)
run_group "Group 9/12: StudioHeaders & TableItem" \
  tests/components/studio/StudioMobileHeader.test.tsx \
  tests/components/studio/StudioDesktopHeader.test.tsx \
  tests/components/schema-explorer/TableItem.test.tsx

# Group 10: PoolTab (isolated - mock globalThis.fetch)
run_group "Group 10/12: PoolTab" \
  tests/components/monitoring/PoolTab.test.tsx

# Group 11: Smoke tests (isolated - mock globalThis.fetch)
run_group "Group 11/12: Smoke tests" \
  tests/components/VisualExplain.test.tsx \
  tests/components/AIAutopilotPanel.test.tsx \
  tests/components/DatabaseDocs.test.tsx \
  tests/components/SnapshotTimeline.test.tsx \
  tests/components/PivotTable.test.tsx \
  tests/components/NL2SQLPanel.test.tsx \
  tests/components/CodeGenerator.test.tsx \
  tests/components/TestDataGenerator.test.tsx \
  tests/components/CreateTableModal.test.tsx \
  tests/components/SaveQueryModal.test.tsx \
  tests/components/MobileNav.test.tsx \
  tests/components/DataImportModal.test.tsx

# Group 12: All remaining files (safe together)
run_group "Group 12/12: Remaining components" \
  tests/components/DataCharts.test.tsx \
  tests/components/QueryEditor.test.tsx \
  tests/components/QuerySafetyDialog.test.tsx \
  tests/components/QueryHistory.test.tsx \
  tests/components/ConnectionModal.test.tsx \
  tests/components/CommandPalette.test.tsx \
  tests/components/MaskingSettings.test.tsx \
  tests/components/ResultsGrid.test.tsx \
  tests/components/SchemaDiagram.test.tsx \
  tests/components/SchemaDiff.test.tsx \
  tests/components/DataProfiler.test.tsx \
  tests/components/schema-explorer/SchemaExplorer.test.tsx \
  tests/components/sidebar/ConnectionItem.test.tsx \
  tests/components/sidebar/ConnectionsList.test.tsx \
  tests/components/studio/QueryToolbar.test.tsx \
  tests/components/studio/StudioTabBar.test.tsx \
  tests/components/admin/OverviewTab.test.tsx \
  tests/components/admin/OperationsTab.test.tsx \
  tests/components/admin/AuditTab.test.tsx \
  tests/components/monitoring/StorageTab.test.tsx \
  tests/components/monitoring/SessionsTab.test.tsx \
  tests/components/monitoring/TablesTab.test.tsx \
  tests/components/monitoring/QueriesTab.test.tsx \
  tests/components/monitoring/PerformanceTab.test.tsx \
  tests/components/monitoring/OverviewTab.test.tsx

# Summary
echo ""
echo "========================================"
if [ $FAIL -eq 0 ]; then
  echo "All $TOTAL_GROUPS groups passed!"
  if [ "$COVERAGE_MODE" -eq 1 ] && [ -n "$COVERAGE_BASE_DIR" ]; then
    node scripts/merge-lcov.mjs "${COVERAGE_BASE_DIR}"/group-*/lcov.info "${COVERAGE_BASE_DIR}/lcov.info"
  fi
else
  echo "$FAIL/$TOTAL_GROUPS groups FAILED"
  exit 1
fi
