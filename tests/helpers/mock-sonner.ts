/**
 * Shared sonner mock for all hook and component tests.
 *
 * IMPORTANT: Bun's mock.module() is process-wide — calling it from multiple files
 * causes the LAST call to win, breaking other files' local mock references.
 * This shared module ensures mock.module('sonner') is called exactly once,
 * and all test files import the SAME mock functions.
 *
 * Usage:
 *   import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
 *   beforeEach(() => { mockToastSuccess.mockClear(); mockToastError.mockClear(); });
 */
import { mock } from 'bun:test';
import React from 'react';

export const mockToastSuccess = mock(() => {});
export const mockToastError = mock(() => {});
export const mockToastDefault = mock(() => {});
export const mockToaster = mock((props: Record<string, unknown>) =>
  React.createElement('div', { 'data-testid': 'toaster', className: props.className })
);

mock.module('sonner', () => ({
  Toaster: mockToaster,
  toast: Object.assign(mockToastDefault, {
    success: mockToastSuccess,
    error: mockToastError,
  }),
}));
