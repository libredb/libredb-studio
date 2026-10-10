"use client";

import React from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { MaskingConfig } from "@/lib/data-masking";
import { objectAtPath } from "@/lib/db/detailed-object";
import { catalogOfPath } from "@/lib/db/object-kinds";
import { DataImportModal } from "@/components/DataImportModal";
import { QuerySafetyDialog } from "@/components/QuerySafetyDialog";
import { DataProfiler } from "@/components/DataProfiler";
import { CodeGenerator } from "@/components/CodeGenerator";
import { TestDataGenerator } from "@/components/TestDataGenerator";
import { SaveQueryModal } from "@/components/SaveQueryModal";
import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type SafetyAnalyzer = NonNullable<React.ComponentProps<typeof QuerySafetyDialog>["onAnalyzeSafety"]>;

/**
 * The dialog and modal surface BOTH shells draw, moved out of their bodies so the shells stop
 * carrying ~150 lines of pure wiring. The standalone-only overlays (connection modal, create
 * table, delete confirmation, command palette, shortcuts and mobile nav) live in
 * `StudioOverlays.tsx`, which only `Studio.tsx` imports, so the embedded package never pulls
 * `cmdk`, `MobileNav` or `CreateTableModal` in.
 *
 * Deliberately NOT `React.memo`: `defaultQuery` is the tab's query and changes on every
 * keystroke, so memoizing would never bail out and would only add an identity check. The
 * dialogs are closed by default and render nothing, so re-rendering this component on a
 * keystroke costs nothing measurable — exactly what it cost inline.
 */
interface StudioModalsProps {
  // What the modals read of the connected surface.
  activeConnection: DatabaseConnection | null;
  schema: readonly DetailedObject[];
  schemaContext: string;
  capabilities?: ProviderCapabilities;
  databaseType?: DatabaseConnection["type"];
  connectionName?: string;

  // Save query (both shells; the embedded one gates it on its host's onSaveQuery).
  showSaveQuery: boolean;
  saveQueryModalOpen: boolean;
  onCloseSaveQuery: () => void;
  onSaveQuery: (name: string, description: string, tags: string[]) => void;
  defaultQuery: string;

  // Data import (both shells).
  showImport: boolean;
  importModalOpen: boolean;
  onCloseImport: () => void;
  /** `DataImportModal`'s own contract: `false` keeps the dialog open with `onFailure`'s message. */
  onImport: (sql: string, onFailure: (message: string) => void) => Promise<boolean | void> | void;

  // Query safety check (both shells; the embedded one supplies its own analyzer).
  safetyCheckQuery: string | null;
  onCloseSafety: () => void;
  onProceedSafety: () => void;
  onAnalyzeSafety?: SafetyAnalyzer;

  // Data profiler and code generator share the embedded shell's codeGenerator gate.
  showCodeGenerator: boolean;
  profilerPath: readonly string[] | null;
  onCloseProfiler: () => void;
  /**
   * What the profiler masks (#1421). The standalone shell hands it the configuration, switch
   * and role it hands its results grid, so the two mask the same columns; the embedded shell
   * keeps the built-in patterns its profiler always had. Required, so each shell decides it.
   */
  profilerMasking: { config: MaskingConfig; enabled: boolean; role: string | undefined };
  codeGenPath: readonly string[] | null;
  onCloseCodeGen: () => void;

  // Test data generator.
  showTestDataGenerator: boolean;
  testDataPath: readonly string[] | null;
  onCloseTestData: () => void;
  onExecuteTestData: (sql: string) => void;

  // The unlimited-rows warning both shells draw.
  unlimitedWarningOpen: boolean;
  onUnlimitedWarningChange: (open: boolean) => void;
  onLoadAll: () => void;
}

