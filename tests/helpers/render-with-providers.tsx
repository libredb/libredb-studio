/**
 * Component test wrapper with common providers
 * Provides theme, toast, and router context for component rendering
 */
import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';

function AllProviders({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export { renderWithProviders as renderUI };
