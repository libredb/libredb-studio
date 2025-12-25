import { useCallback } from "react";
import { toast as sonnerToast } from "sonner";

interface ToastParams {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

export function useToast() {
  const toast = useCallback(({ title, description, variant }: ToastParams) => {
    if (variant === "destructive") {
      sonnerToast.error(title, { description });
    } else {
      sonnerToast.success(title, { description });
    }
  }, []);

  return { toast };
}
