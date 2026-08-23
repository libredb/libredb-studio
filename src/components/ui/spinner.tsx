import { LoaderCircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <LoaderCircleIcon role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  );
}

export { Spinner };
