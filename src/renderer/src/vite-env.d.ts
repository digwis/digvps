/// <reference types="vite/client" />

import type { DigwisApi } from "../../shared/vps"

declare global {
  interface Window {
    digwis?: DigwisApi
  }
}

export {}
