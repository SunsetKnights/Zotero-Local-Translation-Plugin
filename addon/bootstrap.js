/* Plugin bootstrap. Zotero calls these methods in the plugin sandbox
   (see chrome/content/zotero/xpcom/plugins.js). The bundle holds all business
   code; this file only registers chrome and forwards lifecycle calls. */

var ztPlugin = null;
var ztChromeFile = null;

/* Zotero does not register a plugin's chrome.manifest, and chrome windows in
   this Gecko version refuse to load jar:/file: documents, so the plugin's own
   windows are only reachable through a registered chrome:// package. */
function ztRegisterChrome(rootURI) {
	try {
		var inner = rootURI.replace(/^jar:/, '').replace(/!\/?.*$/, '');
		var uri = Services.io.newURI(inner);
		ztChromeFile = uri.QueryInterface(Components.interfaces.nsIFileURL).file;
		Components.manager.addBootstrappedManifestLocation(ztChromeFile);
		return true;
	}
	catch (e) {
		Zotero.logError(e);
		return false;
	}
}

function ztUnregisterChrome() {
	try {
		if (ztChromeFile) {
			Components.manager.removeBootstrappedManifestLocation(ztChromeFile);
		}
	}
	catch (e) {
		Zotero.logError(e);
	}
	ztChromeFile = null;
}

function install(data, reason) {
	// assets are prepared lazily, so install has nothing to do
}

async function startup({ id, version, rootURI }, reason) {
	try {
		var chromeReady = ztRegisterChrome(rootURI);
		Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/scripts/bundle.js', {
			target: globalThis,
			ignoreCache: true
		});
		ztPlugin = globalThis.__ZoteroTranslate;
		if (!ztPlugin) {
			Zotero.logError('local-translation: bundle did not initialize');
			return;
		}
		await ztPlugin.startup({ id, version, rootURI, chromeReady });
	}
	catch (e) {
		Zotero.logError(e);
	}
}

async function shutdown(data, reason) {
	try {
		if (ztPlugin) {
			await ztPlugin.shutdown();
		}
	}
	catch (e) {
		Zotero.logError(e);
	}
	finally {
		ztPlugin = null;
		ztUnregisterChrome();
	}
}

function uninstall(data, reason) {
	ztUnregisterChrome();
}
