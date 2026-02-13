'use client';

import React, { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Shield,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Save,
  Lock,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  type MaskingConfig,
  type MaskingPattern,
  type MaskType,
  DEFAULT_MASKING_CONFIG,
  MASK_TYPE_PREVIEWS,
  getPreviewMasked,
  loadMaskingConfig,
  saveMaskingConfig,
} from '@/lib/data-masking';

const ALL_MASK_TYPES: MaskType[] = ['email', 'phone', 'card', 'ssn', 'full', 'partial', 'ip', 'date', 'financial', 'custom'];

export function MaskingSettings() {
  const [config, setConfig] = useState<MaskingConfig>(() => loadMaskingConfig());
  const [editingPattern, setEditingPattern] = useState<MaskingPattern | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isNewPattern, setIsNewPattern] = useState(false);

  // Edit dialog state
  const [editName, setEditName] = useState('');
  const [editMaskType, setEditMaskType] = useState<MaskType>('full');
  const [editColumnPatterns, setEditColumnPatterns] = useState('');
  const [editCustomMask, setEditCustomMask] = useState('');

  const handleSave = useCallback(() => {
    saveMaskingConfig(config);
    toast.success('Masking configuration saved');
  }, [config]);

  const handleReset = useCallback(() => {
    setConfig(DEFAULT_MASKING_CONFIG);
    saveMaskingConfig(DEFAULT_MASKING_CONFIG);
    toast.success('Masking configuration reset to defaults');
  }, []);

  const toggleGlobal = useCallback((enabled: boolean) => {
    setConfig(prev => ({ ...prev, enabled }));
  }, []);

  const togglePatternEnabled = useCallback((patternId: string, enabled: boolean) => {
    setConfig(prev => ({
      ...prev,
      patterns: prev.patterns.map(p => p.id === patternId ? { ...p, enabled } : p),
    }));
  }, []);

  const updateRoleSetting = useCallback((
    role: 'admin' | 'user',
    key: 'canToggle' | 'canReveal',
    value: boolean
  ) => {
    setConfig(prev => ({
      ...prev,
      roleSettings: {
        ...prev.roleSettings,
        [role]: { ...prev.roleSettings[role], [key]: value },
      },
    }));
  }, []);

  const openEditDialog = useCallback((pattern: MaskingPattern) => {
    setEditingPattern(pattern);
    setEditName(pattern.name);
    setEditMaskType(pattern.maskType);
    setEditColumnPatterns(pattern.columnPatterns.join('\n'));
    setEditCustomMask(pattern.customMask || '');
    setIsNewPattern(false);
    setIsDialogOpen(true);
  }, []);

  const openNewDialog = useCallback(() => {
    setEditingPattern(null);
    setEditName('');
    setEditMaskType('full');
    setEditColumnPatterns('');
    setEditCustomMask('');
    setIsNewPattern(true);
    setIsDialogOpen(true);
  }, []);

  const handleDialogSave = useCallback(() => {
    const patterns = editColumnPatterns
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    if (!editName.trim()) {
      toast.error('Pattern name is required');
      return;
    }
    if (patterns.length === 0) {
      toast.error('At least one column pattern is required');
      return;
    }

    if (isNewPattern) {
      const newPattern: MaskingPattern = {
        id: `custom-${Date.now()}`,
        name: editName.trim(),
        columnPatterns: patterns,
        maskType: editMaskType,
        enabled: true,
        isBuiltin: false,
        customMask: editMaskType === 'custom' ? editCustomMask : undefined,
      };
      setConfig(prev => ({
        ...prev,
        patterns: [...prev.patterns, newPattern],
      }));
    } else if (editingPattern) {
      setConfig(prev => ({
        ...prev,
        patterns: prev.patterns.map(p =>
          p.id === editingPattern.id
            ? {
                ...p,
                name: editName.trim(),
                maskType: editMaskType,
                columnPatterns: patterns,
                customMask: editMaskType === 'custom' ? editCustomMask : undefined,
              }
            : p
        ),
      }));
    }

    setIsDialogOpen(false);
  }, [editName, editMaskType, editColumnPatterns, editCustomMask, isNewPattern, editingPattern]);

  const deletePattern = useCallback((patternId: string) => {
    setConfig(prev => ({
      ...prev,
      patterns: prev.patterns.filter(p => p.id !== patternId),
    }));
  }, []);

  return (
    <div className="space-y-6">
      {/* Global Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="h-5 w-5 text-purple-400" />
            Data Masking Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Global Enable */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Data Masking Globally</p>
              <p className="text-xs text-muted-foreground">
                When enabled, sensitive columns are automatically detected and masked
              </p>
            </div>
            <Switch
              checked={config.enabled}
              onCheckedChange={toggleGlobal}
            />
          </div>

          {/* Role Permissions */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Role Permissions</h3>
            <div className="grid gap-3 rounded-lg border border-white/10 p-4">
              {/* Admin Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">Admin</Badge>
                </div>
                <div className="flex items-center gap-6">
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <Switch
                      checked={config.roleSettings.admin.canToggle}
                      onCheckedChange={(v) => updateRoleSetting('admin', 'canToggle', v)}
                    />
                    Can toggle
                  </label>
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <Switch
                      checked={config.roleSettings.admin.canReveal}
                      onCheckedChange={(v) => updateRoleSetting('admin', 'canReveal', v)}
                    />
                    Can reveal
                  </label>
                </div>
              </div>
              {/* User Row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">User</Badge>
                </div>
                <div className="flex items-center gap-6">
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <Switch
                      checked={config.roleSettings.user.canToggle}
                      onCheckedChange={(v) => updateRoleSetting('user', 'canToggle', v)}
                    />
                    Can toggle
                  </label>
                  <label className="flex items-center gap-2 text-xs text-zinc-400">
                    <Switch
                      checked={config.roleSettings.user.canReveal}
                      onCheckedChange={(v) => updateRoleSetting('user', 'canReveal', v)}
                    />
                    Can reveal
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Masking Patterns */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-300">Masking Patterns</h3>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openNewDialog}>
                <Plus className="w-3 h-3 mr-1" />
                Add Pattern
              </Button>
            </div>
            <div className="max-h-[400px] overflow-y-auto rounded-lg border border-white/5 editor-scrollbar">
              <div className="space-y-2 p-1">
                {config.patterns.map(pattern => (
                  <div
                    key={pattern.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-[#0a0a0a] p-3"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Switch
                        checked={pattern.enabled}
                        onCheckedChange={(v) => togglePatternEnabled(pattern.id, v)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-200">{pattern.name}</span>
                          {pattern.isBuiltin && (
                            <Badge variant="secondary" className="text-[9px] h-4 px-1">builtin</Badge>
                          )}
                          <Badge variant="outline" className="text-[9px] h-4 px-1">{pattern.maskType}</Badge>
                        </div>
                        <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
                          {pattern.columnPatterns.join(', ')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => openEditDialog(pattern)}
                      >
                        <Pencil className="w-3 h-3 text-zinc-500" />
                      </Button>
                      {!pattern.isBuiltin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                          onClick={() => deletePattern(pattern.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Preview */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-300">Preview</h3>
            <div className="rounded-lg border border-white/5 bg-[#0a0a0a] p-4 space-y-2">
              {config.patterns.filter(p => p.enabled).slice(0, 5).map(pattern => {
                const preview = MASK_TYPE_PREVIEWS[pattern.maskType];
                const masked = getPreviewMasked(pattern.maskType, pattern.customMask);
                return (
                  <div key={pattern.id} className="flex items-center gap-2 text-xs font-mono">
                    <Lock className="w-3 h-3 text-purple-400 shrink-0" />
                    <span className="text-zinc-500 w-24 truncate">{pattern.name}:</span>
                    <span className="text-zinc-600 line-through">{preview.sample}</span>
                    <span className="text-zinc-400 mx-1">&rarr;</span>
                    <span className="text-purple-300">{masked}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-white/5">
            <Button variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="w-3 h-3 mr-1" />
              Reset Defaults
            </Button>
            <Button size="sm" onClick={handleSave}>
              <Save className="w-3 h-3 mr-1" />
              Save Config
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Edit Pattern Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isNewPattern ? 'Add Masking Pattern' : 'Edit Masking Pattern'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-300">Name</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Pattern name"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-300">Mask Type</label>
              <Select value={editMaskType} onValueChange={(v) => setEditMaskType(v as MaskType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_MASK_TYPES.map(t => (
                    <SelectItem key={t} value={t}>
                      {t} — {MASK_TYPE_PREVIEWS[t].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {editMaskType === 'custom' && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-zinc-300">Custom Mask String</label>
                <Input
                  value={editCustomMask}
                  onChange={(e) => setEditCustomMask(e.target.value)}
                  placeholder="e.g. ***"
                />
              </div>
            )}
            <div className="space-y-2">
              <label className="text-xs font-medium text-zinc-300">Column Patterns (one per line)</label>
              <textarea
                className="w-full h-32 bg-[#0a0a0a] border border-white/10 rounded-md px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:ring-1 focus:ring-purple-500/50 resize-none"
                value={editColumnPatterns}
                onChange={(e) => setEditColumnPatterns(e.target.value)}
                placeholder={"email\ne_mail\nuser_email"}
              />
              <p className="text-[10px] text-zinc-500">
                Each line is matched against column names (case-insensitive). Supports regex.
              </p>
            </div>
            {/* Preview */}
            <div className="rounded-lg border border-white/5 bg-[#0a0a0a] p-3">
              <p className="text-[10px] text-zinc-500 mb-1">Preview:</p>
              <p className="text-sm font-mono text-purple-300">
                {getPreviewMasked(editMaskType, editMaskType === 'custom' ? editCustomMask : undefined)}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleDialogSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
