/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CE_NODE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
