/** Keep build-config simulations local to one test, including rejected requests. */
export async function withBasePathEnv(prefix: string, action: () => unknown | Promise<unknown>): Promise<void> {
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = prefix;
  try {
    await action();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH;
    else process.env.NEXT_PUBLIC_BASE_PATH = previous;
  }
}
