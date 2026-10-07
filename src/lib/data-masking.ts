/**
 * Data Masking Utility
 * Auto-detects sensitive columns by name patterns and masks their values.
 * Supports configurable patterns, RBAC, per-cell reveal, and persistence.
 */

import { numberedRepeatBase } from "@/lib/db/utils/result-fields";

// ─── Types ───────────────────────────────────────────────────────────────────

export type MaskType = "email" | "phone" | "card" | "ssn" | "full" | "partial" | "ip" | "date" | "financial" | "custom";

export interface MaskingPattern {
  id: string;
  name: string;
  columnPatterns: string[]; // regex strings (user-editable)
  maskType: MaskType;
  enabled: boolean;
  isBuiltin: boolean; // builtin patterns cannot be deleted, only disabled
  customMask?: string; // used when maskType === 'custom'
}

export interface MaskingConfig {
  enabled: boolean; // global masking on/off
  patterns: MaskingPattern[];
  roleSettings: {
    admin: { canToggle: boolean; canReveal: boolean };
    user: { canToggle: boolean; canReveal: boolean };
  };
}

// ─── Default Masking Config ──────────────────────────────────────────────────

export const DEFAULT_MASKING_CONFIG: MaskingConfig = {
  enabled: true,
  patterns: [
    {
      id: "builtin-email",
      name: "Email",
      columnPatterns: ["email", "e_mail", "user_email", "customer_email", "contact_email"],
      maskType: "email",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-password",
      name: "Password",
      columnPatterns: [
        "password",
        "passwd",
        "pass",
        "pwd",
        "secret",
        "user_password",
        "hashed_password",
        "password_hash",
        "hash",
      ],
      maskType: "full",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-ssn",
      name: "SSN",
      columnPatterns: ["ssn", "social_security", "social_security_number", "national_id", "national_number"],
      maskType: "ssn",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-card",
      name: "Credit Card",
      columnPatterns: ["credit_card", "card_number", "cc_number", "card_num", "pan", "credit_card_number"],
      maskType: "card",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-phone",
      name: "Phone",
      columnPatterns: ["phone", "phone_number", "mobile", "cell", "telephone", "tel", "contact_phone"],
      maskType: "phone",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-token",
      name: "Token/Key",
      columnPatterns: [
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "apikey",
        "api_secret",
        "secret_key",
        "auth_token",
        "bearer_token",
        "session_token",
      ],
      maskType: "partial",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-address",
      name: "Address",
      columnPatterns: ["address", "street", "street_address", "home_address", "billing_address", "shipping_address"],
      maskType: "full",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-ip",
      name: "IP Address",
      columnPatterns: ["ip", "ip_address", "client_ip", "remote_ip", "source_ip"],
      maskType: "ip",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-financial",
      name: "Financial",
      columnPatterns: [
        "salary",
        "income",
        "balance",
        "amount",
        "wage",
        "compensation",
        "net_pay",
        "gross_pay",
        "revenue",
      ],
      maskType: "financial",
      enabled: true,
      isBuiltin: true,
    },
    {
      id: "builtin-birthdate",
      name: "Birthdate",
      columnPatterns: ["birth", "dob", "date_of_birth", "birthdate", "birth_date", "birthday"],
      maskType: "date",
      enabled: true,
      isBuiltin: true,
    },
  ],
  roleSettings: {
    admin: { canToggle: true, canReveal: true },
    user: { canToggle: false, canReveal: false },
  },
};

// ─── MaskType-based Masking Functions ────────────────────────────────────────

const MASK_FUNCTIONS: Record<MaskType, (value: string, customMask?: string) => string> = {
  email: (v) => {
    const parts = v.split("@");
    if (parts.length !== 2) return "***@***.***";
    const name = parts[0];
    const domain = parts[1];
    return `${name[0]}${"*".repeat(Math.max(name.length - 1, 2))}@${domain[0]}${"*".repeat(Math.max(domain.length - 1, 2))}`;
  },
  phone: (v) => {
    const digits = v.replace(/\D/g, "");
    if (digits.length < 4) return "***";
    return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
  },
  card: (v) => `****-****-****-${v.replace(/\D/g, "").slice(-4).padStart(4, "*")}`,
  ssn: (v) => `***-**-${v.slice(-4).padStart(4, "*")}`,
  full: () => "********",
  partial: (v) => {
    if (v.length <= 8) return "*".repeat(v.length);
    return `${v.slice(0, 4)}${"*".repeat(Math.max(v.length - 8, 4))}${v.slice(-4)}`;
  },
  ip: (v) => {
    const parts = v.split(".");
    if (parts.length === 4) return `${parts[0]}.***.***.${parts[3]}`;
    return "***";
  },
  date: (v) => {
    if (v.length >= 4) return `****-**-${v.slice(-2)}`;
    return "****-**-**";
  },
  financial: () => "***,***.**",
  custom: (_v, customMask) => customMask || "***",
};

// ─── Mask by MaskingPattern ──────────────────────────────────────────────────

