import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface GroupNameDialogProps {
  title: string;
  submitLabel: string;
  initialName?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}

/** Asks for a group's name. Mounted only while open, so each opening starts from `initialName`. */
export function GroupNameDialog({ title, submitLabel, initialName = "", onSubmit, onClose }: GroupNameDialogProps) {
  const [name, setName] = useState(initialName);
  const blank = name.trim() === "";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!blank) onSubmit(name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <input
            // oxlint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            aria-label="Group name"
            className="my-4 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-brand-solid"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={blank}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
