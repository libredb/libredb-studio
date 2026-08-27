"use client";

import React from "react";
import { HardDrive, Database, Archive, FolderOpen } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MonitoringData } from "@/lib/db/types";
import { PanelUnavailable } from "../PanelUnavailable";

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

  // A panel whose read failed is absent from the payload with its own message under
  // `errors`, and that is a different fact from an empty answer: rendering it as data
  // would claim a measurement the engine refused to make. The whole-dashboard error state
  // is not right either - the other panels answered - so this panel alone carries the
  // engine's own sentence. See MonitoringData in src/lib/db/types.ts.
  //
  // `overview` is not a panel of its own on this tab: what it feeds is the Storage Breakdown,
  // so that is where its sentence goes. The DB Size card keeps the "N/A" it already draws for
  // a byte figure it does not have, because a stat card has nowhere to put a sentence.
  const overviewUnavailable = data?.overview === undefined ? data?.errors?.overview : undefined;
  const storageUnavailable = data?.storage === undefined ? data?.errors?.storage : undefined;
  const tablesUnavailable = data?.tables === undefined ? data?.errors?.tables : undefined;

  // A refused table read costs more than the Largest Tables panel below, because five figures
  // on this tab come off those rows. Read as `[]`, a refusal is indistinguishable from a database
  // that holds no tables: `every()` is vacuously true, so both totals below published a
  // measured "0 B" at "0.0%" and the remainder row took the whole database at 100%. Gating the
  // two `known` flags on the refusal routes every one of those figures to the "N/A" this tab
  // already draws for a byte figure it does not have, and leaves a genuine "no tables" answer
  // at the 0 B it measured.
  const statsRefused = tablesUnavailable !== undefined;

  // Calculate totals
  //
  // Same shape as the index total below, for the same reason: a provider may report a table
  // it has no byte figure for. SQLite is the case - per-object page counts live in the
  // `dbstat` virtual table, compiled into node:sqlite and out of bun:sqlite ("no such table:
  // dbstat", measured 2026-08-24 on Bun 1.3.14 / SQLite 3.53.0) - and until this it filled
  // the field with `rowCount * 100`, which this line summed into the figure drawn beside the
  // measured database size. A partial sum would read as a measurement just as badly, so the
  // total is shown only when every table carries a figure; `every()` keeps a genuine
  // "no tables" answer at 0 B.
  const totalTableSize = tables.reduce((sum, t) => sum + (t.tableSizeBytes ?? 0), 0);
  const tableSizeKnown = !statsRefused && tables.every((t) => t.tableSizeBytes !== undefined);
  // The index total comes from the per-TABLE figure, not from summing the per-index rows.
  // InnoDB has no separate primary-key index: the clustered index IS the table, so
  // `mysql.innodb_index_stats` reports the PRIMARY row's size as the row data, and summing every
  // index row counts that data twice. Measured against MySQL 26.7.0 on a 144 KB database: the
  // per-index sum reads 147,456 B (= 49,152 data + 98,304 indexes), which drew "Indexes" as 100%
  // of the database and left the remainder at "-49152 B". Each provider's per-table
  // `indexSizeBytes` is what its own engine calls index bytes (MySQL `INDEX_LENGTH`, Postgres
  // `pg_indexes_size`), so it agrees with the DB size it is subtracted from.
  //
  // A provider may report a table without one, so a partial sum would read as a measurement:
  // the total is shown only when every table carries a figure - `every()` also keeps a genuine
  // "no tables" answer at 0 B.
  const totalIndexSize = tables.reduce((sum, t) => sum + (t.indexSizeBytes ?? 0), 0);
  const indexSizeKnown = !statsRefused && tables.every((t) => t.indexSizeBytes !== undefined);
  const walStorage = storage.find((s) => s.name === "WAL");

  const formatBytes = (bytes: number) => {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${bytes} B`;
  };

  // Calculate storage breakdown. Absence and zero are different inputs: a provider that
  // OMITS `databaseSizeBytes` is saying no byte figure is knowable - Apache Cassandra's
  // `system_views.disk_usage` publishes whole mebibytes, measured as "1 MiB" for a
  // 19,476-byte table (#424) - so there is no total to divide by and no breakdown to
  // draw, and this tab says so instead of formatting a "0 B" the engine never reported.
  // A real 0 is a third input and keeps the arithmetic below unchanged - but no provider in
  // this tree is known to send a measured one. Trino omits the key as of this round, and
  // Druid's 0 comes out of its local `asNumber`, which returns 0 for an absent row (backlog
  // D44). The distinction is honoured because the field is optional precisely so the absence
  // can be said, not because a named engine exercises the zero.
  const sizeKnown = overview?.databaseSizeBytes !== undefined;
  const totalSize = overview?.databaseSizeBytes ?? 0;
  const tablePercent = totalSize > 0 && tableSizeKnown ? (totalTableSize / totalSize) * 100 : 0;
  const indexPercent = totalSize > 0 && indexSizeKnown ? (totalIndexSize / totalSize) * 100 : 0;
  // Without the table or the index bytes the remainder is not computable either, so its bar
  // stays empty instead of absorbing the unknown share.
  const breakdownKnown = tableSizeKnown && indexSizeKnown;
  // And a share needs a total to divide by. The two shares above are each guarded on
  // `totalSize > 0`, so a total of 0 forced both to 0 and `100 - 0 - 0` handed the remainder the
  // entire bar: measured in the DOM against the tab's own measured-zero fixture, Tables and
  // Indexes read `translateX(-100%)` while the remainder read `translateX(-0%)` - a full bar over
  // a database with no bytes. `totalSize > 0` is the honest gate for every share on this tab
  // because it excludes BOTH inputs that cannot be divided by: an absent size falls to 0 here, so
  // one test covers the refusal and the measured zero alike.
  const shareKnown = breakdownKnown && totalSize > 0;
  const otherPercent = shareKnown ? Math.max(0, 100 - tablePercent - indexPercent) : 0;
  // The remainder's BYTES are gated differently, and deliberately NOT on `totalSize > 0`: with a
  // measured 0 total and no tables, `0 - 0 - 0` is an honest 0 B and stays one. What it cannot
  // survive is a NEGATIVE, which a 0 total beside per-table figures that answered produces -
  // `getTableStats()` is a separate read and does not share the overview's failure - and the
  // cascade below returns its input unchanged, so the cell drew "-943718400 B": a negative byte
  // count presented as a measurement (measured in the DOM). A negative remainder says the two
  // reads disagree, not that the unattributed share is below zero, so there is no figure to
  // print. Gating this on the share instead would refuse the honest 0 B as well.
  const otherBytes = totalSize - totalTableSize - totalIndexSize;
  const remainderKnown = breakdownKnown && otherBytes >= 0;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">DB Size</CardTitle>
            <Database strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-blue-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium truncate">{overview?.databaseSize || "N/A"}</div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Tables</CardTitle>
            <HardDrive strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            {/*
              The FIGURE is this tab's own sum of per-table bytes and stays gated on the size
              being known at all, which is the card's subject: Tables as part of the database.
              The percentage below it is gated harder, on `totalSize > 0`, because a share of a
              zero-byte total is not a smaller share - it is not a share. With a measured 0 and
              real per-table bytes this line used to read "700.00 MB" over "0.0%", which is a
              fabricated denominator under an honest numerator (measured in the DOM).
            */}
            <div className="text-lg sm:text-2xl font-medium truncate">
              {sizeKnown && tableSizeKnown ? formatBytes(totalTableSize) : "N/A"}
            </div>
            {totalSize > 0 && tableSizeKnown && (
              <p className="text-xs sm:text-xs text-muted-foreground mt-1">{tablePercent.toFixed(1)}%</p>
            )}
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">Indexes</CardTitle>
            <Archive strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-purple-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium truncate">
              {sizeKnown && indexSizeKnown ? formatBytes(totalIndexSize) : "N/A"}
            </div>
            {totalSize > 0 && indexSizeKnown && (
              <p className="text-xs sm:text-xs text-muted-foreground mt-1">{indexPercent.toFixed(1)}%</p>
            )}
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-xs sm:text-xs font-medium text-muted-foreground">WAL</CardTitle>
            <FolderOpen strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4 text-orange-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-medium truncate">
              {walStorage?.walSize || walStorage?.size || "N/A"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Storage Breakdown */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4 pb-2">
          <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
            <HardDrive strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
            Storage Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 sm:p-4 pt-0 space-y-3 sm:space-y-4">
          {overviewUnavailable ? (
            <PanelUnavailable message={overviewUnavailable} />
          ) : sizeKnown ? (
            <div className="space-y-2 sm:space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs sm:text-xs mb-1">
                  <span className="flex items-center gap-1 sm:gap-2">
                    <div className="w-2 h-2 sm:w-3 sm:h-3 rounded-sm bg-green-500" />
                    Tables
                  </span>
                  <span className="font-medium">{tableSizeKnown ? formatBytes(totalTableSize) : "N/A"}</span>
                </div>
                <Progress value={tablePercent} className="h-1.5 sm:h-2" />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs sm:text-xs mb-1">
                  <span className="flex items-center gap-1 sm:gap-2">
                    <div className="w-2 h-2 sm:w-3 sm:h-3 rounded-sm bg-purple-500" />
                    Indexes
                  </span>
                  <span className="font-medium">{indexSizeKnown ? formatBytes(totalIndexSize) : "N/A"}</span>
                </div>
                <Progress value={indexPercent} className="h-1.5 sm:h-2 [&>div]:bg-purple-500" />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs sm:text-xs mb-1">
                  <span className="flex items-center gap-1 sm:gap-2">
                    <div className="w-2 h-2 sm:w-3 sm:h-3 rounded-sm bg-muted-foreground" />
                    {/*
                      Engine-neutral on purpose. This row is arithmetic - the database bytes the
                      per-table data and index figures do not account for - and what fills it
                      differs per engine: TOAST and the free space map on PostgreSQL, the schema,
                      the freelist and page overhead on SQLite and libSQL, which have neither.
                      Labelled "Other (TOAST, FSM)" it read "4.00 KB" of PostgreSQL structures
                      against a real 64 KB libSQL database (#515) - the number was right and the
                      words were another engine's. The label now names the arithmetic. Varying the
                      wording per engine would have to come from `ProviderLabels`, the way the
                      slow-query empty state does, and this tab is passed no labels.
                    */}
                    <span className="hidden sm:inline" data-testid="storage-breakdown-other-label">
                      Other (unattributed)
                    </span>
                    <span className="sm:hidden" data-testid="storage-breakdown-other-label-compact">
                      Other
                    </span>
                  </span>
                  <span className="font-medium">{remainderKnown ? formatBytes(otherBytes) : "N/A"}</span>
                </div>
                <Progress value={otherPercent} className="h-1.5 sm:h-2 [&>div]:bg-muted-foreground" />
              </div>
            </div>
          ) : (
            // The engine answered and published no byte figure - Apache Cassandra is the case
            // (#424) - which is a different fact from the refusal above and gets this tab's own
            // copy rather than a sentence there is none of.
            <div className="text-center py-8 text-muted-foreground">
              <HardDrive strokeWidth={1.5} className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">No storage size information available.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Tablespaces */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4 pb-2">
          <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
            <FolderOpen strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
            Tablespaces
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {storageUnavailable ? (
            <PanelUnavailable message={storageUnavailable} />
          ) : storage.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <FolderOpen strokeWidth={1.5} className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">No tablespace information available.</p>
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
                          <FolderOpen
                            strokeWidth={1.5}
                            className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground flex-shrink-0"
                          />
                          <span className="font-medium text-xs sm:text-xs truncate max-w-[80px] sm:max-w-none">
                            {ts.name}
                          </span>
                          {ts.name === "pg_default" && (
                            <Badge variant="secondary" className="text-xs sm:text-xs hidden sm:inline-flex">
                              Default
                            </Badge>
                          )}
                          {ts.name === "WAL" && (
                            <Badge variant="outline" className="text-xs sm:text-xs hidden sm:inline-flex">
                              WAL
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs sm:text-xs text-muted-foreground hidden md:table-cell py-2">
                        {ts.location || "default"}
                      </TableCell>
                      <TableCell className="text-right text-xs py-2">{ts.size}</TableCell>
                      <TableCell className="text-right hidden sm:table-cell py-2">
                        {ts.usagePercent !== undefined ? (
                          <div className="flex items-center justify-end gap-1 sm:gap-2">
                            <Progress value={ts.usagePercent} className="w-12 sm:w-16 h-1.5 sm:h-2" />
                            <span className="text-xs w-10 sm:w-12">{ts.usagePercent.toFixed(0)}%</span>
                          </div>
                        ) : (
                          "-"
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
          <CardTitle className="text-xs sm:text-xs font-medium flex items-center gap-2">
            <Database strokeWidth={1.5} className="h-3 w-3 sm:h-4 sm:w-4" />
            Largest Tables
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {tablesUnavailable ? (
            <PanelUnavailable message={tablesUnavailable} />
          ) : tables.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Database strokeWidth={1.5} className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-xs">No table information available.</p>
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
                      // `tableSizeBytes` is what says whether this engine publishes per-table
                      // bytes at all: a total is the table's own pages plus its indexes, so an
                      // engine that cannot measure the first cannot have measured the sum. When
                      // it is absent the share is left as "-" rather than drawn from the
                      // placeholder the required `totalSizeBytes` field still has to carry.
                      //
                      // A share also needs a database total to divide by, and this cell used to
                      // draw one without: with `databaseSizeBytes` absent or 0 the guard forced
                      // the share to 0 and every row rendered "0.0%" beside an empty bar -
                      // measured against a refused overview, two rows with real bytes each
                      // claiming to be 0.0% of a database whose size nothing had reported. The
                      // same defect as the remainder's full bar above, in a shape a text
                      // assertion CAN see.
                      const shareKnown = totalSize > 0 && table.tableSizeBytes !== undefined;
                      const percent = shareKnown ? (table.totalSizeBytes / totalSize) * 100 : 0;
                      return (
                        <TableRow key={`${table.schemaName}.${table.tableName}`}>
                          <TableCell className="py-2">
                            <div className="flex flex-col">
                              <span className="font-medium text-xs sm:text-xs truncate max-w-[100px] sm:max-w-[200px]">
                                {table.tableName}
                              </span>
                              <span className="text-xs sm:text-xs text-muted-foreground">{table.schemaName}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right text-xs py-2">{table.totalSize}</TableCell>
                          <TableCell className="text-right hidden sm:table-cell py-2">
                            {shareKnown ? (
                              <div className="flex items-center justify-end gap-1 sm:gap-2">
                                <Progress value={percent} className="w-12 sm:w-16 h-1.5 sm:h-2" />
                                <span className="text-xs w-10 sm:w-12">{percent.toFixed(1)}%</span>
                              </div>
                            ) : (
                              "-"
                            )}
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
