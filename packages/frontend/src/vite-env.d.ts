/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NORMALDOCS_API_ORIGIN?: string;
  readonly VITE_NORMALDOCS_COMMENTS_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
