'use client';

import React, { useState } from 'react';
import {
  Table2,
  Search,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { MonitoringData } from '@/lib/db/types';

interface TablesTabProps {
  data: MonitoringData | null;
  loading: boolean;
  onRunMaintenance: (type: string, target?: string) => Promise<boolean>;
}

export function TablesTab({ data, loading, onRunMaintenance }: TablesTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  if (loading && !data) {
    return <TablesSkeleton />;
  }

  const tables = data?.tables ?? [];

  const filteredTables = tables.filter((t) =>
    t.tableName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Calculate totals
  const totalRows = tables.reduce((sum, t) => sum + t.rowCount, 0);
  const totalSize = tables.reduce((sum, t) => sum + t.totalSizeBytes, 0);
  const tablesNeedingVacuum = tables.filter((t) => (t.bloatRatio ?? 0) > 10).length;

  const formatBytes = (bytes: number) => {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  const formatNumber = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  const formatDate = (date?: Date) => {
    if (!date) return 'Never';
    return new Date(date).toLocaleDateString();
  };

  const handleMaintenance = async (type: string, tableName: string) => {
    setActionLoading(`${type}-${tableName}`);
    await onRunMaintenance(type, tableName);
    setActionLoading(null);
  };

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Tables
            </CardTitle>
            <Table2 className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{tables.length}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {formatNumber(totalRows)} rows
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Size
            </CardTitle>
            <Search className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{formatBytes(totalSize)}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              Total
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Vacuum
            </CardTitle>
            <AlertTriangle
              className={`h-3 w-3 sm:h-4 sm:w-4 ${tablesNeedingVacuum > 0 ? 'text-yellow-500' : 'text-green-500'}`}
            />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{tablesNeedingVacuum}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {tablesNeedingVacuum > 0 ? 'Need' : 'OK'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tables List */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
            <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
              <Table2 className="h-3 w-3 sm:h-4 sm:w-4" />
              Table Statistics
            </CardTitle>
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full sm:w-[200px] h-8 text-sm"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {filteredTables.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Table2 className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No tables found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Table</TableHead>
                    <TableHead className="text-right text-xs">Rows</TableHead>
                    <TableHead className="text-right text-xs">Size</TableHead>
                    <TableHead className="text-right text-xs hidden md:table-cell">Index</TableHead>
                    <TableHead className="text-right text-xs hidden sm:table-cell">Bloat</TableHead>
                    <TableHead className="text-xs hidden lg:table-cell">Vacuum</TableHead>
                    <TableHead className="text-right text-xs w-20">Act</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTables.map((table) => (
                    <TableRow key={`${table.schemaName}.${table.tableName}`}>
                      <TableCell className="py-2">
                        <div className="flex flex-col">
                          <span className="font-medium text-xs sm:text-sm truncate max-w-[100px] sm:max-w-[200px]">
                            {table.tableName}
                          </span>
                          <span className="text-[10px] sm:text-xs text-muted-foreground">
                            {table.schemaName}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs py-2">
                        {formatNumber(table.rowCount)}
                        {table.deadRowCount ? (
                          <span className="text-[10px] text-muted-foreground block">
                            {formatNumber(table.deadRowCount)} dead
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2">
                        {table.tableSize}
                      </TableCell>
                      <TableCell className="text-right text-xs hidden md:table-cell py-2">
                        {table.indexSize || '-'}
                      </TableCell>
                      <TableCell className="text-right hidden sm:table-cell py-2">
                        <Badge
                          variant={
                            (table.bloatRatio ?? 0) > 20
                              ? 'destructive'
                              : (table.bloatRatio ?? 0) > 10
                                ? 'outline'
                                : 'secondary'
                          }
                          className="text-[10px] sm:text-xs"
                        >
                          {(table.bloatRatio ?? 0).toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground hidden lg:table-cell py-2">
                        {formatDate(table.lastVacuum)}
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <div className="flex justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 sm:h-8 sm:w-8"
                            onClick={() => handleMaintenance('analyze', table.tableName)}
                            disabled={!!actionLoading}
                            title="Analyze"
                          >
                            {actionLoading === `analyze-${table.tableName}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Search className="h-3 w-3" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 sm:h-8 sm:w-8"
                            onClick={() => handleMaintenance('vacuum', table.tableName)}
                            disabled={!!actionLoading}
                            title="Vacuum"
                          >
                            {actionLoading === `vacuum-${table.tableName}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 sm:h-8 sm:w-8 hidden sm:inline-flex"
                            onClick={() => handleMaintenance('reindex', table.tableName)}
                            disabled={!!actionLoading}
                            title="Reindex"
                          >
                            {actionLoading === `reindex-${table.tableName}` ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <Zap className="h-3 w-3" />
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TablesSkeleton() {
  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        {[...Array(3)].map((_, i) => (
          <Card key={i} className="p-0">
            <CardHeader className="p-2 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-12 sm:w-20" />
            </CardHeader>
            <CardContent className="p-2 sm:p-4 pt-0">
              <Skeleton className="h-5 sm:h-8 w-10 sm:w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <Skeleton className="h-4 sm:h-5 w-24 sm:w-32" />
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-10 sm:h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
