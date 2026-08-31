import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';

// Narrow local types keep the renderer independent from PDF.js's broad DOM
// declarations while the runtime itself is bundled locally by Vite.
export interface PDFDocumentProxy {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PDFPageProxy>;
  destroy: () => Promise<void>;
}

export interface PDFPageProxy {
  getViewport: (params: { scale: number; rotation?: number }) => PDFPageViewport;
  render: (params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PDFPageViewport;
  }) => RenderTask;
  destroy: () => Promise<void>;
}

export interface PDFPageViewport {
  width: number;
  height: number;
  scale: number;
  rotation: number;
}

export interface RenderTask {
  promise: Promise<void>;
  cancel: () => void;
}

export interface PDFLoadingTask {
  promise: Promise<PDFDocumentProxy>;
  destroy?: () => Promise<void> | void;
  cancel?: () => void;
}

export interface PDFJS {
  getDocument: (params: { url?: string; data?: Uint8Array }) => PDFLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
}

let pdfjsPromise: Promise<PDFJS> | null = null;

/** Load the application-local PDF.js bundle and application-local Vite worker. */
export async function getPDFJS(): Promise<PDFJS> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist')
      .then((module) => {
        const pdfjs = module as unknown as PDFJS;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        return pdfjs;
      })
      .catch((error) => {
        pdfjsPromise = null;
        throw new Error(
          `PDF.js failed to load: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }
  return pdfjsPromise;
}
