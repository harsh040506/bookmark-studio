import { useSyncExternalStore } from "react";

import { getRuntime, subscribeRuntime, type RuntimeState } from "@/lib/runtime";

/** Which backend is answering network questions right now (see `lib/runtime.ts`). Live. */
export function useRuntime(): RuntimeState {
  return useSyncExternalStore(subscribeRuntime, getRuntime, getRuntime);
}
