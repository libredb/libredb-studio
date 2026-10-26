import { ApiErrorCode } from "@/lib/api/error-codes";

const ACCOUNT_STORE_UNAVAILABLE_MESSAGE = "Account store unavailable";

export const ACCOUNT_STORE_UNAVAILABLE_BODY = {
  error: ACCOUNT_STORE_UNAVAILABLE_MESSAGE,
  code: ApiErrorCode.ACCOUNT_STORE_UNAVAILABLE,
} as const;
