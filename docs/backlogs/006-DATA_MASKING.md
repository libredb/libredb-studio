# Data Masking

## Overview
Automatically mask sensitive data (PII, credentials, financial info) in query results based on user role and column patterns. Protect sensitive information while maintaining data utility.

## Problem Statement
Organizations face challenges with sensitive data visibility:
- Developers seeing production PII during debugging
- Screenshots/screen shares exposing customer data
- Compliance requirements (GDPR, HIPAA, PCI-DSS)
- Accidental data exposure in demos/presentations

Current solutions are inadequate:
- Database-level masking (complex to configure)
- Manual data sanitization (time-consuming)
- Separate dev/prod environments (data drift)
- Trust-based access (risky)

## Proposed Solution
Client-side data masking with:
- Automatic detection of sensitive columns
- Role-based masking rules (admin sees all, user sees masked)
- Toggle to reveal/hide masked data
- Configurable masking patterns

## Features

### 1. Automatic Column Detection
Detect sensitive data by column name patterns:

| Pattern | Type | Example |
|---------|------|---------|
| `*email*`, `*mail*` | Email | `j***@example.com` |
| `*phone*`, `*mobile*`, `*tel*` | Phone | `+90 5** *** ** 45` |
| `*password*`, `*secret*`, `*token*` | Credential | `••••••••` |
| `*ssn*`, `*social*`, `tc_*` | ID Number | `***-**-1234` |
| `*card*`, `*credit*` | Credit Card | `**** **** **** 4242` |
| `*salary*`, `*income*`, `*balance*` | Financial | `$***,***` |
| `*address*`, `*street*` | Address | `*** Main St, ***` |
| `*birth*`, `*dob*` | Birth Date | `**/**/1990` |
| `*ip*`, `ip_address` | IP Address | `192.***.***.1` |

### 2. Masking Toggle UI
```
┌─────────────────────────────────────────────────────────────┐
│ Results                           🔒 Masking: ON  [Toggle]  │
├─────────────────────────────────────────────────────────────┤
│ id │ name        │ email              │ phone          │    │
├────┼─────────────┼────────────────────┼────────────────┤    │
│ 1  │ John Doe    │ j***@example.com   │ +90 5** *** 45│    │
│ 2  │ Jane Smith  │ j***@company.org   │ +1 55* *** 89 │    │
│ 3  │ Bob Wilson  │ b***@test.io       │ +44 7** *** 12│    │
└─────────────────────────────────────────────────────────────┘
```

When toggled OFF (admin only):
```
┌─────────────────────────────────────────────────────────────┐
│ Results                           🔓 Masking: OFF [Toggle]  │
├─────────────────────────────────────────────────────────────┤
│ id │ name        │ email              │ phone           │   │
├────┼─────────────┼────────────────────┼─────────────────┤   │
│ 1  │ John Doe    │ john@example.com   │ +90 532 123 4545│   │
│ 2  │ Jane Smith  │ jane@company.org   │ +1 555 987 6589 │   │
│ 3  │ Bob Wilson  │ bob@test.io        │ +44 789 012 3412│   │
└─────────────────────────────────────────────────────────────┘
```

### 3. Role-Based Access
```
┌─────────────────────────────────────────────────────────────┐
│ User Role Settings                                          │
├─────────────────────────────────────────────────────────────┤
│ Admin:                                                      │
│ • Can toggle masking on/off                                 │
│ • Sees "Reveal" button on masked cells                      │
│ • Access to masking configuration                           │
│                                                             │
│ User:                                                       │
│ • Masking always enabled                                    │
│ • Cannot reveal individual values                           │
│ • No access to masking settings                             │
└─────────────────────────────────────────────────────────────┘
```

### 4. Column-Level Masking Indicator
```
┌─────────────────────────────────────────────────────────────┐
│ email 🔒              │ phone 🔒             │ name         │
├───────────────────────┼──────────────────────┼──────────────┤
│ j***@example.com      │ +90 5** *** ** 45   │ John Doe     │
└───────────────────────┴──────────────────────┴──────────────┘
```
- Lock icon indicates masked column
- Hover shows: "This column is masked (email)"
- Click lock for masking details

### 5. Masking Patterns

#### Email Masking
```
john.doe@example.com → j***.***@example.com
a@b.com → a@***.com  (preserve if too short)
```

