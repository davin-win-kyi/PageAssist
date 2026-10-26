/*
Definition that says that if the panel is clicked on
open the panel in chrome
*/

export default defineBackground(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Unable to set side panel behavior', error));
});
