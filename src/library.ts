/** Remote identities must survive Zotero database-local library ID changes. */
export function libraryKey(libraryID: number): string {
	const library = Zotero.Libraries.get(libraryID);
	if (library?.libraryType === "group") {
		return `group:${Zotero.Groups.getGroupIDFromLibraryID(libraryID)}`;
	}
	if (library?.libraryType === "user") {
		const userID = Zotero.Users.getCurrentUserID();
		return userID ? `user:${userID}` : `local:${Zotero.Users.getLocalUserKey()}`;
	}
	throw new Error(`Unsupported library: ${libraryID}`);
}

export function localLibraryID(key: string): number | undefined {
	return Zotero.Libraries.getAll().find((library: any) =>
		library.libraryType !== "feed" && libraryKey(library.libraryID) === key)?.libraryID;
}
