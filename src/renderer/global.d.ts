import type { GhostApi } from "../shared/api";

declare global {
  interface Window {
    ghost: GhostApi;
  }
}

export {};
