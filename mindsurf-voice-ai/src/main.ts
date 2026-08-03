import { createApp } from "vue";
import App from "./App.vue";
import OverlayApp from "./OverlayApp.vue";
import { installNativeContextMenu } from "./services/nativeContextMenu";
import { useSettingsStore } from "./stores/settingsStore";
import "./styles/base.css";

const isOverlay = new URLSearchParams(window.location.search).get("view") === "overlay";
if (isOverlay) {
  document.documentElement.classList.add("overlay-document");
}

const settings = useSettingsStore();
installNativeContextMenu(
  () =>
    settings.state.developerModeEnabled &&
    settings.state.developerUseWebViewContextMenu,
);

createApp(isOverlay ? OverlayApp : App).mount("#app");
