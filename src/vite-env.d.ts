/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the multiplayer server (see .env / .env.example). */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
