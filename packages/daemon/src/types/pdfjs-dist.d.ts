declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export const GlobalWorkerOptions: { workerSrc?: string };
  export function getDocument(options: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getViewport(options: { scale: number }): { width: number; height: number };
        render(options: Record<string, unknown>): { promise: Promise<void> };
        cleanup?(): void;
      }>;
      destroy?(): Promise<void>;
    }>;
  };
}
