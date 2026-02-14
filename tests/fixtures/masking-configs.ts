import type { MaskingConfig } from '@/lib/data-masking';

export const mockMaskingConfigEnabled: MaskingConfig = {
  enabled: true,
  patterns: [
    {
      id: 'builtin-email',
      name: 'Email',
      columnPatterns: ['email', 'e_mail', 'user_email'],
      maskType: 'email',
      enabled: true,
      isBuiltin: true,
    },
    {
      id: 'builtin-ssn',
      name: 'SSN',
      columnPatterns: ['ssn', 'social_security'],
      maskType: 'ssn',
      enabled: true,
      isBuiltin: true,
    },
    {
      id: 'builtin-card',
      name: 'Credit Card',
      columnPatterns: ['credit_card', 'card_number'],
      maskType: 'card',
      enabled: true,
      isBuiltin: true,
    },
    {
      id: 'builtin-phone',
      name: 'Phone',
      columnPatterns: ['phone', 'mobile'],
      maskType: 'phone',
      enabled: true,
      isBuiltin: true,
    },
    {
      id: 'builtin-financial',
      name: 'Financial',
      columnPatterns: ['salary', 'income', 'balance'],
      maskType: 'financial',
      enabled: true,
      isBuiltin: true,
    },
  ],
  roleSettings: {
    admin: { canToggle: true, canReveal: true },
    user: { canToggle: false, canReveal: false },
  },
};

export const mockMaskingConfigDisabled: MaskingConfig = {
  ...mockMaskingConfigEnabled,
  enabled: false,
};

export const mockMaskingConfigUserCanToggle: MaskingConfig = {
  ...mockMaskingConfigEnabled,
  roleSettings: {
    admin: { canToggle: true, canReveal: true },
    user: { canToggle: true, canReveal: true },
  },
};

export const mockMaskingConfigAllDisabledPatterns: MaskingConfig = {
  enabled: true,
  patterns: mockMaskingConfigEnabled.patterns.map(p => ({ ...p, enabled: false })),
  roleSettings: mockMaskingConfigEnabled.roleSettings,
};

export const mockMaskingConfigWithCustom: MaskingConfig = {
  ...mockMaskingConfigEnabled,
  patterns: [
    ...mockMaskingConfigEnabled.patterns,
    {
      id: 'custom-1',
      name: 'Custom Secret',
      columnPatterns: ['secret_field', 'internal_.*'],
      maskType: 'custom',
      enabled: true,
      isBuiltin: false,
      customMask: '[REDACTED]',
    },
  ],
};
