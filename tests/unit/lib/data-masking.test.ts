import { describe, test, expect, beforeEach } from 'bun:test';

// Ensure `typeof window !== 'undefined'` passes in data-masking.ts SSR guards
if (typeof globalThis.window === 'undefined') {
  // @ts-expect-error — minimal window stub for SSR guard
  globalThis.window = globalThis;
}
import {
  maskByType,
  maskValueByPattern,
  maskValue,
  detectSensitiveColumnsFromConfig,
  detectSensitiveColumns,
  hasSensitiveColumns,
  applyMaskingToRows,
  shouldMask,
  canToggleMasking,
  canReveal,
  loadMaskingConfig,
  saveMaskingConfig,
  getPreviewMasked,
  DEFAULT_MASKING_CONFIG,
  MASKING_CONFIG_KEY,
} from '@/lib/data-masking';
import type { MaskingPattern, MaskingConfig, MaskType } from '@/lib/data-masking';
import {
  mockMaskingConfigEnabled,
  mockMaskingConfigDisabled,
  mockMaskingConfigUserCanToggle,
  mockMaskingConfigAllDisabledPatterns,
  mockMaskingConfigWithCustom,
} from '../../fixtures/masking-configs';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePattern(maskType: MaskType, customMask?: string): MaskingPattern {
  return {
    id: 'test-pattern',
    name: 'Test',
    columnPatterns: ['test'],
    maskType,
    enabled: true,
    isBuiltin: false,
    customMask,
  };
}

// ─── maskByType ─────────────────────────────────────────────────────────────

describe('maskByType', () => {
  test('masks email address', () => {
    const result = maskByType('john.doe@example.com', makePattern('email'));
    expect(result).toContain('@');
    expect(result).toStartWith('j');
    expect(result).toContain('*');
    expect(result).not.toBe('john.doe@example.com');
  });

  test('masks malformed email (no @)', () => {
    const result = maskByType('notanemail', makePattern('email'));
    expect(result).toBe('***@***.***');
  });

  test('masks phone number', () => {
    const result = maskByType('+1-555-123-4567', makePattern('phone'));
    // Should show last 4 digits
    expect(result).toEndWith('4567');
    expect(result).toContain('*');
  });

  test('masks short phone number (less than 4 digits)', () => {
    const result = maskByType('123', makePattern('phone'));
    expect(result).toBe('***');
  });

  test('masks credit card number', () => {
    const result = maskByType('4111111111111234', makePattern('card'));
    expect(result).toBe('****-****-****-1234');
  });

  test('masks credit card with dashes', () => {
    const result = maskByType('4111-1111-1111-5678', makePattern('card'));
    expect(result).toBe('****-****-****-5678');
  });

  test('masks SSN', () => {
    const result = maskByType('123-45-6789', makePattern('ssn'));
    expect(result).toStartWith('***-**-');
    expect(result).toEndWith('6789');
  });

  test('full mask replaces everything', () => {
    const result = maskByType('some secret value', makePattern('full'));
    expect(result).toBe('********');
  });

  test('partial mask preserves first/last 4 chars for long values', () => {
    const result = maskByType('sk-proj-abc123xyz789', makePattern('partial'));
    expect(result).toStartWith('sk-p');
    expect(result).toEndWith('z789');
    expect(result).toContain('*');
  });

  test('partial mask fully masks short values (<=8 chars)', () => {
    const result = maskByType('abcd1234', makePattern('partial'));
    expect(result).toBe('********');
  });

  test('masks IP address', () => {
    const result = maskByType('192.168.1.100', makePattern('ip'));
    expect(result).toBe('192.***.***.100');
  });

  test('masks non-IPv4 address', () => {
    const result = maskByType('::1', makePattern('ip'));
    expect(result).toBe('***');
  });

  test('masks date', () => {
    const result = maskByType('1990-05-15', makePattern('date'));
    expect(result).toBe('****-**-15');
  });

  test('masks short date', () => {
    const result = maskByType('05', makePattern('date'));
    expect(result).toBe('****-**-**');
  });

  test('masks financial value', () => {
    const result = maskByType('85000.00', makePattern('financial'));
    expect(result).toBe('***,***.**');
  });

  test('custom mask returns custom string', () => {
    const result = maskByType('anything', makePattern('custom', '[REDACTED]'));
    expect(result).toBe('[REDACTED]');
  });

  test('custom mask with no customMask falls back to ***', () => {
    const result = maskByType('anything', makePattern('custom'));
    expect(result).toBe('***');
  });
});

// ─── maskValueByPattern ─────────────────────────────────────────────────────

