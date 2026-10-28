import { BODY_CONNECTION_FIELDS } from "@/lib/db/connection-fields";

/**
 * A mocked `useConnectionForm` result with the hook's by-field accessors added, derived from the per-field values
 * and setters the mock already returns (`warehouse` and `setWarehouse`): the shape the real hook returns, where both
 * read one record. A test that overrides a field's value or setter is therefore read through the dialog's one field renderer
 * exactly as it was through a per-field box.
 */
export function withFieldAccess<T extends Record<string, unknown>>(form: T) {
  const setterOf = (field: string) =>
    form[`set${field.charAt(0).toUpperCase()}${field.slice(1)}`] as (value: string) => void;
  return {
    ...form,
    fieldValues: Object.fromEntries(BODY_CONNECTION_FIELDS.map((field) => [field, form[field] ?? ""])),
    setFieldValue: (field: string, value: string) => setterOf(field)(value),
  };
}
