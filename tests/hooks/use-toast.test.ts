import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';

import { describe, test, expect, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

import { useToast } from '@/hooks/use-toast';

// =============================================================================
// useToast Tests
// =============================================================================
describe('useToast', () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  test('returns a toast function', () => {
    const { result } = renderHook(() => useToast());

    expect(result.current.toast).toBeDefined();
    expect(typeof result.current.toast).toBe('function');
  });

  test('calls sonnerToast.success for default variant', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({
        title: 'Success',
        description: 'Operation completed',
      });
    });

    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Success', {
      description: 'Operation completed',
    });
    expect(mockToastError).not.toHaveBeenCalled();
  });

  test('calls sonnerToast.error for destructive variant', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({
        title: 'Error occurred',
        description: 'Something went wrong',
        variant: 'destructive',
      });
    });

    expect(mockToastError).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith('Error occurred', {
      description: 'Something went wrong',
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  test('handles missing description', () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.toast({
        title: 'No description',
      });
    });

    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('No description', {
      description: undefined,
    });
  });
});
