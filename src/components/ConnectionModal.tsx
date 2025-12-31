"use client";

import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DatabaseConnection, DatabaseType } from '@/lib/types';
import { Cloud, HardDrive, Database, Cpu, ShieldCheck, Zap, Globe, Key } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
}

export function ConnectionModal({ isOpen, onClose, onConnect }: ConnectionModalProps) {
  const [type, setType] = useState<DatabaseType>('postgres');
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('5432');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [database, setDatabase] = useState('');
  const [isTesting, setIsTesting] = useState(false);

  const handleConnect = async () => {
    setIsTesting(true);
    // Simulate connection test
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const newConn: DatabaseConnection = {
      id: Math.random().toString(36).substr(2, 9),
      name: name || `${type}-connection`,
      type,
      host,
      port: parseInt(port),
      user,
      password,
      database,
      createdAt: new Date(),
    };
    
    onConnect(newConn);
    setIsTesting(false);
    
    // Reset form
    setName('');
    setUser('');
    setPassword('');
    setDatabase('');
  };

    const dbTypes: { value: DatabaseType, label: string, icon: React.ComponentType<{ className?: string }>, color: string }[] = [
      { value: 'postgres', label: 'PostgreSQL', icon: Cloud, color: 'text-blue-400' },
      { value: 'mysql', label: 'MySQL', icon: HardDrive, color: 'text-amber-400' },
      { value: 'mongodb', label: 'MongoDB', icon: Database, color: 'text-emerald-400' },
      { value: 'redis', label: 'Redis', icon: Cpu, color: 'text-rose-400' },
      { value: 'demo', label: 'Demo Data', icon: Zap, color: 'text-yellow-400' },
    ];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px] bg-[#0a0a0a] border-white/5 text-zinc-200 p-0 overflow-hidden shadow-2xl">
        <div className="h-2 w-full bg-blue-600/20">
          <motion.div 
            initial={{ width: 0 }}
            animate={{ width: '100%' }}
            className="h-full bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
          />
        </div>
        
        <div className="p-8">
          <DialogHeader className="mb-8">
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
                <Zap className="w-5 h-5 text-blue-400" />
              </div>
              <DialogTitle className="text-2xl font-bold tracking-tight">New Connection</DialogTitle>
            </div>
            <p className="text-sm text-zinc-500">Configure your database connection parameters securely.</p>
          </DialogHeader>

          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3">
              {dbTypes.map((db) => (
                <button
                  key={db.value}
                  onClick={() => {
                    setType(db.value);
                    if (db.value === 'postgres') setPort('5432');
                    if (db.value === 'mysql') setPort('3306');
                    if (db.value === 'mongodb') setPort('27017');
                    if (db.value === 'redis') setPort('6379');
                  }}
                  className={cn(
                    "flex flex-col items-center justify-center p-4 rounded-xl border transition-all duration-200 gap-2 group",
                    type === db.value 
                      ? "bg-blue-600/10 border-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.1)]" 
                      : "bg-zinc-900/50 border-white/5 hover:border-white/10 hover:bg-zinc-900"
                  )}
                >
                  <db.icon className={cn("w-6 h-6 mb-1 transition-transform group-hover:scale-110", type === db.value ? db.color : "text-zinc-600")} />
                  <span className={cn("text-xs font-semibold", type === db.value ? "text-zinc-200" : "text-zinc-500")}>
                    {db.label}
                  </span>
                </button>
              ))}
            </div>

              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                {type !== 'demo' ? (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Globe className="w-3 h-3 text-zinc-500" />
                        <Label htmlFor="host" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Host & Instance</Label>
                      </div>
                      <div className="grid grid-cols-4 gap-3">
                        <Input 
                          id="host" 
                          value={host} 
                          onChange={(e) => setHost(e.target.value)} 
                          placeholder="localhost"
                          className="col-span-3 h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                        />
                        <Input 
                          id="port" 
                          value={port} 
                          onChange={(e) => setPort(e.target.value)} 
                          className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm font-mono"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Key className="w-3 h-3 text-zinc-500" />
                          <Label htmlFor="user" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Username</Label>
                        </div>
                        <Input 
                          id="user" 
                          value={user} 
                          onChange={(e) => setUser(e.target.value)} 
                          placeholder="postgres"
                          className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <ShieldCheck className="w-3 h-3 text-zinc-500" />
                          <Label htmlFor="password" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Password</Label>
                        </div>
                        <Input 
                          id="password" 
                          type="password" 
                          value={password} 
                          onChange={(e) => setPassword(e.target.value)} 
                          placeholder="••••••••"
                          className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Database className="w-3 h-3 text-zinc-500" />
                        <Label htmlFor="database" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Database Name</Label>
                      </div>
                      <Input 
                        id="database" 
                        value={database} 
                        onChange={(e) => setDatabase(e.target.value)} 
                        placeholder="production_db"
                        className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm font-mono"
                      />
                    </div>
                  </>
                ) : (
                  <div className="p-8 border border-white/5 rounded-xl bg-zinc-900/30 text-center space-y-3">
                    <Zap className="w-8 h-8 text-yellow-500 mx-auto opacity-50" />
                    <div className="space-y-1">
                      <h4 className="text-sm font-semibold text-zinc-300">Demo Connection Mode</h4>
                      <p className="text-xs text-zinc-500 leading-relaxed">
                        No real database required. This mode will load a pre-populated schema with mock data for testing the interface.
                      </p>
                    </div>
                    <div className="pt-2">
                       <Label htmlFor="name" className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-2 block text-left">Connection Name</Label>
                       <Input 
                        id="name" 
                        value={name} 
                        onChange={(e) => setName(e.target.value)} 
                        placeholder="My Demo DB"
                        className="h-10 bg-zinc-900/50 border-white/5 focus:border-blue-500/50 transition-all text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>
          </div>
        </div>

        <DialogFooter className="bg-zinc-900/30 p-6 flex items-center justify-between sm:justify-between border-t border-white/5 gap-3">
          <Button 
            variant="ghost" 
            onClick={onClose} 
            className="text-zinc-500 hover:text-zinc-200 hover:bg-white/5 text-xs font-semibold"
          >
            Cancel
          </Button>
          <Button 
            onClick={handleConnect} 
            disabled={isTesting}
            className="bg-blue-600 hover:bg-blue-500 text-white min-w-[140px] font-bold text-xs h-10 shadow-lg shadow-blue-900/20 group relative overflow-hidden"
          >
            <AnimatePresence mode="wait">
              {isTesting ? (
                <motion.div 
                  key="testing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2"
                >
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Testing...
                </motion.div>
              ) : (
                <motion.div 
                  key="connect"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2"
                >
                  Establish Connection
                </motion.div>
              )}
            </AnimatePresence>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
