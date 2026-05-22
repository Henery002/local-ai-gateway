import { contextBridge, ipcRenderer } from "electron";

const api = {
  getHealth: () => ipcRenderer.invoke("gateway:get-health"),
  getProviders: () => ipcRenderer.invoke("gateway:get-providers"),
  getUsageSummary: (clientFilter?: string) =>
    ipcRenderer.invoke("gateway:get-usage-summary", clientFilter),
  getAccessAlerts: () => ipcRenderer.invoke("gateway:get-access-alerts"),
  acknowledgeAccessAlert: (id: number) =>
    ipcRenderer.invoke("gateway:acknowledge-access-alert", id),
  acknowledgeAllAccessAlerts: () =>
    ipcRenderer.invoke("gateway:acknowledge-all-access-alerts"),
  clearAcknowledgedAccessAlerts: () =>
    ipcRenderer.invoke("gateway:clear-acknowledged-access-alerts"),
  showNativeNotification: (payload: { title: string; body?: string }) =>
    ipcRenderer.invoke("gateway:show-native-notification", payload),
  getProviderSettings: () => ipcRenderer.invoke("gateway:get-provider-settings"),
  saveProviderSettings: (payload: unknown) =>
    ipcRenderer.invoke("gateway:save-provider-settings", payload),
  getRoutingSettings: () => ipcRenderer.invoke("gateway:get-routing-settings"),
  saveRoutingSettings: (payload: unknown) =>
    ipcRenderer.invoke("gateway:save-routing-settings", payload),
  previewRouting: (payload: unknown) =>
    ipcRenderer.invoke("gateway:preview-routing", payload),
  getPoolSettings: () => ipcRenderer.invoke("gateway:get-pool-settings"),
  savePoolSettings: (payload: unknown) =>
    ipcRenderer.invoke("gateway:save-pool-settings", payload),
  getSecuritySettings: () => ipcRenderer.invoke("gateway:get-security-settings"),
  saveSecuritySettings: (payload: unknown) =>
    ipcRenderer.invoke("gateway:save-security-settings", payload),
  getSystemSettings: () => ipcRenderer.invoke("gateway:get-system-settings"),
  saveSystemSettings: (payload: unknown) =>
    ipcRenderer.invoke("gateway:save-system-settings", payload),
  getAppDataStatus: () => ipcRenderer.invoke("gateway:get-app-data-status"),
  exportAppData: () => ipcRenderer.invoke("gateway:export-app-data"),
  previewImportAppData: () => ipcRenderer.invoke("gateway:preview-import-app-data"),
  importAppData: (selectedPath?: string) =>
    ipcRenderer.invoke("gateway:import-app-data", selectedPath),
  openBackupsFolder: () => ipcRenderer.invoke("gateway:open-backups-folder"),
  getSessions: () => ipcRenderer.invoke("gateway:get-sessions"),
  setActiveSession: (sessionId: string) =>
    ipcRenderer.invoke("gateway:set-active-session", sessionId),
  refreshSessionUsage: (sessionId?: string) =>
    ipcRenderer.invoke("gateway:refresh-session-usage", sessionId),
  resetTelemetry: () => ipcRenderer.invoke("gateway:reset-telemetry"),
  deleteCodexAccount: (sessionId: string) =>
    ipcRenderer.invoke("gateway:delete-codex-account", sessionId),
  restartGateway: () => ipcRenderer.invoke("gateway:restart"),
  copyOpenClawSnippet: () => ipcRenderer.invoke("gateway:copy-openclaw-snippet"),
  copyText: (text: string) => ipcRenderer.invoke("gateway:copy-text", text),
  openLogs: () => ipcRenderer.invoke("gateway:open-logs"),
  getOperationsStatus: () => ipcRenderer.invoke("gateway:get-operations-status"),
  readOperationsLog: (sourceId: string, maxLines?: number) =>
    ipcRenderer.invoke("gateway:read-operations-log", sourceId, maxLines),
  controlGatewayService: (action: string) =>
    ipcRenderer.invoke("gateway:control-gateway-service", action),
  controlCloudflareService: (action: string) =>
    ipcRenderer.invoke("gateway:control-cloudflare-service", action),
  loginCodexOAuth: () => ipcRenderer.invoke("gateway:login-codex-oauth"),
  submitCodexOAuthInput: (input: string) =>
    ipcRenderer.invoke("gateway:submit-codex-oauth-input", input),
  cancelCodexOAuth: () => ipcRenderer.invoke("gateway:cancel-codex-oauth"),
  importCodexJson: () => ipcRenderer.invoke("gateway:import-codex-json"),
  importAccountConfig: () => ipcRenderer.invoke("gateway:import-account-config"),
  importOpenClawSession: (sessionId: string) =>
    ipcRenderer.invoke("gateway:import-openclaw-session", sessionId),
};

contextBridge.exposeInMainWorld("localAIGateway", api);
