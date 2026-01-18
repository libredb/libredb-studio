"use client";

import React, { useState } from 'react';
import { 
  Dialog, DialogContent, DialogHeader, 
  DialogTitle, DialogFooter, DialogDescription 
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Bookmark, Tag } from 'lucide-react';

interface SaveQueryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, description: string, tags: string[]) => void;
  defaultQuery: string;
}

export function SaveQueryModal({ isOpen, onClose, onSave, defaultQuery }: SaveQueryModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  const handleSave = () => {
    if (!name) return;
    const tags = tagsInput.split(',').map(t => t.trim()).filter(t => t);
    onSave(name, description, tags);
    setName('');
    setDescription('');
    setTagsInput('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="bg-[#0d0d0d] border-white/10 text-zinc-300 sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <Bookmark className="w-5 h-5 text-blue-500" /> Save Query
          </DialogTitle>
          <DialogDescription className="text-zinc-500">
            Give your query a name and description to find it easily later.
          </DialogDescription>
        </DialogHeader>
        
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="name" className="text-xs font-bold uppercase tracking-widest text-zinc-500">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Monthly Active Users"
              className="bg-white/5 border-white/10 focus:ring-blue-500/20"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description" className="text-xs font-bold uppercase tracking-widest text-zinc-500">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this query do?"
              className="bg-white/5 border-white/10 focus:ring-blue-500/20 min-h-[80px]"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tags" className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
              <Tag className="w-3 h-3" /> Tags (comma separated)
            </Label>
            <Input
              id="tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="reports, analytics, users"
              className="bg-white/5 border-white/10 focus:ring-blue-500/20"
            />
          </div>
          <div className="mt-2">
            <Label className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-2 block">Preview</Label>
            <div className="bg-[#050505] p-3 rounded-md border border-white/5 max-h-[100px] overflow-y-auto">
              <pre className="text-[10px] font-mono text-zinc-500 italic whitespace-pre-wrap break-words">
                {defaultQuery}
              </pre>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-zinc-400">Cancel</Button>
          <Button 
            onClick={handleSave} 
            disabled={!name}
            className="bg-blue-600 hover:bg-blue-500 text-white font-bold"
          >
            Save Query
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
