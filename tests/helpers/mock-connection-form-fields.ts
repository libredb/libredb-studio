import { CONNECTION_FIELD_DESCRIPTORS, type ConnectionField } from "@/lib/db/connection-fields";

/** Every field the real form hook keys `fieldValues` by: each one but a consent, which is a checkbox. */
const TYPED_FIELDS = (Object.keys(CONNECTION_FIELD_DESCRIPTORS) as ConnectionField[]).filter(
  (field) => CONNECTION_FIELD_DESCRIPTORS[field].slot !== "consent",
);

/**
 * A mocked `useConnectionForm` result with the hook's by-field accessors added, derived from the per-field values
 * and setters the mock already returns (`warehouse` and `setWarehouse`), as the real hook derives them from its own
 * state. A test that overrides a field's value or setter is therefore read through the dialog's one field renderer
 * exactly as it was through a per-field box.
 */
export function withFieldAccess<T extends Record<string, unknown>>(form: T) {
  const setterOf = (field: string) =>
    form[`set${field.charAt(0).toUpperCase()}${field.slice(1)}`] as (value: string) => void;
  return {
    ...form,
    fieldValues: Object.fromEntries(TYPED_FIELDS.map((field) => [field, form[field] ?? ""])),
    setFieldValue: (field: string, value: string) => setterOf(field)(value),
  };
}
