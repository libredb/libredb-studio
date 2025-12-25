'use client';

import React, { useState } from 'react';
import { Users, Skull, Activity, Clock, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { MonitoringData, ActiveSessionDetails } from '@/lib/db/types';

interface SessionsTabProps {
  data: MonitoringData | null;
  loading: boolean;
  onKillSession: (pid: number | string) => Promise<boolean>;
}

export function SessionsTab({ data, loading, onKillSession }: SessionsTabProps) {
  const [killingPid, setKillingPid] = useState<number | string | null>(null);
  const [confirmKill, setConfirmKill] = useState<ActiveSessionDetails | null>(null);

  if (loading && !data) {
    return <SessionsSkeleton />;
  }

  const sessions = data?.activeSessions ?? [];

  const activeCount = sessions.filter((s) => s.state === 'active').length;
  const idleCount = sessions.filter((s) => s.state === 'idle').length;
  const idleInTxCount = sessions.filter((s) =>
    s.state?.includes('idle in transaction')
  ).length;
  const waitingCount = sessions.filter((s) => s.waitEventType).length;

  const handleKillClick = (session: ActiveSessionDetails) => {
    setConfirmKill(session);
  };

  const handleConfirmKill = async () => {
    if (!confirmKill) return;

    setKillingPid(confirmKill.pid);
    setConfirmKill(null);

    await onKillSession(confirmKill.pid);

    setKillingPid(null);
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case 'active':
        return <Badge className="bg-green-500">Active</Badge>;
      case 'idle':
        return <Badge variant="secondary">Idle</Badge>;
      case 'idle in transaction':
        return <Badge className="bg-yellow-500">Idle in TX</Badge>;
      case 'idle in transaction (aborted)':
        return <Badge variant="destructive">Aborted TX</Badge>;
      default:
        return <Badge variant="outline">{state}</Badge>;
    }
  };

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-2 sm:gap-4">
        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Active
            </CardTitle>
            <Activity className="h-3 w-3 sm:h-4 sm:w-4 text-green-500" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{activeCount}</div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Idle
            </CardTitle>
            <Clock className="h-3 w-3 sm:h-4 sm:w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{idleCount}</div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              In TX
            </CardTitle>
            <Clock className={`h-3 w-3 sm:h-4 sm:w-4 ${idleInTxCount > 0 ? 'text-yellow-500' : 'text-muted-foreground'}`} />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{idleInTxCount}</div>
          </CardContent>
        </Card>

        <Card className="p-0">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 sm:p-4 pb-1 sm:pb-2">
            <CardTitle className="text-[10px] sm:text-sm font-medium text-muted-foreground">
              Wait
            </CardTitle>
            <Users className={`h-3 w-3 sm:h-4 sm:w-4 ${waitingCount > 0 ? 'text-orange-500' : 'text-muted-foreground'}`} />
          </CardHeader>
          <CardContent className="p-2 sm:p-4 pt-0">
            <div className="text-lg sm:text-2xl font-bold">{waitingCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Sessions Table */}
      <Card className="p-0">
        <CardHeader className="p-3 sm:p-4">
          <CardTitle className="text-xs sm:text-sm font-medium flex items-center gap-2">
            <Users className="h-3 w-3 sm:h-4 sm:w-4" />
            Sessions ({sessions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 sm:p-4 sm:pt-0">
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No active sessions found.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs w-[60px]">PID</TableHead>
                    <TableHead className="text-xs">User</TableHead>
                    <TableHead className="text-xs">State</TableHead>
                    <TableHead className="text-xs hidden md:table-cell">Query</TableHead>
                    <TableHead className="text-xs">Time</TableHead>
                    <TableHead className="text-xs hidden lg:table-cell">Wait</TableHead>
                    <TableHead className="text-right text-xs w-12">Act</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => (
                    <TableRow key={session.pid}>
                      <TableCell className="font-mono text-[10px] sm:text-xs py-2">
                        {session.pid}
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex flex-col">
                          <span className="font-medium text-xs truncate max-w-[60px] sm:max-w-[100px]">{session.user}</span>
                          {session.applicationName && (
                            <span className="text-[10px] text-muted-foreground truncate max-w-[60px] sm:max-w-[100px] hidden sm:block">
                              {session.applicationName}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="py-2">{getStateBadge(session.state)}</TableCell>
                      <TableCell className="font-mono text-[10px] hidden md:table-cell py-2">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="max-w-[150px] lg:max-w-[250px] truncate cursor-help">
                                {session.query || '-'}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="max-w-lg"
                            >
                              <pre className="text-xs whitespace-pre-wrap">
                                {session.query || 'No query'}
                              </pre>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="py-2">
                        <Badge
                          variant={
                            session.durationMs > 60000
                              ? 'destructive'
                              : session.durationMs > 10000
                                ? 'outline'
                                : 'secondary'
                          }
                          className="text-[10px] sm:text-xs"
                        >
                          {session.duration}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-[10px] text-muted-foreground hidden lg:table-cell py-2">
                        {session.waitEventType
                          ? `${session.waitEventType}`
                          : '-'}
                      </TableCell>
                      <TableCell className="text-right py-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 sm:h-8 sm:w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleKillClick(session)}
                          disabled={killingPid === session.pid}
                        >
                          {killingPid === session.pid ? (
                            <Loader2 className="h-3 w-3 sm:h-4 sm:w-4 animate-spin" />
                          ) : (
                            <Skull className="h-3 w-3 sm:h-4 sm:w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirm Kill Dialog */}
      <AlertDialog open={!!confirmKill} onOpenChange={() => setConfirmKill(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate Session?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to terminate session{' '}
              <span className="font-mono font-bold">{confirmKill?.pid}</span>?
              <br />
              <br />
              User: <span className="font-medium">{confirmKill?.user}</span>
              <br />
              State: <span className="font-medium">{confirmKill?.state}</span>
              <br />
              <br />
              This action will forcefully end the connection and may cause data
              loss if the session has uncommitted transactions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmKill}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SessionsSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-16" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-12" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
