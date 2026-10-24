import { ApiErrorCode } from "@/lib/api/error-codes";

export const ACCOUNT_STORE_UNAVAILABLE_MESSAGE = "The account store is unavailable. Try again.";

export const ACCOUNT_STORE_UNAVAILABLE_BODY = {
  error: ACCOUNT_STORE_UNAVAILABLE_MESSAGE,
  code: ApiErrorCode.ACCOUNT_STORE_UNAVAILABLE,
} as const;
