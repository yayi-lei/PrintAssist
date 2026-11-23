import { Button, Spin } from 'antd';
import { Check, CheckCheck, ImageOff, Maximize2, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { usePageImageLoader } from './usePageImageLoader';

export const THUMBNAIL_MAX_EDGE = 220;
export const THUMBNAIL_CACHE_SIZE = 80;
const GRID_ROW_HEIGHT = 224;
const GRID_GAP = 12;
const GRID_VIEWPORT_HEIGHT = 440;
const GRID_OVERSCAN_ROWS = 2;
const MIN_CARD_WIDTH = 126;

export interface PageThumbnailGridProps {
  pdfPath: string;
  pageCount: number;
  selectedPages: ReadonlySet<number>;
  onTogglePage: (pageNumber: number) => void;
  onPreviewPage: (pageNumber: number) => void;
}

interface ThumbnailCardProps {
  pdfPath: string;
  pageNumber: number;
  selected: boolean;
  style: CSSProperties;
  getSnapshot: ReturnType<typeof usePageImageLoader>['getSnapshot'];
  loadPage: ReturnType<typeof usePageImageLoader>['loadPage'];
  retryPage: ReturnType<typeof usePageImageLoader>['retryPage'];
  releasePage: ReturnType<typeof usePageImageLoader>['releasePage'];
  onTogglePage: (pageNumber: number) => void;
  onPreviewPage: (pageNumber: number) => void;
}

function ThumbnailCard({
  pageNumber,
  selected,
  style,
  getSnapshot,
  loadPage,
  retryPage,
  releasePage,
  onTogglePage,
  onPreviewPage,
}: ThumbnailCardProps) {
  const snapshot = getSnapshot(pageNumber);

  useEffect(() => {
    void loadPage(pageNumber);
    return () => releasePage(pageNumber);
  }, [loadPage, pageNumber, releasePage]);

  // An LRU eviction changes a visible card back to idle. Re-request it rather
  // than leaving the card permanently on its loading placeholder.
  useEffect(() => {
    if (snapshot.status === 'idle') void loadPage(pageNumber);
  }, [loadPage, pageNumber, snapshot.status]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onTogglePage(pageNumber);
  };

  return (
    <div
      className={`page-thumbnail-card${selected ? ' selected' : ''}`}
      style={style}
      role="checkbox"
      aria-checked={selected}
      aria-label={`第 ${pageNumber} 页${selected ? '，已选择' : '，未选择'}`}
      tabIndex={0}
      data-page-number={pageNumber}
      onClick={() => onTogglePage(pageNumber)}
      onKeyDown={handleKeyDown}
    >
      <div className="page-thumbnail-image-area">
        {snapshot.status === 'loaded' && snapshot.image ? (
          <img
            className="page-thumbnail-image"
            src={`data:image/png;base64,${snapshot.image.pngBase64}`}
            width={snapshot.image.width}
            height={snapshot.image.height}
            alt={`第 ${pageNumber} 页缩略图`}
            draggable={false}
          />
        ) : snapshot.status === 'error' ? (
          <div className="page-thumbnail-placeholder page-thumbnail-error">
            <ImageOff size={22} />
            <span>缩略图加载失败</span>
            <Button
              size="small"
              type="link"
              icon={<RotateCw size={12} />}
              onClick={(event) => {
                event.stopPropagation();
                void retryPage(pageNumber);
              }}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="page-thumbnail-placeholder" aria-label={`第 ${pageNumber} 页缩略图加载中`}>
            <Spin size="small" />
            <span>加载中</span>
          </div>
        )}
        {selected && (
          <span className="page-thumbnail-selected-badge" aria-hidden="true">
            <CheckCheck size={13} />
          </span>
        )}
        <Button
          className="page-thumbnail-zoom-button"
          size="small"
          type="text"
          icon={<Maximize2 size={14} />}
          aria-label={`放大第 ${pageNumber} 页`}
          title={`放大第 ${pageNumber} 页`}
          onClick={(event) => {
            event.stopPropagation();
            onPreviewPage(pageNumber);
          }}
        />
      </div>
      <div className="page-thumbnail-footer">
        <span>第 {pageNumber} 页</span>
        {selected && <Check size={13} aria-hidden="true" />}
      </div>
    </div>
  );
}

/** Fixed-row virtual grid: only the viewport plus two rows of overscan mount cards. */
export function PageThumbnailGrid({
  pdfPath,
  pageCount,
  selectedPages,
  onTogglePage,
  onPreviewPage,
}: PageThumbnailGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [columnCount, setColumnCount] = useState(4);
  const { getSnapshot, loadPage, retryPage, releasePage } = usePageImageLoader(
    pdfPath,
    THUMBNAIL_MAX_EDGE,
    THUMBNAIL_CACHE_SIZE,
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateColumns = () => {
      const width = viewport.clientWidth;
      if (width <= 0) return;
      const nextColumns = Math.max(
        2,
        Math.min(6, Math.floor((width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP))),
      );
      setColumnCount((current) => (current === nextColumns ? current : nextColumns));
    };

    updateColumns();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateColumns);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(pageCount / columnCount);
  const firstRow = Math.max(0, Math.floor(scrollTop / GRID_ROW_HEIGHT) - GRID_OVERSCAN_ROWS);
  const lastRow = Math.min(
    Math.max(0, rowCount - 1),
    Math.ceil((scrollTop + GRID_VIEWPORT_HEIGHT) / GRID_ROW_HEIGHT) + GRID_OVERSCAN_ROWS - 1,
  );
  const firstIndex = firstRow * columnCount;
  const lastIndex = Math.min(pageCount, (lastRow + 1) * columnCount);
  const visiblePages = useMemo(
    () => Array.from({ length: Math.max(0, lastIndex - firstIndex) }, (_, index) => firstIndex + index + 1),
    [firstIndex, lastIndex],
  );

  const cardWidth = `calc(${100 / columnCount}% - ${(GRID_GAP * (columnCount - 1)) / columnCount}px)`;

  return (
    <div
      ref={viewportRef}
      className="page-thumbnail-viewport"
      style={{ height: GRID_VIEWPORT_HEIGHT }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      aria-label="页面缩略图，滚动加载"
    >
      <div
        className="page-thumbnail-spacer"
        style={{ height: Math.max(0, rowCount * GRID_ROW_HEIGHT - GRID_GAP) }}
      >
        {visiblePages.map((pageNumber) => {
          const index = pageNumber - 1;
          const row = Math.floor(index / columnCount);
          const column = index % columnCount;
          const left = `calc(${(column * 100) / columnCount}% + ${(column * GRID_GAP) / columnCount}px)`;
          const style: CSSProperties = {
            position: 'absolute',
            top: row * GRID_ROW_HEIGHT,
            left,
            width: cardWidth,
            height: GRID_ROW_HEIGHT - GRID_GAP,
          };
          return (
            <ThumbnailCard
              key={`${pdfPath}:${pageNumber}`}
              pdfPath={pdfPath}
              pageNumber={pageNumber}
              selected={selectedPages.has(pageNumber)}
              style={style}
              getSnapshot={getSnapshot}
              loadPage={loadPage}
              retryPage={retryPage}
              releasePage={releasePage}
              onTogglePage={onTogglePage}
              onPreviewPage={onPreviewPage}
            />
          );
        })}
      </div>
    </div>
  );
}