#### Phone Masking
```
+90 532 123 4545 → +90 5** *** ** 45
(555) 123-4567 → (555) ***-**67
```

#### Credit Card Masking
```
4111 1111 1111 1111 → **** **** **** 1111
```

#### Custom Patterns
```
Full mask:     ••••••••
Partial mask:  abc***xyz (preserve start/end)
Hash mask:     #a3f2b1 (consistent hash)
Null mask:     [REDACTED]
```

### 6. Quick Reveal (Admin Only)
```
┌─────────────────────────────────────────────────────────────┐
│ j***@example.com                                      [👁️]  │
└─────────────────────────────────────────────────────────────┘
        ↓ Click reveal
┌─────────────────────────────────────────────────────────────┐
│ john.doe@example.com                                  [🔒]  │
└─────────────────────────────────────────────────────────────┘
```
- Per-cell reveal button for admins
- Auto-hide after 10 seconds
- Audit log for reveals

## Technical Considerations

### Masking Configuration
```typescript
interface MaskingConfig {
  enabled: boolean;
  patterns: MaskingPattern[];
  roleOverrides: {
    admin: { canToggle: boolean; canReveal: boolean };
    user: { canToggle: boolean; canReveal: boolean };
  };
  auditLog: boolean;
}

interface MaskingPattern {
  id: string;
  name: string;
  columnPatterns: string[];      // Regex patterns for column names
  valuePatterns?: string[];      // Regex patterns for values (optional)
  maskType: 'email' | 'phone' | 'card' | 'full' | 'partial' | 'custom';
  maskFunction?: (value: string) => string;  // Custom masking
  preserveLength?: boolean;
  preserveFormat?: boolean;
}
```

### Default Patterns (Static)
```typescript
const DEFAULT_PATTERNS: MaskingPattern[] = [
  {
    id: 'email',
    name: 'Email Addresses',
    columnPatterns: [/email/i, /e_mail/i, /mail_address/i],
    maskType: 'email',
  },
  {
    id: 'phone',
    name: 'Phone Numbers',
    columnPatterns: [/phone/i, /mobile/i, /tel/i, /gsm/i],
    maskType: 'phone',
  },
  {
    id: 'password',
    name: 'Passwords & Secrets',
    columnPatterns: [/password/i, /secret/i, /token/i, /api_key/i],
    maskType: 'full',
  },
  {
    id: 'credit_card',
    name: 'Credit Cards',
    columnPatterns: [/card/i, /credit/i, /cc_/i],
    maskType: 'card',
  },
  {
    id: 'ssn',
    name: 'ID Numbers',
    columnPatterns: [/ssn/i, /social/i, /tc_no/i, /identity/i],
    maskType: 'partial',
  },
  {
    id: 'financial',
    name: 'Financial Data',
    columnPatterns: [/salary/i, /income/i, /balance/i, /amount/i],
    maskType: 'full',
  },
];
```

### Masking Functions
```typescript
function maskEmail(value: string): string {
  const [local, domain] = value.split('@');
  if (!domain) return '***@***.***';
  const maskedLocal = local[0] + '***';
  return `${maskedLocal}@${domain}`;
}

function maskPhone(value: string): string {
  // Keep country code and last 2 digits
  return value.replace(/\d(?=\d{2})/g, '*');
}

function maskCreditCard(value: string): string {
  // Keep last 4 digits
  const digits = value.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `**** **** **** ${last4}`;
}

function maskPartial(value: string, showStart = 1, showEnd = 2): string {
  if (value.length <= showStart + showEnd) return '***';
  const start = value.slice(0, showStart);
  const end = value.slice(-showEnd);
  const middle = '*'.repeat(Math.min(value.length - showStart - showEnd, 5));
  return `${start}${middle}${end}`;
}
```

### Integration with Results Grid
```typescript
// In ResultsGrid.tsx
function formatCellValue(
  value: any,
  columnName: string,
  maskingConfig: MaskingConfig,
  userRole: 'admin' | 'user'
): { display: string; isMasked: boolean; originalValue?: any } {
  if (!maskingConfig.enabled) {
    return { display: String(value), isMasked: false };
  }

  const pattern = findMatchingPattern(columnName, maskingConfig.patterns);
  if (!pattern) {
    return { display: String(value), isMasked: false };
  }

  const masked = applyMask(value, pattern);
  return {
    display: masked,
    isMasked: true,
    originalValue: userRole === 'admin' ? value : undefined,
  };
}
```