describe('maskValueByPattern', () => {
  test('returns NULL for null value', () => {
    expect(maskValueByPattern(null, makePattern('email'))).toBe('NULL');
  });

  test('returns NULL for undefined value', () => {
    expect(maskValueByPattern(undefined, makePattern('email'))).toBe('NULL');
  });

  test('masks string value using pattern', () => {
    const result = maskValueByPattern('john@example.com', makePattern('email'));
    expect(result).toContain('*');
    expect(result).not.toBe('john@example.com');
  });

  test('converts number to string before masking', () => {
    const result = maskValueByPattern(12345, makePattern('full'));
    expect(result).toBe('********');
  });
});

// ─── maskValue (legacy) ─────────────────────────────────────────────────────

describe('maskValue', () => {
  test('returns NULL for null value', () => {
    const rule = { pattern: /test/, label: 'Test', mask: () => 'MASKED' };
    expect(maskValue(null, rule)).toBe('NULL');
  });

  test('returns NULL for undefined value', () => {
    const rule = { pattern: /test/, label: 'Test', mask: () => 'MASKED' };
    expect(maskValue(undefined, rule)).toBe('NULL');
  });

  test('applies mask function to string value', () => {
    const rule = {
      pattern: /test/,
      label: 'Test',
      mask: (v: string) => v.toUpperCase(),
    };
    expect(maskValue('hello', rule)).toBe('HELLO');
  });
});

// ─── detectSensitiveColumnsFromConfig ───────────────────────────────────────

describe('detectSensitiveColumnsFromConfig', () => {
  test('detects matching columns based on enabled patterns', () => {
    const result = detectSensitiveColumnsFromConfig(
      ['id', 'name', 'email', 'phone'],
      mockMaskingConfigEnabled
    );
    expect(result.size).toBe(2);
    expect(result.has('email')).toBe(true);
    expect(result.has('phone')).toBe(true);
    expect(result.has('id')).toBe(false);
  });

  test('returns empty map when all patterns are disabled', () => {
    const result = detectSensitiveColumnsFromConfig(
      ['email', 'ssn', 'phone'],
      mockMaskingConfigAllDisabledPatterns
    );
    expect(result.size).toBe(0);
  });

  test('matches case-insensitively', () => {
    const result = detectSensitiveColumnsFromConfig(
      ['EMAIL', 'Phone'],
      mockMaskingConfigEnabled
    );
    expect(result.has('EMAIL')).toBe(true);
    expect(result.has('Phone')).toBe(true);
  });

  test('detects custom regex patterns', () => {
    const result = detectSensitiveColumnsFromConfig(
      ['secret_field', 'internal_data', 'public_field'],
      mockMaskingConfigWithCustom
    );
    expect(result.has('secret_field')).toBe(true);
    expect(result.has('internal_data')).toBe(true);
    expect(result.has('public_field')).toBe(false);
  });

  test('returns empty map for no fields', () => {
    const result = detectSensitiveColumnsFromConfig([], mockMaskingConfigEnabled);
    expect(result.size).toBe(0);
  });

  test('only first matching pattern wins for a field', () => {
    const config: MaskingConfig = {
      enabled: true,
      patterns: [
        { ...makePattern('email'), columnPatterns: ['email'], id: 'p1' },
        { ...makePattern('full'), columnPatterns: ['email'], id: 'p2' },
      ],
      roleSettings: DEFAULT_MASKING_CONFIG.roleSettings,
    };
    const result = detectSensitiveColumnsFromConfig(['email'], config);
    expect(result.get('email')!.maskType).toBe('email');
  });
});

// ─── detectSensitiveColumns (legacy) ────────────────────────────────────────

describe('detectSensitiveColumns', () => {
  test('detects email column', () => {
    const result = detectSensitiveColumns(['id', 'email', 'name']);
    expect(result.has('email')).toBe(true);
    expect(result.get('email')!.label).toBe('Email');
  });

  test('detects password column', () => {
    const result = detectSensitiveColumns(['password']);
    expect(result.has('password')).toBe(true);
    expect(result.get('password')!.label).toBe('Password');
  });

  test('detects SSN column', () => {
    const result = detectSensitiveColumns(['ssn']);
    expect(result.has('ssn')).toBe(true);
  });

  test('detects credit_card column', () => {
    const result = detectSensitiveColumns(['credit_card']);
    expect(result.has('credit_card')).toBe(true);
  });

  test('returns empty map for non-sensitive columns', () => {
    const result = detectSensitiveColumns(['id', 'name', 'created_at']);
    expect(result.size).toBe(0);
  });

  test('is case insensitive', () => {
    const result = detectSensitiveColumns(['Email', 'PASSWORD']);
    expect(result.has('Email')).toBe(true);
    expect(result.has('PASSWORD')).toBe(true);
  });
});

// ─── shouldMask ─────────────────────────────────────────────────────────────

