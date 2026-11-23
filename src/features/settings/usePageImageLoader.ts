import { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderedDocumentPreviewPage } from '../../api/nativeBridge';
import { renderDocumentPreviewPage } from '../../api/nativeBridge';
import { LruCache } from '../../domain/pageSelection';
import { PageRenderScheduler } from './pageRenderScheduler';

export type PageImageStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface PageImageSnapshot {
  status: PageImageStatus;
  image?: RenderedDocumentPreviewPage;
  error?: string;
}

interface PageImageState {
  status: PageImageStatus;
  error?: string;
}

interface InFlightPage {
  promise: Promise<void>;
  cancelled: boolean;
  cancel: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads pages through a four-slot scheduler. Image bytes live in the LRU while
 * React state contains only small status records, so eviction can be recovered
 * by an idle snapshot without retaining every rendered page in React state.
 */
export function usePageImageLoader(
  pdfPath: string,
  maxEdge: number,
  capacity: number,
): {
  getSnapshot: (pageNumber: number) => PageImageSnapshot;
  loadPage: (pageNumber: number, force?: boolean) => Promise<void>;
  retryPage: (pageNumber: number) => Promise<void>;
  releasePage: (pageNumber: number) => void;
} {
  const cacheRef = useRef<LruCache<number, RenderedDocumentPreviewPage> | null>(null);
  if (cacheRef.current === null) {
    cacheRef.current = new LruCache<number, RenderedDocumentPreviewPage>(capacity);
  }
  const cache = cacheRef.current;
  const schedulerRef = useRef<PageRenderScheduler | null>(null);
  if (schedulerRef.current === null) schedulerRef.current = new PageRenderScheduler(4);
  const scheduler = schedulerRef.current;
  const inFlightRef = useRef(new Map<number, InFlightPage>());
  const generationRef = useRef(0);
  const activePathRef = useRef(pdfPath);
  const [state, setState] = useState<{
    path: string;
    pages: Map<number, PageImageState>;
  }>(() => ({ path: pdfPath, pages: new Map() }));

  // Invalidate synchronously when a different document is rendered. This also
  // prevents a late promise from the previous document from populating the UI.
  if (activePathRef.current !== pdfPath) {
    activePathRef.current = pdfPath;
    generationRef.current += 1;
    cache.clear();
    inFlightRef.current.clear();
    scheduler.cancelAll();
  }

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      scheduler.cancelAll();
      inFlightRef.current.clear();
      cache.clear();
    };
  }, [cache, scheduler]);

  const setPageState = useCallback((pageNumber: number, nextState: PageImageState) => {
    setState((previous) => {
      const pages = previous.path === activePathRef.current
        ? new Map(previous.pages)
        : new Map<number, PageImageState>();
      pages.set(pageNumber, nextState);
      return { path: activePathRef.current, pages };
    });
  }, []);

  const loadPage = useCallback(
    (pageNumber: number, force = false): Promise<void> => {
      if (!force) {
        const cachedImage = cache.get(pageNumber);
        if (cachedImage) {
          setPageState(pageNumber, { status: 'loaded' });
          return Promise.resolve();
        }
      }

      const existing = inFlightRef.current.get(pageNumber);
      if (existing && !existing.cancelled) return existing.promise;

      const requestPath = pdfPath;
      const generation = generationRef.current;
      setPageState(pageNumber, { status: 'loading' });

      const scheduled = scheduler.schedule(() =>
        renderDocumentPreviewPage(requestPath, pageNumber, maxEdge),
      );
      let request!: InFlightPage;
      const promise = scheduled.promise
        .then((image) => {
          if (!image || generation !== generationRef.current || activePathRef.current !== requestPath) {
            return;
          }
          // A running task may finish after its card unmounts. Publish the
          // result so a card remounted while it was running also leaves loading.
          cache.set(pageNumber, image);
          if (!request.cancelled) setPageState(pageNumber, { status: 'loaded' });
        })
        .catch((error: unknown) => {
          if (
            request.cancelled
            || generation !== generationRef.current
            || activePathRef.current !== requestPath
          ) {
            return;
          }
          setPageState(pageNumber, { status: 'error', error: getErrorMessage(error) });
        })
        .finally(() => {
          if (inFlightRef.current.get(pageNumber) === request) {
            inFlightRef.current.delete(pageNumber);
          }
        });

      request = {
        promise,
        cancelled: false,
        cancel: () => {
          const cancelledBeforeStart = scheduled.cancel();
          if (!cancelledBeforeStart) return;

          request.cancelled = true;
          if (generation === generationRef.current && activePathRef.current === requestPath) {
            // A queued request can be discarded completely. Resetting loading
            // is essential if the same card is mounted again immediately.
            setPageState(pageNumber, { status: 'idle' });
          }
        },
      };
      inFlightRef.current.set(pageNumber, request);
      return promise;
    },
    [cache, maxEdge, pdfPath, scheduler, setPageState],
  );

  const releasePage = useCallback((pageNumber: number): void => {
    const request = inFlightRef.current.get(pageNumber);
    request?.cancel();
  }, []);

  const retryPage = useCallback(
    (pageNumber: number) => loadPage(pageNumber, true),
    [loadPage],
  );

  const getSnapshot = useCallback(
    (pageNumber: number): PageImageSnapshot => {
      const image = cache.peek(pageNumber);
      if (image) return { status: 'loaded', image };

      const pageState = state.path === pdfPath ? state.pages.get(pageNumber) : undefined;
      if (pageState?.status === 'error') {
        return { status: 'error', error: pageState.error };
      }
      if (pageState?.status === 'loading') return { status: 'loading' };
      // A loaded status with no cache entry means the LRU evicted this page.
      // Consumers treat this as idle and request it again while still visible.
      return { status: 'idle' };
    },
    [cache, pdfPath, state],
  );

  return { getSnapshot, loadPage, retryPage, releasePage };
}
