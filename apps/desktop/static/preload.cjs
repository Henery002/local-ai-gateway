const { contextBridge, ipcRenderer } = require("electron");

const api = {
  getHealth: () => ipcRenderer.invoke("gateway:get-health"),
  getProviders: () => ipcRenderer.invoke("gateway:get-providers"),
  getProviderSettings: () => ipcRenderer.invoke("gateway:get-provider-settings"),
  saveProviderSettings: (payload) => ipcRenderer.invoke("gateway:save-provider-settings", payload),
  getSessions: () => ipcRenderer.invoke("gateway:get-sessions"),
  setActiveSession: (sessionId) => ipcRenderer.invoke("gateway:set-active-session", sessionId),
  refreshSessionUsage: (sessionId) => ipcRenderer.invoke("gateway:refresh-session-usage", sessionId),
  deleteCodexAccount: (sessionId) => ipcRenderer.invoke("gateway:delete-codex-account", sessionId),
  restartGateway: () => ipcRenderer.invoke("gateway:restart"),
  copyOpenClawSnippet: () => ipcRenderer.invoke("gateway:copy-openclaw-snippet"),
  openLogs: () => ipcRenderer.invoke("gateway:open-logs"),
  loginCodexOAuth: () => ipcRenderer.invoke("gateway:login-codex-oauth"),
  submitCodexOAuthInput: (input) => ipcRenderer.invoke("gateway:submit-codex-oauth-input", input),
  cancelCodexOAuth: () => ipcRenderer.invoke("gateway:cancel-codex-oauth"),
  importCodexJson: () => ipcRenderer.invoke("gateway:import-codex-json"),
  importAccountConfig: () => ipcRenderer.invoke("gateway:import-account-config"),
  importOpenClawSession: (sessionId) => ipcRenderer.invoke("gateway:import-openclaw-session", sessionId),
};

contextBridge.exposeInMainWorld("localAIGateway", api);
