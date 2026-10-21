// The view's masking rules (part 4 "The entry and the grid's props"): every channel's default configuration, with the
// switch and the reveal given to the only person there is. The grid gets no userRole, so shouldMask reads `user`.
import { DEFAULT_MASKING_CONFIG, type MaskingConfig } from "@/lib/data-masking";

const roleSettings = { ...DEFAULT_MASKING_CONFIG.roleSettings, user: { canToggle: true, canReveal: true } };

/** DEFAULT_MASKING_CONFIG with roleSettings.user = { canToggle: true, canReveal: true }; nothing else changes. */
export const EXTENSION_MASKING_CONFIG: MaskingConfig = { ...DEFAULT_MASKING_CONFIG, roleSettings };
