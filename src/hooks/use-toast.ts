import { useCallback } from "react";
import { toast as sonnerToast } from "sonner";

interface ToastParams {
  title: string;
  description?: string;
  /** `loading` is a toast that stays until a later toast with its id replaces it. */
  variant?: "default" | "destructive" | "loading";
  /** Replace the toast this id names (one `toast()` returned) instead of adding another. */
  id?: string | number;
}

export function useToast() {
  const toast = useCallback(({ title, description, variant, id }: ToastParams): string | number => {
    // `id` only when given, so a plain toast keeps passing `{ description }` alone.
    const options = id === undefined ? { description } : { description, id };
    if (variant === "destructive") return sonnerToast.error(title, options);
    if (variant === "loading") return sonnerToast.loading(title, options);
    return sonnerToast.success(title, options);
  }, []);

  return { toast };
}
