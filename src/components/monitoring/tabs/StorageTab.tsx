'use client';

import React from 'react';
import { HardDrive, Database, Archive, FolderOpen } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { MonitoringData } from '@/lib/db/types';

interface StorageTabProps {
  data: MonitoringData | null;
  loading: boolean;
}

export function StorageTab({ data, loading }: StorageTabProps) {
  if (loading && !data) {
    return <StorageSkeleton />;
  }

  const overview = data?.overview;
  const storage = data?.storage ?? [];
  const tables = data?.tables ?? [];
  const indexes = data?.indexes ?? [];

  // Calculate totals
  const totalTableSize = tables.reduce((sum, t) => sum + t.tableSizeBytes, 0);
  const totalIndexSize = indexes.reduce((sum, i) => sum + i.indexSizeBytes, 0);
  const walStorage = storage.find((s) => s.name === 'WAL');

  const formatBytes = (bytes: number) => {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  // Calculate storage breakdown
  const totalSize = overview?.databaseSizeBytes ?? 0;
  const tablePercent = totalSize > 0 ? (totalTableSize / totalSize) * 100 : 0;
  const indexPercent = totalSize > 0 ? (totalIndexSize / totalSize) * 100 : 0;
  const otherPercent = Math.max(0, 100 - tablePercent - indexPercent);

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              DB Size
            </CardTitle>
            <Database className="h-3 w-3 sm:h-4 sm:w-4 text-blue-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold truncate">
              {overview?.databaseSize || 'N/A'}
            </div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Tables
            </CardTitle>
            <HardDrive className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold truncate">{formatBytes(totalTableSize)}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {tablePercent.toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Indexes
            </CardTitle>
            <Archive className="h-3 w-3 sm:h-4 sm:w-4 text-purple-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold truncate">{formatBytes(totalIndexSize)}</div>
            <p className="text-[10px] sm:text-xs text-muted-foreground mt-1">
              {indexPercent.toFixed(1)}%
            </p>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              WAL
            </CardTitle>
            <FolderOpen className="h-3 w-3 sm:h-4 sm:w-4 text-orange-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold truncate">
              {walStorage?.walSize || walStorage?.size || 'N/A'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Storage Breakdown */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4 pb-2">
          <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
            <HardDrive className="h-3 w-3 sm:h-4 sm:w-4" />
            Storage Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0 space-y-3 sm:space-y-4">
          <div className="space-y-2 sm:space-y-3">
            <div>
              <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                <span className="flex items-center gap-1 sm:gap-2">
                  <div className="w-2 h-2 sm:w-3 sm:h-3 rounded-sm bg-green-500" />
                  Tables
                </span>
                <span className="font-medium">{formatBytes(totalTableSize)}</span>
              </div>
              <Progress value={tablePercent} className="h-1.5 sm:h-2" />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                <span className="flex items-center gap-1 sm:gap-2">
                  <div className="w-2 h-2 sm:w-3 sm:h-3 rounded-sm bg-purple-500" />
                  Indexes
                </span>
                <span className="font-medium">{formatBytes(totalIndexSize)}</span>
              </div>
              <Progress value={indexPercent} className="h-1.5 sm:h-2 [&>div]:bg-purple-500" />
            </div>

            <div>
              <div className="flex items-center justify-between text-xs sm:text-sm mb-1">
                <span className="flex items-center gap-1 sm:gap-2">
                  <div className="w-2 h-2 sm:w-3 sm:h-3 rounded-sm bg-muted-foreground" />
                  <span className="hidden sm:inline">Other (TOAST, FSM)</span>
                  <span className="sm:hidden">Other</span>
                </span>
                <span className="font-medium">
                  {formatBytes(totalSize - totalTableSize - totalIndexSize)}
                </span>
              </div>
              <Progress value={otherPercent} className="h-1.5 sm:h-2 [&>div]:bg-muted-foreground" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tablespaces */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4 pb-2">
          <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
            <FolderOpen className="h-3 w-3 sm:h-4 sm:w-4" />
            Tablespaces
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {storage.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No tablespace information available.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Location</TableHead>
                    <TableHead className="text-right text-xs">Size</TableHead>
                    <TableHead className="text-right text-xs hidden sm:table-cell">Usage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {storage.map((ts) => (
                    <TableRow key={ts.name}>
                      <TableCell className="py-2">
                        <div className="flex items-center gap-1 sm:gap-2">
                          <FolderOpen className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium text-xs sm:text-sm truncate max-w-[80px] sm:max-w-none">{ts.name}</span>
                          {ts.name === 'pg_default' && (
                            <Badge variant="secondary" className="text-[10px] sm:text-xs hidden sm:inline-flex">Default</Badge>
                          )}
                          {ts.name === 'WAL' && (
                            <Badge variant="outline" className="text-[10px] sm:text-xs hidden sm:inline-flex">WAL</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-[10px] sm:text-xs text-muted-foreground hidden md:table-cell py-2">
                        {ts.location || 'default'}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2">{ts.size}</TableCell>
                      <TableCell className="text-right hidden sm:table-cell py-2">
                        {ts.usagePercent !== undefined ? (
                          <div className="flex items-center justify-end gap-1 sm:gap-2">
                            <Progress
                              value={ts.usagePercent}
                              className="w-12 sm:w-16 h-1.5 sm:h-2"
                            />
                            <span className="text-xs w-10 sm:w-12">
                              {ts.usagePercent.toFixed(0)}%
                            </span>
                          </div>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top Tables by Size */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4 pb-2">
          <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
            <Database className="h-3 w-3 sm:h-4 sm:w-4" />
            Largest Tables
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {tables.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Database className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No table information available.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Table</TableHead>
                    <TableHead className="text-right text-xs">Size</TableHead>
                    <TableHead className="text-right text-xs hidden sm:table-cell">% of DB</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tables
                    .slice()
                    .sort((a, b) => b.totalSizeBytes - a.totalSizeBytes)
                    .slice(0, 10)
                    .map((table) => {
                      const percent =
                        totalSize > 0
                          ? (table.totalSizeBytes / totalSize) * 100
                          : 0;
                      return (
                        <TableRow key={`${table.schemaName}.${table.tableName}`}>
                          <TableCell className="py-2">
                            <div className="flex flex-col">
                              <span className="font-medium text-xs sm:text-sm truncate max-w-[100px] sm:max-w-[200px]">{table.tableName}</span>
                              <span className="text-[10px] sm:text-xs text-muted-foreground">
                                {table.schemaName}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-xs py-2">
                            {table.totalSize}
                          </TableCell>
                          <TableCell className="text-right hidden sm:table-cell py-2">
                            <div className="flex items-center justify-end gap-1 sm:gap-2">
                              <Progress
                                value={percent}
                                className="w-12 sm:w-16 h-1.5 sm:h-2"
                              />
                              <span className="text-xs w-10 sm:w-12">
                                {percent.toFixed(1)}%
                              </span>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StorageSkeleton() {
  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i} className="p-0">
            <CardHeader className="p-2 sm:p-4 pb-1 sm:pb-2">
              <Skeleton className="h-3 sm:h-4 w-12 sm:w-20" />
            </CardHeader>
            <CardContent className="p-2 sm:p-4 pt-0">
              <Skeleton className="h-5 sm:h-8 w-16 sm:w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <Skeleton className="h-4 sm:h-5 w-24 sm:w-32" />
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0">
          <div className="space-y-2 sm:space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i}>
                <Skeleton className="h-3 sm:h-4 w-full mb-1 sm:mb-2" />
                <Skeleton className="h-1.5 sm:h-2 w-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
