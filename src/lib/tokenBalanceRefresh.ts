export const TOKEN_BALANCE_REFRESH_EVENT = "tfvision:token-balance-refresh";

export function settingsPatchUpdatesToken(patch: { apiKey?: string }): boolean {
  return typeof patch.apiKey === "string" && patch.apiKey.trim().length > 0;
}

/** Notify the top bar that the displayed token balance may have changed. */
export function requestTokenBalanceRefresh() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TOKEN_BALANCE_REFRESH_EVENT));
}
