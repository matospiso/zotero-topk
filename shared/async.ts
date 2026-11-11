export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTimeout<T>(operation: Promise<T>, ms: number, error: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(error()), ms);
	});
	try { return await Promise.race([operation, timeout]); }
	finally { clearTimeout(timer!); }
}
