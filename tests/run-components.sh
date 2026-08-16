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
#   Group 4 — AdminDashboard shell + admin section/layout/index pages
#   Group 5 — SecurityTab.test.tsx (mocks MaskingSettings)
#   Group 6 — All remaining files (safe together — only mock libraries,
#             ui primitives, or sub-components with no test files)

set -e

PASS=0
FAIL=0
# Count the `run_group` CALLS below when adding one (not the definition) - this is the
# number the final summary reports, and it had already drifted by one before Group 0e
# was added. Verify with `grep -c '^run_group ' tests/run-components.sh`, which is how
# the third drift was caught (#331 T5): 26 was declared while 27 calls existed, so the
# green summary line reported a group count no run had.
TOTAL_GROUPS=30
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
  # Optional --nocov flag: run the group WITHOUT coverage collection. Used for
  # groups that import modules without exercising them (e.g. the exports shim,
  # which loads the whole component chain) — their load-only lcov records would
  # otherwise merge as phantom uncovered lines on files other groups fully cover.
  local nocov=0
  if [ "$1" = "--nocov" ]; then
    nocov=1
    shift
  fi
  GROUP_INDEX=$((GROUP_INDEX + 1))
  echo ""
  echo "=== $label ==="

  local RUN_ARGS=()
  for arg in "${EXTRA_BUN_ARGS[@]}"; do
    if [[ "$arg" == --coverage-dir=* ]]; then
      continue
    fi
    if [ "$nocov" -eq 1 ] && [[ "$arg" == --coverage* ]]; then
      continue
    fi
    RUN_ARGS+=("$arg")
  done

  if [ "$COVERAGE_MODE" -eq 1 ] && [ -n "$COVERAGE_BASE_DIR" ] && [ "$nocov" -eq 0 ]; then
    RUN_ARGS+=("--coverage-dir=${COVERAGE_BASE_DIR}/group-${GROUP_INDEX}")
  fi

  if bun test "${RUN_ARGS[@]}" "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAILED: $label"
  fi
}

# Group 0a: useStorageSync hook (isolated — mocks @/lib/storage which contaminates other hook tests)
run_group "Group 0a: useStorageSync hook" \
  tests/isolated/use-storage-sync.test.ts

# Group 0b: Factory singleton (isolated — mocks provider modules which contaminates provider unit tests)
run_group "Group 0b: Factory singleton" \
  tests/isolated/factory-singleton.test.ts

# Group 0c: exports CJS shim (isolated — importing it pulls @/lib/db/factory into the
# module cache, which breaks factory.test.ts's first-import signal-handler capture).
# --nocov: the shim import loads the entire component chain without rendering it,
# which would inject load-only zero-hit lcov records for files other groups cover.
run_group "Group 0c: Exports shim" --nocov \
  tests/isolated/exports-shim.test.ts

# Group 0d: Monaco loader wiring (isolated — mocks @monaco-editor/react and must observe
# the loader call QueryEditor makes at module-evaluation time, so it dynamic-imports the
# component after the mock is registered).
# --nocov: same load-only concern as Group 0c — importing QueryEditor pulls its whole
# module chain without rendering it.
run_group "Group 0d: Monaco loader wiring" --nocov \
  tests/isolated/monaco-loader-wiring.test.ts

# Group 0e: The standalone execution path against the REAL confirmation gate
# (isolated — tests/hooks/use-query-execution.test.ts stubs
# @/components/QuerySafetyDialog with mock.module, which is process-wide, so a
# test sharing that process cannot observe what the real predicate answers).
run_group "Group 0e: Query safety gate (standalone path)" \
  tests/isolated/query-safety-gate-standalone.test.ts

# Group 0f: The agent's model layer against the REAL LLM error classes
# (isolated — every tests/api/ai/*.test.ts replaces @/lib/llm/types with stub
# error classes whose constructors take a message only, and mock.module is
# process-wide, so a test sharing that process sees the mapper's provider tag
# dropped even though the class identity still matches). The four files share one
# process: none of them mocks a module, so they only need isolating from those.
run_group "Group 0f: Agent model layer" \
  tests/isolated/agent-model-adapter.test.ts \
  tests/isolated/agent-provider-registry.test.ts \
  tests/isolated/agent-capability-probe.test.ts \
  tests/isolated/agent-investigation.test.ts

# Group 0g: The agent's composition root. Its own group, NOT part of 0f: it mocks
# @/lib/db, @/lib/agent/investigation and @/lib/seed/resolve-connection, and
# mock.module is process-wide, so sharing 0f's process would hand the loop suite
# above a stubbed investigation module.
run_group "Group 0g: Agent runtime composition" \
  tests/isolated/agent-runtime.test.ts

# Group 0h: The agent's end-to-end investigation against real engines. Its own
# group, NOT part of 0f: it mocks `pg` (the PostgreSQL suite's engine-fixture
# technique) and mock.module is process-wide, so sharing a process would hand every
# other file in it a pg module that answers only this fixture's statements.
run_group "Group 0h: Agent end-to-end investigation" \
  tests/isolated/agent-investigation-e2e.test.ts

# Group 0i: The start path's model gate. Its own group, NOT part of 0f: it mocks
# @/lib/agent/capability-probe and @/lib/agent/model-adapter, and mock.module is
# process-wide — 0f contains the suites for both of those modules, so sharing its
# process would hand them the stubs written for this one.
run_group "Group 0i: Agent capability gate" \
  tests/isolated/agent-capability-gate.test.ts

# Group 0j: The workflow classifier. Its own group, NOT part of 0f: it mocks
# @/lib/agent/model-adapter and the `ai` package, and mock.module is process-wide
# — 0f holds the model adapter's own suite, so sharing its process would hand that
# suite the stub written here instead of the module it is testing.
run_group "Group 0j: Agent workflow classifier" \
  tests/isolated/agent-workflow-classifier.test.ts

