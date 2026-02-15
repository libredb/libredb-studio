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
TOTAL_GROUPS=6
EXTRA_BUN_ARGS=("$@")

run_group() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  if bun test "${EXTRA_BUN_ARGS[@]}" "$@"; then
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

# Group 6: All remaining files (safe together)
run_group "Group 6/6: Remaining components" \
  tests/components/DataCharts.test.tsx \
  tests/components/QueryEditor.test.tsx \
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
  tests/components/monitoring/MonitoringDashboard.test.tsx

# Summary
echo ""
echo "========================================"
if [ $FAIL -eq 0 ]; then
  echo "All $TOTAL_GROUPS groups passed!"
else
  echo "$FAIL/$TOTAL_GROUPS groups FAILED"
  exit 1
fi
