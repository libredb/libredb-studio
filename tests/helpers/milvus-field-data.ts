/**
 * FieldData columns in the wire shape `client.ts` declares, for the Milvus field-data and result tests (vector-family
 * spec 5.5). A column carries one arm, named by the virtual `data` or `field` property as proto-loader sets it.
 */
import type { WireFieldData, WireScalarField, WireVectorField } from "@/lib/db/providers/vector/milvus/client";

const NO_SCALARS: Omit<WireScalarField, "data"> = {
  bool_data: null,
  int_data: null,
  long_data: null,
  float_data: null,
  double_data: null,
  string_data: null,
  bytes_data: null,
  array_data: null,
  json_data: null,
  geometry_data: null,
  timestamptz_data: null,
  geometry_wkt_data: null,
  mol_data: null,
  mol_smiles_data: null,
  date_data: null,
  time_data: null,
};

const NO_VECTORS: Omit<WireVectorField, "dim" | "data"> = {
  float_vector: null,
  binary_vector: new Uint8Array(0),
  float16_vector: new Uint8Array(0),
  bfloat16_vector: new Uint8Array(0),
  sparse_float_vector: null,
  int8_vector: new Uint8Array(0),
  vector_array: null,
};

type ScalarArm = keyof typeof NO_SCALARS;

/** One scalar arm set to `data`. */
export function scalars(arm: ScalarArm, data: readonly unknown[]): WireScalarField {
  return { ...NO_SCALARS, [arm]: { data }, data: arm } as WireScalarField;
}

/** An Array column's arm: one ScalarField per row, of `elementType`. */
export function arrayScalars(elementType: string, rows: readonly WireScalarField[]): WireScalarField {
  return { ...NO_SCALARS, array_data: { data: rows, element_type: elementType }, data: "array_data" };
}

export function scalarColumn(
  name: string,
  type: string,
  field: WireScalarField,
  options: { readonly valid?: readonly boolean[]; readonly dynamic?: boolean } = {},
): WireFieldData {
  return {
    type,
    field_name: name,
    scalars: field,
    vectors: null,
    struct_arrays: null,
    field_id: "0",
    is_dynamic: options.dynamic === true,
    valid_data: options.valid ?? [],
    field: "scalars",
  };
}

type VectorArm = keyof typeof NO_VECTORS;

/** One vector arm set to `value`, with its dimension. */
export function vectors(dim: number, arm: VectorArm, value: unknown): WireVectorField {
  return { ...NO_VECTORS, dim: String(dim), [arm]: value, data: arm } as WireVectorField;
}

export function vectorColumn(
  name: string,
  type: string,
  field: WireVectorField,
  valid: readonly boolean[] = [],
): WireFieldData {
  return {
    type,
    field_name: name,
    scalars: null,
    vectors: field,
    struct_arrays: null,
    field_id: "0",
    is_dynamic: false,
    valid_data: valid,
    field: "vectors",
  };
}

/** The dynamic field `$meta`, each row's raw JSON text as the server stores it. */
export function dynamicColumn(rows: readonly string[]): WireFieldData {
  return scalarColumn("$meta", "JSON", scalars("json_data", rows.map(utf8)), { dynamic: true });
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