describe('shouldMask', () => {
  test('admin role with masking enabled returns true', () => {
    expect(shouldMask('admin', mockMaskingConfigEnabled)).toBe(true);
  });

  test('admin role with masking disabled returns false', () => {
    expect(shouldMask('admin', mockMaskingConfigDisabled)).toBe(false);
  });

  test('user role with canToggle=false always returns true', () => {
    expect(shouldMask('user', mockMaskingConfigEnabled)).toBe(true);
  });

  test('user role with canToggle=true respects config.enabled', () => {
    expect(shouldMask('user', mockMaskingConfigUserCanToggle)).toBe(true);
    const disabledTogglable: MaskingConfig = {
      ...mockMaskingConfigUserCanToggle,
      enabled: false,
    };
    expect(shouldMask('user', disabledTogglable)).toBe(false);
  });

  test('undefined role is treated as user', () => {
    expect(shouldMask(undefined, mockMaskingConfigEnabled)).toBe(true);
  });
});

// ─── canToggleMasking ───────────────────────────────────────────────────────

describe('canToggleMasking', () => {
  test('admin can toggle by default', () => {
    expect(canToggleMasking('admin', mockMaskingConfigEnabled)).toBe(true);
  });

  test('user cannot toggle by default', () => {
    expect(canToggleMasking('user', mockMaskingConfigEnabled)).toBe(false);
  });

  test('user can toggle when config allows', () => {
    expect(canToggleMasking('user', mockMaskingConfigUserCanToggle)).toBe(true);
  });

  test('undefined role treated as user', () => {
    expect(canToggleMasking(undefined, mockMaskingConfigEnabled)).toBe(false);
  });
});

// ─── canReveal ──────────────────────────────────────────────────────────────

describe('canReveal', () => {
  test('admin can reveal by default', () => {
    expect(canReveal('admin', mockMaskingConfigEnabled)).toBe(true);
  });

  test('user cannot reveal by default', () => {
    expect(canReveal('user', mockMaskingConfigEnabled)).toBe(false);
  });

  test('user can reveal when config allows', () => {
    expect(canReveal('user', mockMaskingConfigUserCanToggle)).toBe(true);
  });

  test('undefined role treated as user', () => {
    expect(canReveal(undefined, mockMaskingConfigEnabled)).toBe(false);
  });
});

// ─── hasSensitiveColumns ────────────────────────────────────────────────────

describe('hasSensitiveColumns', () => {
  test('returns true when sensitive columns present', () => {
    expect(hasSensitiveColumns(['id', 'email', 'name'])).toBe(true);
  });

  test('returns true for password column', () => {
    expect(hasSensitiveColumns(['password'])).toBe(true);
  });

  test('returns false for non-sensitive columns', () => {
    expect(hasSensitiveColumns(['id', 'name', 'created_at'])).toBe(false);
  });

  test('returns false for empty array', () => {
    expect(hasSensitiveColumns([])).toBe(false);
  });
});

// ─── applyMaskingToRows ─────────────────────────────────────────────────────

describe('applyMaskingToRows', () => {
  const rows = [
    { id: 1, email: 'alice@example.com', name: 'Alice' },
    { id: 2, email: 'bob@example.com', name: 'Bob' },
  ];

  test('returns original rows when sensitiveColumns is empty', () => {
    const result = applyMaskingToRows(rows, ['id', 'email', 'name'], new Map());
    expect(result).toBe(rows); // same reference, not copied
  });

  test('masks sensitive columns', () => {
    const sensitiveColumns = detectSensitiveColumnsFromConfig(
      ['id', 'email', 'name'],
      mockMaskingConfigEnabled
    );
    const result = applyMaskingToRows(rows, ['id', 'email', 'name'], sensitiveColumns);
    expect(result[0].id).toBe(1);
    expect(result[0].name).toBe('Alice');
    expect(result[0].email).not.toBe('alice@example.com');
    expect(result[0].email).toContain('*');
  });

  test('preserves null values (does not mask)', () => {
    const rowsWithNull = [{ id: 1, email: null, name: 'Alice' }];
    const sensitiveColumns = detectSensitiveColumnsFromConfig(
      ['id', 'email', 'name'],
      mockMaskingConfigEnabled
    );
    const result = applyMaskingToRows(
      rowsWithNull as unknown as Record<string, unknown>[],
      ['id', 'email', 'name'],
      sensitiveColumns
    );
    expect(result[0].email).toBeNull();
  });

  test('does not mutate original rows', () => {
    const original = [{ id: 1, email: 'test@test.com' }];
    const sensitiveColumns = detectSensitiveColumnsFromConfig(
      ['id', 'email'],
      mockMaskingConfigEnabled
    );
    applyMaskingToRows(original, ['id', 'email'], sensitiveColumns);
    expect(original[0].email).toBe('test@test.com');
  });
});