### Storage
```typescript
// Masking config stored in localStorage
const MASKING_CONFIG_KEY = 'libredb_masking_config';

// User preference for masking toggle
const MASKING_ENABLED_KEY = 'libredb_masking_enabled';
```

## UI Components

### New Components
- `MaskingToggle.tsx` - Global masking on/off switch
- `MaskedCell.tsx` - Cell with masking and reveal button
- `MaskingIndicator.tsx` - Column header lock icon
- `MaskingSettings.tsx` - Configuration panel (admin only)
- `RevealButton.tsx` - Eye icon to reveal single value

### Integration Points
- Results toolbar: Masking toggle
- Column headers: Lock icon for masked columns
- Cell render: MaskedCell component
- Settings menu: Masking configuration

## User Flow

### User (Non-Admin)
```
1. User runs query
   ↓
2. Results display with masked columns (automatic)
   ↓
3. Lock icons visible on masked columns
   ↓
4. Cannot reveal or toggle masking
```

### Admin
```
1. Admin runs query
   ↓
2. Results display with masked columns (default)
   ↓
3. Toggle available: [🔒 Masking: ON]
   ↓
4. Click toggle → All data revealed
   ↓
5. Or click individual cell → Reveal single value
```

## Configuration UI (Admin)
```
┌─────────────────────────────────────────────────────────────┐
│ Data Masking Settings                                       │
├─────────────────────────────────────────────────────────────┤
│ [ ] Enable data masking globally                            │
│                                                             │
│ Masking Patterns:                                           │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ [✓] Email (email, mail, e_mail)                         │ │
│ │ [✓] Phone (phone, mobile, tel, gsm)                     │ │
│ │ [✓] Passwords (password, secret, token, api_key)        │ │
│ │ [✓] Credit Cards (card, credit, cc_)                    │ │
│ │ [✓] ID Numbers (ssn, tc_no, identity)                   │ │
│ │ [ ] Financial (salary, income, balance)                 │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ Role Permissions:                                           │
│ • Admin: Can toggle and reveal                              │
│ • User: Always masked, no reveal                            │
│                                                             │
│                                    [Reset Defaults] [Save]  │
└─────────────────────────────────────────────────────────────┘
```

## Visual Design

### Masked Value Styling
```css
.masked-value {
  color: #888;
  font-family: monospace;
  letter-spacing: 1px;
}

.masked-column-header {
  display: flex;
  align-items: center;
  gap: 4px;
}

.masking-lock-icon {
  color: #f59e0b;  /* Amber */
  width: 12px;
  height: 12px;
}
```

### Toggle Badge
```
🔒 Masking: ON   (amber background)
🔓 Masking: OFF  (red background, warning)
```

## Acceptance Criteria
- [ ] Sensitive columns are automatically detected by name
- [ ] Masked values display with partial visibility
- [ ] Lock icon appears on masked column headers
- [ ] Admin can toggle masking on/off globally
- [ ] Admin can reveal individual cell values
- [ ] User cannot toggle or reveal masked data
- [ ] Masking persists across sessions
- [ ] Export respects masking (user exports masked data)
- [ ] Works with all supported databases

## Security Considerations
- Masking is client-side only (for display)
- Server still returns full data to authorized users
- For true security, use database-level masking
- Audit log for reveal actions (optional)
- Clear warning when masking is disabled

## Edge Cases
- Very short values (e.g., 3-char email)
- NULL values (show as NULL, not masked)
- Non-string columns (numbers, booleans)
- Binary/blob data
- Very long values (truncate then mask)

## Estimated Effort
Low-Medium complexity

## Priority
P2 - Compliance & Security

## Phase 1 (Initial - Static)
- Hardcoded masking patterns
- Toggle on/off for admins
- Basic email, phone, password masking
- Column-based detection only

## Phase 2 (Future)
- Custom pattern configuration
- Value-based detection (regex on content)
- Audit logging
- Export policy settings
- Per-connection masking rules

## Dependencies
- Role-based access (existing)
- ResultsGrid component (existing)

## Related Features
- Query Playground (can combine with masking)
- Data Export (respect masking settings)
