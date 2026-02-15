// Format cell value for display
export function formatCellValue(value: unknown): { display: string; className: string } {
  if (value === null || value === undefined) {
    return { display: 'NULL', className: 'text-zinc-600 italic' };
  }
  if (typeof value === 'object') {
    return { display: JSON.stringify(value), className: 'text-blue-400/80 italic font-light' };
  }
  if (typeof value === 'number') {
    return { display: String(value), className: 'text-amber-500/90 font-medium' };
  }
  if (typeof value === 'boolean') {
    return { display: String(value), className: value ? 'text-emerald-500/90' : 'text-rose-500/90' };
  }
  const strVal = String(value).toLowerCase();
  if (strVal === 'true' || strVal === 'active' || strVal === 'enabled') {
    return { display: String(value), className: 'text-emerald-500/90' };
  }
  if (strVal === 'false' || strVal === 'inactive' || strVal === 'disabled') {
    return { display: String(value), className: 'text-rose-500/90' };
  }
  return { display: String(value), className: 'text-zinc-300' };
}
