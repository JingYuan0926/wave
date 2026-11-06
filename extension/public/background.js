// Open WAVE in Chrome's side panel when the toolbar icon is clicked.
// A side panel (unlike a popup) stays open while you approve in the
// World ID Simulator in another tab.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));
