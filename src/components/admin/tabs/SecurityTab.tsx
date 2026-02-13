'use client';

import { useState, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import {
  EyeOff,
  Lock,
  Activity,
  KeyRound,
  Save,
  RotateCcw,
} from 'lucide-react';
import { MaskingSettings } from '@/components/MaskingSettings';
import {
  DEFAULT_THRESHOLDS,
  type ThresholdConfig,
} from '@/lib/monitoring-thresholds';
import { toast } from 'sonner';

const THRESHOLD_STORAGE_KEY = 'libredb_threshold_config';

function loadThresholds(): ThresholdConfig[] {
  if (typeof window === 'undefined') return DEFAULT_THRESHOLDS;
  try {
    const stored = localStorage.getItem(THRESHOLD_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return DEFAULT_THRESHOLDS;
}

function saveThresholds(thresholds: ThresholdConfig[]) {
  localStorage.setItem(THRESHOLD_STORAGE_KEY, JSON.stringify(thresholds));
}

export function SecurityTab() {
  return (
    <div className="space-y-6">
      <Tabs defaultValue="masking">
        <TabsList className="bg-transparent border-b border-white/5 rounded-none p-0 h-10 w-full justify-start">
          <TabsTrigger
            value="masking"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs px-4"
          >
            <EyeOff className="h-3.5 w-3.5" />
            Data Masking
          </TabsTrigger>
          <TabsTrigger
            value="access"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs px-4"
          >
            <Lock className="h-3.5 w-3.5" />
            Access
          </TabsTrigger>
          <TabsTrigger
            value="thresholds"
            className="gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-400 text-zinc-500 text-xs px-4"
          >
            <Activity className="h-3.5 w-3.5" />
            Thresholds
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
      <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5 space-y-3">
        <h3 className="text-sm font-bold text-zinc-300 flex items-center gap-2">
          <Lock className="h-4 w-4 text-blue-400" />
          Security & Access
        </h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Authentication</span>
            <span className="text-zinc-300">Environment Variable (RBAC)</span>
          </div>
          <Separator className="bg-white/5" />
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">API Security</span>
            <div className="flex items-center gap-1.5">
              <KeyRound className="h-3 w-3 text-zinc-500" />
              <span className="text-zinc-300">JWT / HTTP-only Cookie</span>
            </div>
          </div>
          <Separator className="bg-white/5" />
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Admin Access</span>
            <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">
              ENABLED
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">User Access</span>
            <Badge className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">
              ENABLED
            </Badge>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5 space-y-3">
        <h3 className="text-sm font-bold text-zinc-300">Connection Security</h3>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">SSL/TLS</span>
            <Badge variant="secondary" className="text-[10px]">
              Supported
            </Badge>
          </div>
          <Separator className="bg-white/5" />
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">SSH Tunnel</span>
            <Badge variant="secondary" className="text-[10px]">
              Supported
            </Badge>
          </div>
          <Separator className="bg-white/5" />
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Data Masking</span>
            <Badge variant="secondary" className="text-[10px]">
              Configurable
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
    setThresholds(loadThresholds());
  }, []);

  const updateThreshold = (
    index: number,
    field: 'warning' | 'critical',
    value: number
  ) => {
    setThresholds((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
    setHasChanges(true);
  };

  const handleSave = () => {
    saveThresholds(thresholds);
    setHasChanges(false);
    toast.success('Threshold configuration saved');
  };

  const handleReset = () => {
    setThresholds(DEFAULT_THRESHOLDS);
    saveThresholds(DEFAULT_THRESHOLDS);
    setHasChanges(false);
    toast.success('Thresholds reset to defaults');
  };

  const getSliderColors = (threshold: ThresholdConfig) => {
    if (threshold.direction === 'above') {
      return { warn: 'text-amber-400', crit: 'text-red-400' };
    }
    return { warn: 'text-amber-400', crit: 'text-red-400' };
  };

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-white/5 bg-zinc-900/50 p-5">
        <h3 className="text-sm font-bold text-zinc-300 mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-blue-400" />
          Monitoring Thresholds
        </h3>
        <p className="text-[11px] text-zinc-500 mb-6">
          Configure warning and critical thresholds for monitoring alerts. These
          values are used by the monitoring dashboard to trigger visual alerts.
        </p>

        <div className="space-y-6">
          {thresholds.map((threshold, index) => {
            const colors = getSliderColors(threshold);
            const isPercent = threshold.metric !== 'deadlocks';
            const max = isPercent ? 100 : 20;

            return (
              <div key={threshold.metric} className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-300">
                    {threshold.label}
                  </span>
                  <span className="text-[10px] text-zinc-600 uppercase font-bold">
                    {threshold.direction === 'above'
                      ? 'Alert when above'
                      : 'Alert when below'}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  {/* Warning */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-bold ${colors.warn}`}>
                        Warning
                      </span>
                      <span className="text-xs font-mono text-zinc-400">
                        {threshold.warning}
                        {isPercent ? '%' : ''}
                      </span>
                    </div>
                    <Slider
                      value={[threshold.warning]}
                      onValueChange={(v) =>
                        updateThreshold(index, 'warning', v[0])
                      }
                      max={max}
                      step={1}
                      className="[&_[role=slider]]:bg-amber-500 [&_[role=slider]]:border-amber-500"
                    />
                  </div>

                  {/* Critical */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className={`text-xs font-bold ${colors.crit}`}>
                        Critical
                      </span>
                      <span className="text-xs font-mono text-zinc-400">
                        {threshold.critical}
                        {isPercent ? '%' : ''}
                      </span>
                    </div>
                    <Slider
                      value={[threshold.critical]}
                      onValueChange={(v) =>
                        updateThreshold(index, 'critical', v[0])
                      }
                      max={max}
                      step={1}
                      className="[&_[role=slider]]:bg-red-500 [&_[role=slider]]:border-red-500"
                    />
                  </div>
                </div>

                {index < thresholds.length - 1 && (
                  <Separator className="bg-white/5" />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 mt-6 pt-4 border-t border-white/5">
          <Button
            variant="ghost"
            size="sm"
            className="text-zinc-500 hover:text-zinc-300"
            onClick={handleReset}
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Reset Defaults
          </Button>
          <Button
            size="sm"
            className="bg-blue-600 hover:bg-blue-500 text-white"
            onClick={handleSave}
            disabled={!hasChanges}
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            Save Config
          </Button>
        </div>
      </div>
    </div>
  );
}
