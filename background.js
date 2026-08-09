const STORAGE_KEY = "enabled";

async function getEnabled() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] !== false;
}

async function setEnabled(value) {
  await chrome.storage.local.set({ [STORAGE_KEY]: value });
}

async function updateIcon(enabled) {
  const prefix = enabled ? "icon" : "icon-off";
  await chrome.action.setIcon({
    path: {
      "16": `icons/${prefix}16.png`,
      "48": `icons/${prefix}48.png`,
      "128": `icons/${prefix}128.png`
    }
  });
  await chrome.action.setTitle({
    title: enabled ? "Nico Side Comment (ON)" : "Nico Side Comment (OFF)"
  });
}

async function toggleEnabled(tabId) {
  const enabled = await getEnabled();
  const next = !enabled;
  await setEnabled(next);
  await updateIcon(next);

  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE", enabled: next });
  } catch {
    // content script not ready yet — that's fine, it reads storage on init
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    toggleEnabled(tab.id);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await setEnabled(true);
  await updateIcon(true);
});

chrome.runtime.onStartup.addListener(async () => {
  const enabled = await getEnabled();
  await updateIcon(enabled);
});
