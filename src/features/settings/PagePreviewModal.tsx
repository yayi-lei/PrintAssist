import { Button, Modal, Spin, Typography } from 'antd';
import { Check, ChevronLeft, ChevronRight, ImageOff, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { usePageImageLoader } from './usePageImageLoader';

export const LARGE_PREVIEW_MAX_EDGE = 1400;
export const LARGE_PREVIEW_CACHE_SIZE = 6;

export interface PagePreviewModalProps {
  pdfPath: string;
  pageCount: number;
  pageNumber: number;
  selected: boolean;
  onClose: () => void;
  onPageChange: (pageNumber: number) => void;
  onTogglePage: (pageNumber: number) => void;
}

export function PagePreviewModal({
  pdfPath,
  pageCount,
  pageNumber,
  selected,
  onClose,
  onPageChange,
  onTogglePage,
}: PagePreviewModalProps) {
  const [zoom, setZoom] = useState(100);
  const { getSnapshot, loadPage, retryPage, releasePage } = usePageImageLoader(
    pdfPath,
    LARGE_PREVIEW_MAX_EDGE,
    LARGE_PREVIEW_CACHE_SIZE,
  );
  const snapshot = getSnapshot(pageNumber);

  useEffect(() => {
    setZoom(100);
  }, [pageNumber]);

  useEffect(() => {
    void loadPage(pageNumber);
    return () => releasePage(pageNumber);
  }, [loadPage, pageNumber, releasePage]);

  useEffect(() => {
    if (snapshot.status === 'idle') void loadPage(pageNumber);
  }, [loadPage, pageNumber, snapshot.status]);

  const changeZoom = (delta: number) => {
    setZoom((current) => Math.max(50, Math.min(200, current + delta)));
  };

  return (
    <Modal
      className="page-preview-modal"
      title={`第 ${pageNumber} / ${pageCount} 页`}
      open
      onCancel={onClose}
      width={900}
      destroyOnClose
      footer={
        <div className="page-preview-modal-footer">
          <div className="page-preview-modal-footer-group">
            <Button
              icon={<ChevronLeft size={15} />}
              disabled={pageNumber <= 1}
              onClick={() => onPageChange(pageNumber - 1)}
            >
              上一页
            </Button>
            <Button
              icon={<ChevronRight size={15} />}
              disabled={pageNumber >= pageCount}
              onClick={() => onPageChange(pageNumber + 1)}
            >
              下一页
            </Button>
          </div>
          <div className="page-preview-modal-footer-group">
            <Button
              icon={<ZoomOut size={15} />}
              aria-label="缩小大图"
              disabled={zoom <= 50}
              onClick={() => changeZoom(-25)}
            />
            <span className="page-preview-zoom-label">{zoom}%</span>
            <Button
              icon={<ZoomIn size={15} />}
              aria-label="放大图片"
              disabled={zoom >= 200}
              onClick={() => changeZoom(25)}
            />
            <Button
              type={selected ? 'primary' : 'default'}
              icon={<Check size={15} />}
              onClick={() => onTogglePage(pageNumber)}
            >
              {selected ? '已选此页' : '选择此页'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="page-preview-modal-scroll">
        {snapshot.status === 'loaded' && snapshot.image ? (
          <img
            className="page-preview-modal-image"
            src={`data:image/png;base64,${snapshot.image.pngBase64}`}
            width={snapshot.image.width}
            height={snapshot.image.height}
            style={{ width: `${zoom}%` }}
            alt={`第 ${pageNumber} 页大图`}
            draggable={false}
          />
        ) : snapshot.status === 'error' ? (
          <div className="page-preview-modal-placeholder page-preview-modal-error">
            <ImageOff size={34} />
            <Typography.Text type="danger">大图加载失败</Typography.Text>
            {snapshot.error && (
              <Typography.Text type="secondary" className="page-preview-error-detail">
                {snapshot.error}
              </Typography.Text>
            )}
            <Button
              icon={<RotateCw size={14} />}
              onClick={() => void retryPage(pageNumber)}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="page-preview-modal-placeholder">
            <Spin />
            <Typography.Text type="secondary">正在加载第 {pageNumber} 页大图</Typography.Text>
          </div>
        )}
      </div>
    </Modal>
  );
}
