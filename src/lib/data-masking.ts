/**
 * Data Masking Utility
 * Auto-detects sensitive columns by name patterns and masks their values.
 */

export interface MaskingRule {
  pattern: RegExp;
  label: string;
  mask: (value: string) => string;
}

const MASKING_RULES: MaskingRule[] = [
  {
    pattern: /^(email|e_mail|user_email|customer_email|contact_email)$/i,
    label: 'Email',
    mask: (v) => {
      const parts = v.split('@');
      if (parts.length !== 2) return '***@***.***';
      const name = parts[0];
      const domain = parts[1];
      return `${name[0]}${'*'.repeat(Math.max(name.length - 1, 2))}@${domain[0]}${'*'.repeat(Math.max(domain.length - 1, 2))}`;
    },
  },
  {
    pattern: /^(password|passwd|pass|pwd|secret|user_password|hashed_password|password_hash|hash)$/i,
    label: 'Password',
    mask: () => '********',
  },
  {
    pattern: /^(ssn|social_security|social_security_number|national_id|national_number)$/i,
    label: 'SSN',
    mask: (v) => `***-**-${v.slice(-4).padStart(4, '*')}`,
  },
  {
    pattern: /^(credit_card|card_number|cc_number|card_num|pan|credit_card_number)$/i,
    label: 'Credit Card',
    mask: (v) => `****-****-****-${v.replace(/\D/g, '').slice(-4).padStart(4, '*')}`,
  },
  {
    pattern: /^(phone|phone_number|mobile|cell|telephone|tel|contact_phone)$/i,
    label: 'Phone',
    mask: (v) => {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 4) return '***';
      return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
    },
  },
  {
    pattern: /^(token|access_token|refresh_token|api_key|apikey|api_secret|secret_key|auth_token|bearer_token|session_token)$/i,
    label: 'Token/Key',
    mask: (v) => `${v.slice(0, 4)}${'*'.repeat(Math.max(v.length - 8, 4))}${v.slice(-4)}`,
  },
  {
    pattern: /^(address|street|street_address|home_address|billing_address|shipping_address)$/i,
    label: 'Address',
    mask: () => '*** **** ***',
  },
  {
    pattern: /^(ip|ip_address|client_ip|remote_ip|source_ip)$/i,
    label: 'IP Address',
    mask: (v) => {
      const parts = v.split('.');
      if (parts.length === 4) return `${parts[0]}.***.***.${parts[3]}`;
      return '***';
    },
  },
];

/**
 * Detect which columns should be masked based on their names
 */
export function detectSensitiveColumns(fields: string[]): Map<string, MaskingRule> {
  const sensitiveMap = new Map<string, MaskingRule>();

  for (const field of fields) {
    for (const rule of MASKING_RULES) {
      if (rule.pattern.test(field)) {
        sensitiveMap.set(field, rule);
        break;
      }
    }
  }

  return sensitiveMap;
}

/**
 * Mask a single value based on its masking rule
 */
export function maskValue(value: unknown, rule: MaskingRule): string {
  if (value === null || value === undefined) return 'NULL';
  return rule.mask(String(value));
}

/**
 * Check if any fields in the result are sensitive
 */
export function hasSensitiveColumns(fields: string[]): boolean {
  return fields.some(field =>
    MASKING_RULES.some(rule => rule.pattern.test(field))
  );
}
