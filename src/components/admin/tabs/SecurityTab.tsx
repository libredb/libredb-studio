"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { EyeOff, Lock, Activity, KeyRound, Save, RotateCcw } from "lucide-react";
import { MaskingSettings } from "@/components/MaskingSettings";
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from "@/lib/monitoring-thresholds";
import { storage } from "@/lib/storage";
import { toast } from "sonner";

const MASKING_TAB_LABEL = "Data Masking";
const ACCESS_TAB_LABEL = "Access";
const THRESHOLDS_TAB_LABEL = "Thresholds";
const ACCESS_CARD_TITLE = "Security & Access";
const SUPPORTED_LABEL = "Supported";
const CONFIGURABLE_LABEL = "Configurable";
const THRESHOLDS_CARD_TITLE = "Monitoring Thresholds";
const THRESHOLDS_DESCRIPTION =
  "Configure warning and critical thresholds for monitoring alerts. These values are used by the monitoring dashboard to trigger visual alerts.";
const RESET_LABEL = "Reset Defaults";
const SAVE_LABEL = "Save Config";

export function SecurityTab() {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="masking">
        <TabsList className="bg-transparent border-b border-hairline rounded-none p-0 h-10 w-full justify-start">
          <TabsTrigger
            value="masking"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-fg-muted text-xs px-4"
          >
            <EyeOff className="h-3.5 w-3.5" />
            {MASKING_TAB_LABEL}
          </TabsTrigger>
          <TabsTrigger
            value="access"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-fg-muted text-xs px-4"
          >
            <Lock className="h-3.5 w-3.5" />
            {ACCESS_TAB_LABEL}
          </TabsTrigger>
          <TabsTrigger
            value="thresholds"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-fg-muted text-xs px-4"
          >
            <Activity className="h-3.5 w-3.5" />
            {THRESHOLDS_TAB_LABEL}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="masking" className="mt-4">
          <MaskingSettings />
        </TabsContent>

        <TabsContent value="access" className="mt-4">
          <AccessSummary />
        </TabsContent>

        <TabsContent value="thresholds" className="mt-4">
          <ThresholdSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AccessSummary() {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-xl border border-hairline bg-panel p-5 space-y-3">
        <h3 className="text-sm font-bold text-fg-secondary flex items-center gap-2">
          <Lock className="h-4 w-4 text-blue-400" />
          {ACCESS_CARD_TITLE}
        </h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Authentication</span>
            <span className="text-fg-secondary">Environment Variable (RBAC)</span>
          </div>
          <Separator className="bg-fill" />
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">API Security</span>
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3 w-3 text-fg-muted" />
              <span className="text-fg-secondary">JWT / HTTP-only Cookie</span>
            </div>
          </div>
          <Separator className="bg-fill" />
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Admin Access</span>
            <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs">ENABLED</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">User Access</span>
            <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs">ENABLED</Badge>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-hairline bg-panel p-5 space-y-3">
        <h3 className="text-sm font-bold text-fg-secondary">Connection Security</h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">SSL/TLS</span>
            <Badge variant="secondary" className="text-xs">
              {SUPPORTED_LABEL}
            </Badge>
          </div>
          <Separator className="bg-fill" />
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">SSH Tunnel</span>
            <Badge variant="secondary" className="text-xs">
              {SUPPORTED_LABEL}
            </Badge>
          </div>
          <Separator className="bg-fill" />
          <div className="flex items-center justify-between">
            <span className="text-fg-muted">Data Masking</span>
            <Badge variant="secondary" className="text-xs">
              {CONFIGURABLE_LABEL}
            </Badge>
          </div>
        </div>
      </div>
    </div>
  );
}

function ThresholdSettings() {
  const [thresholds, setThresholds] = useState<ThresholdConfig[]>(DEFAULT_THRESHOLDS);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    setThresholds(storage.getThresholdConfig());
  }, []);

  const updateThreshold = (index: number, field: "warning" | "critical", value: number) => {
    setThresholds((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
    setHasChanges(true);
  };

  const handleSave = () => {
    storage.saveThresholdConfig(thresholds);
    setHasChanges(false);
    toast.success("Threshold configuration saved");
  };

  const handleReset = () => {
    setThresholds(DEFAULT_THRESHOLDS);
    storage.saveThresholdConfig(DEFAULT_THRESHOLDS);
    setHasChanges(false);
    toast.success("Thresholds reset to defaults");
  };

  const getSliderColors = (threshold: ThresholdConfig) => {
    if (threshold.direction === "above") {
      return { warn: "text-amber-400", crit: "text-red-400" };
    }
    return { warn: "text-amber-400", crit: "text-red-400" };
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-hairline bg-panel p-5">
        <h3 className="text-sm font-bold text-fg-secondary mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-400" />
          {THRESHOLDS_CARD_TITLE}
        </h3>
        <p className="text-xs text-fg-muted mb-6">{THRESHOLDS_DESCRIPTION}</p>

        <div className="space-y-6">
          {thresholds.map((threshold, index) => {
            const colors = getSliderColors(threshold);
            const isPercent = threshold.metric !== "deadlocks";
            const max = isPercent ? 100 : 20;

            return (
              <div key={threshold.metric} className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-fg-secondary">{threshold.label}</span>
                  <span className="text-xs text-fg-subtle uppercase font-bold">
                    {threshold.direction === "above" ? "Alert when above" : "Alert when below"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-bold ${colors.warn}`}>Warning</span>
                      <span className="text-xs font-mono text-fg-tertiary">
                        {threshold.warning}
                        {isPercent ? "%" : ""}
                      </span>
                    </div>
                    <Slider
                      value={[threshold.warning]}
                      onValueChange={(v) => updateThreshold(index, "warning", v[0])}
                      max={max}
                      step={1}
                      className="[&_[role=slider]]:bg-amber-500 [&_[role=slider]]:border-amber-500"
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-bold ${colors.crit}`}>Critical</span>
                      <span className="text-xs font-mono text-fg-tertiary">
                        {threshold.critical}
                        {isPercent ? "%" : ""}
                      </span>
                    </div>
                    <Slider
                      value={[threshold.critical]}
                      onValueChange={(v) => updateThreshold(index, "critical", v[0])}
                      max={max}
                      step={1}
                      className="[&_[role=slider]]:bg-red-500 [&_[role=slider]]:border-red-500"
                    />
                  </div>
                </div>

                {index < thresholds.length - 1 && <Separator className="bg-fill" />}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-hairline">
          <Button variant="ghost" size="sm" className="text-fg-muted hover:text-fg-secondary" onClick={handleReset}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            {RESET_LABEL}
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 text-white"
            onClick={handleSave}
            disabled={!hasChanges}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {SAVE_LABEL}
          </Button>
        </div>
      </div>
    </div>
  );
}
