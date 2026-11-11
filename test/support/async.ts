export const defer = <T = void>() => {
 let resolve!: (value: T | PromiseLike<T>) => void;
 const promise = new Promise<T>((done) => { resolve = done; });
 return { promise, resolve };
};
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export async function until(predicate: () => boolean, timeoutMs = 2000) {
 const deadline = Date.now() + timeoutMs;
 while (!predicate()) {
  if (Date.now() >= deadline) throw new Error('condition did not become true');
  await tick();
 }
}
