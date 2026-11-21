import { typeIdRefusal, type TypeIdRefusal } from "@/lib/db/type-id";
import { cn } from "@/lib/utils";

/** "Unavailable", with the refusal's sentence as its title and as screen-reader text, as the sidebar row draws it. */
function Marker({ refusal, className }: { refusal: TypeIdRefusal; className?: string }) {
  return (
    <span className={cn("text-xs font-medium text-muted-foreground", className)} title={refusal.sentence}>
      Unavailable<span className="sr-only">: {refusal.sentence}</span>
    </span>
  );
}

/**
 * The marker a picker outside the editor draws beside a connection whose type names no provider (FND-1), and nothing
 * for a connection whose type is a type id.
 */
export function UnavailableTypeMarker({ type, className }: { type: unknown; className?: string }) {
  const refusal = typeIdRefusal(type);
  return refusal === null ? null : <Marker refusal={refusal} className={className} />;
}

/**
 * A picker entry's type: `(type)` for a type id, otherwise the Unavailable marker (FND-1). The raw value of a type
 * that is not a type id is never rendered, so one that is not text cannot throw in render.
 */
export function ConnectionTypeLabel({ type, className }: { type: unknown; className?: string }) {
  const refusal = typeIdRefusal(type);
  if (refusal !== null) return <Marker refusal={refusal} className={className} />;
  return <span className={cn("text-xs text-muted-foreground", className)}>({String(type)})</span>;
}