export function StudioModals({
  activeConnection,
  schema,
  schemaContext,
  capabilities,
  databaseType,
  connectionName,
  showSaveQuery,
  saveQueryModalOpen,
  onCloseSaveQuery,
  onSaveQuery,
  defaultQuery,
  showImport,
  importModalOpen,
  onCloseImport,
  onImport,
  safetyCheckQuery,
  onCloseSafety,
  onProceedSafety,
  onAnalyzeSafety,
  showCodeGenerator,
  profilerPath,
  onCloseProfiler,
  profilerMasking,
  codeGenPath,
  onCloseCodeGen,
  showTestDataGenerator,
  testDataPath,
  onCloseTestData,
  onExecuteTestData,
  unlimitedWarningOpen,
  onUnlimitedWarningChange,
  onLoadAll,
}: StudioModalsProps) {
  return (
    <>
      {showSaveQuery && (
        <SaveQueryModal
          isOpen={saveQueryModalOpen}
          onClose={onCloseSaveQuery}
          onSave={onSaveQuery}
          defaultQuery={defaultQuery}
        />
      )}

      {showImport && (
        <DataImportModal
          isOpen={importModalOpen}
          onClose={onCloseImport}
          onImport={onImport}
          tables={schema}
          capabilities={capabilities}
          databaseType={databaseType}
        />
      )}

      <QuerySafetyDialog
        isOpen={safetyCheckQuery !== null}
        query={safetyCheckQuery ?? ""}
        schemaContext={schemaContext}
        databaseType={databaseType}
        connectionName={connectionName}
        onClose={onCloseSafety}
        onProceed={onProceedSafety}
        onAnalyzeSafety={onAnalyzeSafety}
      />

      {showCodeGenerator && (
        <DataProfiler
          isOpen={profilerPath !== null}
          onClose={onCloseProfiler}
          tablePath={profilerPath ?? []}
          tableSchema={objectAtPath(schema, profilerPath)}
          connection={activeConnection}
          catalog={
            capabilities === undefined || profilerPath === null ? undefined : catalogOfPath(capabilities, profilerPath)
          }
          schemaContext={schemaContext}
          databaseType={databaseType}
          maskingConfig={profilerMasking.config}
          maskingEnabled={profilerMasking.enabled}
          userRole={profilerMasking.role}
        />
      )}

      {showCodeGenerator && (
        <CodeGenerator
          isOpen={codeGenPath !== null}
          onClose={onCloseCodeGen}
          tablePath={codeGenPath ?? []}
          tableSchema={objectAtPath(schema, codeGenPath)}
          databaseType={databaseType}
        />
      )}

      {showTestDataGenerator && (
        <TestDataGenerator
          isOpen={testDataPath !== null}
          onClose={onCloseTestData}
          tablePath={testDataPath ?? []}
          tableSchema={objectAtPath(schema, testDataPath)}
          databaseType={databaseType}
          capabilities={capabilities}
          onExecuteQuery={onExecuteTestData}
        />
      )}

      {/* Unlimited Query Warning */}
      <AlertDialog open={unlimitedWarningOpen} onOpenChange={onUnlimitedWarningChange}>
        <AlertDialogContent className="bg-overlay border-hairline max-w-sm p-0 gap-0 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-red-500/10 flex items-center justify-center shrink-0">
                <TriangleAlert strokeWidth={1.5} className="w-5 h-5 text-warning" />
              </div>
              <div className="flex-1 min-w-0">
                <AlertDialogTitle className="text-xs font-medium text-fg mb-1">Load all results?</AlertDialogTitle>
                <AlertDialogDescription className="text-xs text-fg-muted leading-relaxed">
                  This may slow down your browser. Max <span className="text-fg-tertiary">100K</span> rows will be
                  loaded.
                </AlertDialogDescription>
              </div>
            </div>
          </div>
          <div className="px-6 pb-6 flex gap-2">
            <AlertDialogCancel className="flex-1 h-9 bg-fill border-0 text-fg-tertiary text-xs font-medium hover:bg-fill-strong hover:text-fg dark:bg-fill dark:hover:bg-fill-strong">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onLoadAll}
              className="flex-1 h-9 bg-warning-solid border-0 text-white text-xs font-medium hover:bg-warning-solid-hover"
            >
              Load All
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