export function maskByType(value: string, pattern: MaskingPattern): string {
  const fn = MASK_FUNCTIONS[pattern.maskType];
  return fn(value, pattern.customMask);
}

// ─── Config-based Detection ──────────────────────────────────────────────────

/**
 * A field name and every name it may repeat: a result numbers a repeated column `name (2)`
 * (`uniqueFieldNames`), so `email (2)` carries an email and must be matched as `email` too.
 * The base is tried even when it is not in the result (the graph asks one name at a time), and
 * an alias that merely looks numbered is masked like its base, which is the safe direction.
 */
function namesToMatch(field: string): string[] {
  const names = [field];
  for (let base = numberedRepeatBase(field); base !== null; base = numberedRepeatBase(base)) names.push(base);
  return names;
}

export function detectSensitiveColumnsFromConfig(fields: string[], config: MaskingConfig): Map<string, MaskingPattern> {
  const sensitiveMap = new Map<string, MaskingPattern>();

  const enabledPatterns = config.patterns.filter((p) => p.enabled);

  for (const field of fields) {
    const names = namesToMatch(field);
    for (const pattern of enabledPatterns) {
      const matched = pattern.columnPatterns.some((cp) =>
        names.some((name) => {
          try {
            return new RegExp(`^${cp}$`, "i").test(name);
          } catch {
            return cp.toLowerCase() === name.toLowerCase();
          }
        }),
      );
      if (matched) {
        sensitiveMap.set(field, pattern);
        break;
      }
    }
  }

  return sensitiveMap;
}

// ─── Mask Value Helpers ──────────────────────────────────────────────────────

export function maskValueByPattern(value: unknown, pattern: MaskingPattern): string {
  if (value === null || value === undefined) return "NULL";
  return maskByType(String(value), pattern);
}

// ─── Bulk Masking Utility ────────────────────────────────────────────────────

export function applyMaskingToRows(
  rows: Record<string, unknown>[],
  fields: string[],
  sensitiveColumns: Map<string, MaskingPattern>,
): Record<string, unknown>[] {
  if (sensitiveColumns.size === 0) return rows;

  return rows.map((row) => {
    const maskedRow: Record<string, unknown> = { ...row };
    for (const field of fields) {
      const pattern = sensitiveColumns.get(field);
      if (pattern && maskedRow[field] !== null && maskedRow[field] !== undefined) {
        maskedRow[field] = maskByType(String(maskedRow[field]), pattern);
      }
    }
    return maskedRow;
  });
}

// ─── RBAC Helpers ────────────────────────────────────────────────────────────

export function shouldMask(role: string | undefined, config: MaskingConfig): boolean {
  if (!role || role === "user") {
    // User role: if canToggle is false, masking is always enforced
    if (!config.roleSettings.user.canToggle) return true;
    return config.enabled;
  }
  // Admin: respects config.enabled
  return config.enabled;
}

export function canToggleMasking(role: string | undefined, config: MaskingConfig): boolean {
  if (!role || role === "user") return config.roleSettings.user.canToggle;
  return config.roleSettings.admin.canToggle;
}

export function canReveal(role: string | undefined, config: MaskingConfig): boolean {
  if (!role || role === "user") return config.roleSettings.user.canReveal;
  return config.roleSettings.admin.canReveal;
}

/**
 * Whether a result surface masks right now: the role and config allow it, and the
 * shell's switch (or, with none, the config's own flag) has it on. The grid, the
 * graph and the Data Profiler all read this, so they can never disagree about one
 * column (#1421).
 */
export function maskingInForce(role: string | undefined, config: MaskingConfig, enabled: boolean | undefined): boolean {
  return shouldMask(role, config) && (enabled ?? config.enabled);
}

// ─── Config Persistence ──────────────────────────────────────────────────────

import { storage } from "@/lib/storage";

export const MASKING_CONFIG_KEY = "libredb_masking_config";

export function loadMaskingConfig(): MaskingConfig {
  return storage.getMaskingConfig();
}

export function saveMaskingConfig(config: MaskingConfig): void {
  storage.saveMaskingConfig(config);
}

// ─── Preview Samples ─────────────────────────────────────────────────────────

export const MASK_TYPE_PREVIEWS: Record<MaskType, { sample: string; label: string }> = {
  email: { sample: "john.doe@example.com", label: "Email" },
  phone: { sample: "+1-555-123-4545", label: "Phone" },
  card: { sample: "4111111111111234", label: "Credit Card" },
  ssn: { sample: "123-45-6789", label: "SSN" },
  full: { sample: "secret_value", label: "Full Mask" },
  partial: { sample: "sk-proj-abc123xyz789", label: "Partial" },
  ip: { sample: "192.168.1.100", label: "IP Address" },
  date: { sample: "1990-05-15", label: "Date" },
  financial: { sample: "85000.00", label: "Financial" },
  custom: { sample: "any_value", label: "Custom" },
};

export function getPreviewMasked(maskType: MaskType, customMask?: string): string {
  const preview = MASK_TYPE_PREVIEWS[maskType];
  const fn = MASK_FUNCTIONS[maskType];
  return fn(preview.sample, customMask);
}
