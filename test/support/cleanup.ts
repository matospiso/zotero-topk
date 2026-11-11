const cleanups: Array<() => unknown | Promise<unknown>> = [];
export function onCleanup(cleanup: () => unknown | Promise<unknown>) {
 cleanups.push(cleanup);
}
export async function cleanup() {
 const errors: unknown[] = [];
 while (cleanups.length) {
  try { await cleanups.pop()!(); } catch (error) { errors.push(error); }
 }
 if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
}
