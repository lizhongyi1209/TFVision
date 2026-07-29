import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokenBalance, parseTokenBalance } from "../tokenBalance.ts";
import { settingsPatchUpdatesToken } from "../tokenBalanceRefresh.ts";

test("令牌余额将 New API quota 换算为展示单位", () => {
  assert.deepEqual(parseTokenBalance({
    code: true,
    data: {
      total_granted: 5_000_000,
      total_used: 2_250_000,
      total_available: 2_750_000,
      unlimited_quota: false,
      expires_at: 0,
    },
  }), {
    unlimited: false,
    balance: 5.5,
    rawQuota: 2_750_000,
    used: 4.5,
    granted: 10,
    expiresAt: 0,
  });
  assert.equal(formatTokenBalance(5.5), "5.50");
});

test("令牌余额兼容美元字段和无限额度", () => {
  assert.equal(parseTokenBalance({ data: { total_usd_available: 8.25 } })?.balance, 8.25);
  assert.deepEqual(parseTokenBalance({ data: { unlimited_quota: true } }), {
    unlimited: true,
    balance: null,
    rawQuota: null,
    used: null,
    granted: null,
    expiresAt: null,
  });
});

test("首次填写或更新令牌时需要刷新余额", () => {
  assert.equal(settingsPatchUpdatesToken({ apiKey: "new-token" }), true);
  assert.equal(settingsPatchUpdatesToken({ apiKey: "   " }), false);
  assert.equal(settingsPatchUpdatesToken({}), false);
});
