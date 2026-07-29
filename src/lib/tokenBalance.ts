const DEFAULT_QUOTA_PER_UNIT = 500_000;

type Dict = Record<string, unknown>;

export interface TokenBalanceInfo {
  unlimited: boolean;
  balance: number | null;
  rawQuota: number | null;
  used: number | null;
  granted: number | null;
  expiresAt: number | null;
}

function asDict(value: unknown): Dict | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Dict : null;
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTokenBalance(payload: unknown): TokenBalanceInfo | null {
  const root = asDict(payload);
  if (!root) return null;
  const data = asDict(root.data) ?? root;
  const unlimited = data.unlimited_quota === true;
  const availableUsd = finiteNumber(data.total_usd_available);
  const rawQuota = finiteNumber(data.total_available);
  const usedUsd = finiteNumber(data.total_usd_used);
  const rawUsed = finiteNumber(data.total_used);
  const grantedUsd = finiteNumber(data.total_usd_granted);
  const rawGranted = finiteNumber(data.total_granted);
  const userBalance = finiteNumber(data.user_balance);

  const balance = availableUsd
    ?? (rawQuota != null ? rawQuota / DEFAULT_QUOTA_PER_UNIT : null)
    ?? userBalance;
  if (!unlimited && balance == null) return null;

  return {
    unlimited,
    balance,
    rawQuota,
    used: usedUsd ?? (rawUsed != null ? rawUsed / DEFAULT_QUOTA_PER_UNIT : null),
    granted: grantedUsd ?? (rawGranted != null ? rawGranted / DEFAULT_QUOTA_PER_UNIT : null),
    expiresAt: finiteNumber(data.expires_at),
  };
}

export function formatTokenBalance(balance: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(balance);
}