# Group 1: Studio (isolated — mocks almost every child component)
run_group "Group 1/6: Studio" \
  tests/components/Studio.test.tsx

# Group 1b: the palette-item-to-rail path (isolated — it must see the REAL
# use-agent-prefill, use-tab-manager and CommandPalette, all three of which Group 1
# replaces with mock.module stubs, and mock.module is process-wide).
run_group "Group 1b/6: Studio agent ask" \
  tests/components/studio-agent-ask.test.tsx

# Group 2: Sidebar (isolated — mocks ConnectionsList, SchemaExplorer)
run_group "Group 2/6: Sidebar" \
  tests/components/sidebar/Sidebar.test.tsx

# Group 3: BottomPanel (isolated — mocks ResultsGrid, QueryHistory, DataCharts, SchemaDiff)
run_group "Group 3/6: BottomPanel" \
  tests/components/studio/BottomPanel.test.tsx

# Group 4: AdminDashboard shell + section pages
run_group "Group 4/6: AdminDashboard" \
  tests/components/admin/AdminDashboard.test.tsx \
  tests/components/admin/AdminOverviewPage.test.tsx \
  tests/components/admin/AdminSectionPages.test.tsx \
  tests/components/AdminPage.test.tsx

# Group 4b: AdminLayout (isolated — mocks AdminDashboard)
run_group "Group 4b/6: AdminLayout" \
  tests/components/admin/AdminLayout.test.tsx

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

# Group 11: Smoke tests (isolated - mock globalThis.fetch + MonitoringEmbed)
run_group "Group 11/12: Smoke tests" \
  tests/components/agent/AgentRail.test.tsx \
  tests/components/agent/use-agent-run.test.tsx \
  tests/components/admin/MonitoringEmbed.test.tsx \
  tests/components/VisualExplain.test.tsx \
  tests/components/DatabaseDocs.test.tsx \
  tests/components/SnapshotTimeline.test.tsx \
  tests/components/PivotTable.test.tsx \
  tests/components/CodeGenerator.test.tsx \
  tests/components/TestDataGenerator.test.tsx \
  tests/components/CreateTableModal.test.tsx \
  tests/components/SaveQueryModal.test.tsx \
  tests/components/MobileNav.test.tsx \
  tests/components/DataImportModal.test.tsx \
  tests/components/RootLayout.test.tsx \
  tests/components/AppErrorPages.test.tsx \
  tests/components/Page.test.tsx \
  tests/components/LoginPage.test.tsx \
  tests/components/LoginPageOIDC.test.tsx \
  tests/components/CommunitySection.test.tsx \
  tests/components/GitHubRepoLink.test.tsx \
  tests/components/MonitoringPage.test.tsx \
  tests/components/monitoring/MetricChart.test.tsx

# Group 12: MaskingSettings (isolated — mocks @/lib/data-masking with different shape than ResultsGrid/DataProfiler)
run_group "Group 12/13: MaskingSettings" \
  tests/components/MaskingSettings.test.tsx

# Group 13: SchemaDiff (isolated — mocks @/components/ui/badge, @/components/ui/select)
run_group "Group 13/14: SchemaDiff" \
  tests/components/SchemaDiff.test.tsx

# Group 16: ConnectionModal Mobile Drawer (isolated - useIsMobile returns true)
run_group "Group 16/16: ConnectionModal Mobile" \
  tests/components/ConnectionModal.mobile.test.tsx

# Group 14: DataCharts (isolated — mocks @/lib/storage with chart methods)
run_group "Group 14/16: DataCharts" \
  tests/components/DataCharts.test.tsx

# Group 15: All remaining files (safe together)
run_group "Group 15/16: Remaining components" \
  tests/components/copy-button.test.tsx \
  tests/components/rich-text.test.tsx \
  tests/components/QueryEditor.test.tsx \
  tests/components/QuerySafetyDialog.test.tsx \
  tests/components/QueryHistory.test.tsx \
  tests/components/ConnectionModal.test.tsx \
  tests/components/CommandPalette.test.tsx \
  tests/components/ResultsGrid.test.tsx \
  tests/components/SchemaDiagram.test.tsx \
  tests/components/DataProfiler.test.tsx \
  tests/components/schema-explorer/SchemaExplorer.test.tsx \
  tests/components/schema-explorer/ColumnList.test.tsx \
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

# Group 18: ui/resizable (isolated — installs a global DOMRect that
#           react-resizable-panels 4 needs, and is the one suite that renders
#           the real library instead of mocking @/components/ui/resizable)
run_group "Group 18: ui/resizable" \
  tests/components/ui/resizable.test.tsx

# Group 17: StudioWorkspace (isolated — mocks the same child families as Studio:
#           sidebar, QueryEditor, studio/index, SchemaDiagram, DataProfiler,
#           CodeGenerator, TestDataGenerator, SaveQueryModal, DataImportModal,
#           QuerySafetyDialog, plus the workspace adapter hooks)
run_group "Group 17: StudioWorkspace" \
  tests/components/StudioWorkspace.test.tsx

# Groups 18 and 19: the two theme files. Each mocks `next-themes` — process-wide,
# and with a DIFFERENT shape (one replaces `useTheme`, the other `ThemeProvider`),
# so they cannot share a process with each other, nor with anything that reaches
# the real next-themes through ui/sonner.
run_group "Group 18: ThemeToggle" \
  tests/components/ThemeToggle.test.tsx

run_group "Group 19: ThemeProvider" \
  tests/components/ThemeProvider.test.tsx

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
