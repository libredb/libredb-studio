/**
 * Route Handler Wrappers
 * Optional HOF wrappers for consistent error handling in API routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { createErrorResponse } from './errors';

/**
 * Wraps a database API route handler with standardized error handling.
 * Catches all errors and maps them via createErrorResponse.
 */
export function withDbErrorHandler(
  handler: (req: NextRequest) => Promise<NextResponse>,
  route?: string
): (req: NextRequest) => Promise<NextResponse> {
  return async (req: NextRequest) => {
    try {
      return await handler(req);
    } catch (error) {
      return createErrorResponse(error, { route });
    }
  };
}

/**
 * Wraps an AI API route handler with standardized error handling.
 * Supports both NextResponse (error) and Response (streaming) return types.
 */
export function withAiErrorHandler(
  handler: (req: NextRequest) => Promise<Response | NextResponse>,
  route?: string
): (req: NextRequest) => Promise<Response | NextResponse> {
  return async (req: NextRequest) => {
    try {
      return await handler(req);
    } catch (error) {
      return createErrorResponse(error, { route });
    }
  };
}
