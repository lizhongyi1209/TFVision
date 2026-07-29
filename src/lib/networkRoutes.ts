import type { RouteName } from "./types";

export const NETWORK_ROUTES: Record<RouteName, string> = {
  国内加速: "https://api.o1key.cn",
  国外加速: "https://cf-api.o1key.com",
};

export const DEFAULT_ROUTE: RouteName = "国内加速";

export function resolveBaseUrl(route: RouteName): string {
  return NETWORK_ROUTES[route] ?? NETWORK_ROUTES[DEFAULT_ROUTE];
}

export function isRouteName(value: unknown): value is RouteName {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(NETWORK_ROUTES, value);
}

export function normalizeRouteName(value: unknown): RouteName {
  return isRouteName(value) ? value : DEFAULT_ROUTE;
}
