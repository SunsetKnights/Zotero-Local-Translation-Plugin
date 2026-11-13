# Default preferences for the local translation plugin.
# Zotero loads this file from the plugin root into the default preference branch.

pref("extensions.zotero.localTranslation.threads", 4);
# Optional idle release. Off by default: the model stays loaded until Zotero
# exits or the user presses "release model now".
pref("extensions.zotero.localTranslation.autoReleaseModel", false);
# Threshold for the optional feature; it is ignored while the switch is off.
pref("extensions.zotero.localTranslation.idleReleaseMs", 300000);
pref("extensions.zotero.localTranslation.useGpu", true);
pref("extensions.zotero.localTranslation.gpuLayers", -1);

