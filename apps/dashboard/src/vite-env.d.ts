/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL base de la API. En desarrollo se usa el proxy "/api" de Vite. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
