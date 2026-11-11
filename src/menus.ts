import { PLUGIN_ID } from "./prefs";
import { logError } from "./log";

interface MenuActions {
	indexNew: () => void;
	rebuildLibrary: (win: any) => void;
	openSettings: () => void;
	indexSelected: (items: any[]) => void;
	removeSelected: (items: any[]) => void;
}

export class Menus {
	private ids: string[] = [];

	register(actions: MenuActions) {
		const reg = (options: any) => {
			try {
				const id = Zotero.MenuManager.registerMenu(options);
				if (id) this.ids.push(id);
			}
			catch (e) {
				logError("registerMenu", e);
			}
		};
		reg({
			menuID: "zotero-topk-tools",
			pluginID: PLUGIN_ID,
			target: "main/menubar/tools",
			menus: [{
				menuType: "submenu",
				l10nID: "zotero-topk-menu",
				icon: "chrome://zotero-topk/content/icons/topk-16.svg",
				menus: [
					{ menuType: "menuitem", l10nID: "zotero-topk-menu-index-library", onCommand: () => actions.indexNew() },
					{ menuType: "menuitem", l10nID: "zotero-topk-menu-reindex-library", onCommand: (event: any) => actions.rebuildLibrary(event?.target?.ownerGlobal) },
					{ menuType: "separator" },
					{ menuType: "menuitem", l10nID: "zotero-topk-menu-settings", onCommand: () => actions.openSettings() },
				],
			}],
		});
		const selected = (event: any, context: any) => {
			const items = context?.items || event?.target?.ownerGlobal?.ZoteroPane?.getSelectedItems?.() || [];
			return items;
		};
		reg({
			menuID: "zotero-topk-item",
			pluginID: PLUGIN_ID,
			target: "main/library/item",
			menus: [
				{ menuType: "menuitem", l10nID: "zotero-topk-menu-index-selected", icon: "chrome://zotero-topk/content/icons/topk-16.svg",
					onCommand: (event: any, context: any) => actions.indexSelected(selected(event, context)) },
				{ menuType: "menuitem", l10nID: "zotero-topk-menu-remove-selected",
					onCommand: (event: any, context: any) => actions.removeSelected(selected(event, context)) },
			],
		});
	}

	unregister() {
		for (const id of this.ids) {
			try { Zotero.MenuManager.unregisterMenu(id); } catch (e) {}
		}
		this.ids = [];
	}
}
