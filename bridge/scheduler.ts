import type { UpsertRequest, DeleteRequest, LibraryRequest } from "../shared/protocol";

// A client HTTP timeout does not cancel a TopK write, so request ordering is enforced here, by
// attachment scope. Uploads run concurrently with each other (the client, not this process, sets
// the pace; TopK applies backpressure through transient errors that withRetry() honours). A
// deletion waits for earlier uploads or deletions of the same attachments and later ones wait for
// it, so a late upload cannot follow its deletion. Reconfiguration waits for every earlier request
// and blocks every later one, so nothing crosses into another destination.
interface Scope { all?: boolean; upload?: boolean; scopes?: string[] }
interface ScheduledRequest { all: boolean; upload: boolean; scopes: string[]; settled: Promise<void> }
function overlaps(a: string, b: string) {
	// "lib" covers the whole library; "lib/KEY" one attachment. Library keys never contain "/".
	return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
function conflicts(a: ScheduledRequest, b: ScheduledRequest) {
	if (a.all || b.all) return true;
	if (a.upload && b.upload) return false;
	return a.scopes.some((s) => b.scopes.some((t) => overlaps(s, t)));
}
export function createScheduler() {
	const inflight: ScheduledRequest[] = [];
	return function scheduled<T, R>(scopeOf: (body: T) => Scope, fn: (body: T) => R | PromiseLike<R>) {
		return (body: T) => {
			const entry: ScheduledRequest = { all: false, upload: false, scopes: [], settled: Promise.resolve(), ...scopeOf(body) };
			const earlier = inflight.filter((e) => conflicts(e, entry));
			const run = Promise.all(earlier.map((e) => e.settled)).then(() => fn(body));
			entry.settled = run.then(() => {}, () => {});
			inflight.push(entry);
			return run.finally(() => inflight.splice(inflight.indexOf(entry), 1));
		};
	};
}

const list = <T>(v: T[]): T[] => (Array.isArray(v) ? v : []);
export const SCOPE = {
	all: () => ({ all: true }),
	read: () => ({}), // reads overlap writes, but must stay on their side of configure
	upload: (body: UpsertRequest) => ({ upload: true, scopes: list(body.docs).map((d) => `${d && d.library_key}/${d && d.attachment_key}`) }),
	attachments: (body: DeleteRequest) => ({ scopes: list(body.attachmentKeys).map((k) => `${body.libraryKey}/${k}`) }),
	library: (body: LibraryRequest) => ({ scopes: [String(body.libraryKey)] }),
};