// ─── loadMaskingConfig / saveMaskingConfig ────────────────────────────────
// `globalThis.window` is set at the top of this file so the localStorage
// code path inside loadMaskingConfig / saveMaskingConfig is exercised.

describe('loadMaskingConfig', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('returns DEFAULT_MASKING_CONFIG when no stored config', () => {
    const result = loadMaskingConfig();
    expect(result.enabled).toBe(DEFAULT_MASKING_CONFIG.enabled);
    expect(result.patterns.length).toBe(DEFAULT_MASKING_CONFIG.patterns.length);
  });

  test('loads stored config from localStorage', () => {
    const customConfig: MaskingConfig = {
      ...mockMaskingConfigDisabled,
      patterns: mockMaskingConfigDisabled.patterns,
    };
    localStorage.setItem(MASKING_CONFIG_KEY, JSON.stringify(customConfig));
    const result = loadMaskingConfig();
    expect(result.enabled).toBe(false);
  });

  test('returns default config for broken JSON', () => {
    localStorage.setItem(MASKING_CONFIG_KEY, '{broken json!!!');
    const result = loadMaskingConfig();
    expect(result.enabled).toBe(DEFAULT_MASKING_CONFIG.enabled);
  });

  test('merges new builtin patterns into stored config', () => {
    // Store a config with only 1 pattern
    const partial: MaskingConfig = {
      enabled: true,
      patterns: [
        {
          id: 'builtin-email',
          name: 'Email',
          columnPatterns: ['email'],
          maskType: 'email',
          enabled: true,
          isBuiltin: true,
        },
      ],
      roleSettings: DEFAULT_MASKING_CONFIG.roleSettings,
    };
    localStorage.setItem(MASKING_CONFIG_KEY, JSON.stringify(partial));
    const result = loadMaskingConfig();
    // Should have added the other missing builtins
    expect(result.patterns.length).toBeGreaterThan(1);
    expect(result.patterns.some((p) => p.id === 'builtin-ssn')).toBe(true);
  });

  test('adds default roleSettings if missing from stored config', () => {
    const noRoles = {
      enabled: true,
      patterns: DEFAULT_MASKING_CONFIG.patterns,
    };
    localStorage.setItem(MASKING_CONFIG_KEY, JSON.stringify(noRoles));
    const result = loadMaskingConfig();
    expect(result.roleSettings).toBeDefined();
    expect(result.roleSettings.admin.canToggle).toBe(true);
  });
});

describe('saveMaskingConfig', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('saves config to localStorage', () => {
    saveMaskingConfig(mockMaskingConfigDisabled);
    const stored = localStorage.getItem(MASKING_CONFIG_KEY);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.enabled).toBe(false);
  });

  test('overwrites existing config', () => {
    saveMaskingConfig(mockMaskingConfigEnabled);
    saveMaskingConfig(mockMaskingConfigDisabled);
    const stored = JSON.parse(localStorage.getItem(MASKING_CONFIG_KEY)!);
    expect(stored.enabled).toBe(false);
  });
});

// ─── getPreviewMasked ───────────────────────────────────────────────────────

describe('getPreviewMasked', () => {
  const maskTypes: MaskType[] = [
    'email',
    'phone',
    'card',
    'ssn',
    'full',
    'partial',
    'ip',
    'date',
    'financial',
    'custom',
  ];

  for (const type of maskTypes) {
    test(`returns masked preview for ${type}`, () => {
      const result = getPreviewMasked(type);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      if (type !== 'full' && type !== 'financial' && type !== 'custom') {
        expect(result).toContain('*');
      }
    });
  }

  test('email preview masks sample email', () => {
    const result = getPreviewMasked('email');
    expect(result).toContain('@');
    expect(result).toStartWith('j'); // john.doe... -> j***
  });

  test('card preview shows last 4 digits', () => {
    const result = getPreviewMasked('card');
    expect(result).toBe('****-****-****-1234');
  });

  test('custom preview uses provided customMask', () => {
    const result = getPreviewMasked('custom', '[HIDDEN]');
    expect(result).toBe('[HIDDEN]');
  });

  test('custom preview falls back to *** without customMask', () => {
    const result = getPreviewMasked('custom');
    expect(result).toBe('***');
  });

  test('financial preview returns fixed format', () => {
    expect(getPreviewMasked('financial')).toBe('***,***.**');
  });

  test('ip preview masks middle octets', () => {
    expect(getPreviewMasked('ip')).toBe('192.***.***.100');
  });

  test('ssn preview hides first 5 digits', () => {
    const result = getPreviewMasked('ssn');
    expect(result).toStartWith('***-**-');
  });

  test('date preview hides year and month', () => {
    const result = getPreviewMasked('date');
    expect(result).toBe('****-**-15');
  });

  test('full preview returns ********', () => {
    expect(getPreviewMasked('full')).toBe('********');
  });
});
