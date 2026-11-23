import {
  Alert,
  Button,
  Drawer,
  Input,
  InputNumber,
  Progress,
  Radio,
  Segmented,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  BookOpen,
  Check,
  CheckCheck,
  FileText,
  Printer,
  RotateCw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prepareDocumentPreview } from '../../api/nativeBridge';
import type { QueueItem } from '../../domain/queueTypes';
import { formatPageNumbersToRanges, invertPageSelection } from '../../domain/pageSelection';
import { parsePageRangeExpression } from '../../domain/pageRange';
import type {
  ColorMode,
  FileSettingsOverride,
  FlipMode,
  PrintSettings,
  SidesMode,
} from '../../domain/printSettings';
import { mergePrintSettings, resolveDuplexAvailability } from '../../domain/printSettings';
import { PagePreviewModal } from './PagePreviewModal';
import { PageThumbnailGrid } from './PageThumbnailGrid';

export { formatPageNumbersToRanges } from '../../domain/pageSelection';

export interface FileSettingsDrawerProps {
  open: boolean;
  item: QueueItem | null;
  globalSettings: PrintSettings;
  colorEnabled: boolean;
  duplexEnabled: boolean;
  onClose: () => void;
  onSave: (override: FileSettingsOverride) => void;
  onPrint?: (override: FileSettingsOverride) => void;
}

type PreviewableKind = 'pdf' | 'word' | 'excel' | 'powerpoint';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading'; itemId: string; kind: PreviewableKind }
  | { status: 'ready'; itemId: string; pdfPath: string; pageCount: number }
  | { status: 'error'; itemId: string; message: string };

function isPreviewableKind(kind: QueueItem['kind'] | undefined): kind is PreviewableKind {
  return kind === 'pdf' || kind === 'word' || kind === 'excel' || kind === 'powerpoint';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function FileSettingsDrawer({
  open,
  item,
  globalSettings,
  colorEnabled,
  duplexEnabled,
  onClose,
  onSave,
  onPrint,
}: FileSettingsDrawerProps) {
  const [useCustomColor, setUseCustomColor] = useState(false);
  const [useCustomSides, setUseCustomSides] = useState(false);
  const [useCustomCopies, setUseCustomCopies] = useState(false);
  const [useCustomPages, setUseCustomPages] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>('monochrome');
  const [sidesMode, setSidesMode] = useState<SidesMode>('simplex');
  const [flipMode, setFlipMode] = useState<FlipMode>('longEdge');
  const [copies, setCopies] = useState(1);
  const [pageExpression, setPageExpression] = useState('');
  const [rangeQuickMode, setRangeQuickMode] = useState<'all' | 'odd' | 'even' | 'custom'>('all');
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'idle' });
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const previewGenerationRef = useRef(0);

  const preparedPreview =
    previewState.status === 'ready' && previewState.itemId === item?.id ? previewState : null;
  const itemPageCount = item?.pageCount && item.pageCount > 0 ? item.pageCount : null;
  const isPageCountKnown = preparedPreview !== null || itemPageCount !== null;
  const actualPages = preparedPreview?.pageCount ?? itemPageCount ?? 1;

  // 双面可用性 = 打印机能力 且 文件类型能真正下发双面（文本文件走关联程序，不能）
  const duplexAvailability = resolveDuplexAvailability({
    printerDuplexEnabled: duplexEnabled,
    kind: item?.kind,
  });

  // 只以 open + 文件 id 初始化，避免队列更新造成 item 引用变化时覆盖用户选择。
  useEffect(() => {
    if (!open || !item) return;

    const merged = mergePrintSettings(globalSettings, item.override);
    setUseCustomColor(item.override.colorMode !== undefined);
    setUseCustomSides(
      item.override.sidesMode !== undefined || item.override.flipMode !== undefined,
    );
    setUseCustomCopies(item.override.copies !== undefined);
    setUseCustomPages(item.override.pageRange !== undefined);
    setColorMode(merged.colorMode);
    setSidesMode(duplexAvailability.enabled ? merged.sidesMode : 'simplex');
    setFlipMode(merged.flipMode);
    setCopies(merged.copies);

    const hasCustomRange = item.override.pageRange?.mode === 'custom';
    if (hasCustomRange) {
      setPageExpression(item.override.pageRange?.expression || '');
      setRangeQuickMode('custom');
    } else {
      if (item.pageCount && item.pageCount > 1) {
        setPageExpression(`1-${item.pageCount}`);
      } else {
        setPageExpression('1');
      }
      setRangeQuickMode('all');
    }
    // 此 effect 的输入刻意只包含 open 和 id；其它值取本次打开时的快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  // prepare 成功后以真实 PDF 页数校验；全部页表达式同步到新的总页数。
  useEffect(() => {
    if (!open || !item || useCustomPages || !isPageCountKnown) return;
    setPageExpression(actualPages > 1 ? `1-${actualPages}` : '1');
  }, [actualPages, isPageCountKnown, item, open, useCustomPages]);

  useEffect(() => {
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;

    if (!open || !item || !isPreviewableKind(item.kind)) {
      setPreviewState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    const itemId = item.id;
    const kind = item.kind;
    setPreviewPage(null);
    setPreviewState({ status: 'loading', itemId, kind });

    void prepareDocumentPreview(item.path)
      .then((result) => {
        if (cancelled || generation !== previewGenerationRef.current) return;
        if (!Number.isInteger(result.pageCount) || result.pageCount < 1) {
          throw new Error('预览返回的页数无效');
        }
        setPreviewState({
          status: 'ready',
          itemId,
          pdfPath: result.pdfPath,
          pageCount: result.pageCount,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== previewGenerationRef.current) return;
        setPreviewState({ status: 'error', itemId, message: getErrorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
    // item.path 与 kind 在 id 不变时视为同一文档；重试由 previewAttempt 触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, previewAttempt]);

  const selectionState = useMemo(() => {
    if (!useCustomPages) {
      return {
        pages: isPageCountKnown
          ? Array.from({ length: actualPages }, (_, index) => index + 1)
          : [],
        error: null as string | null,
        empty: false,
      };
    }

    // 清空是明确的空选择，而不是语法错误；保存时仍沿用原解析器的严格校验。
    if (!pageExpression.trim()) {
      return { pages: [] as number[], error: null as string | null, empty: true };
    }

    const parsed = parsePageRangeExpression(
      pageExpression,
      isPageCountKnown ? actualPages : undefined,
    );
    if (!parsed.ok) {
      return { pages: [] as number[], error: parsed.message, empty: false };
    }
    return { pages: parsed.pages, error: null as string | null, empty: parsed.pages.length === 0 };
  }, [actualPages, isPageCountKnown, pageExpression, useCustomPages]);

  const selectedPagesList = selectionState.pages;
  const selectedPageSet = useMemo(() => new Set(selectedPagesList), [selectedPagesList]);
  const hasInvalidExpression = useCustomPages && selectionState.error !== null;
  const isEmptySelection = useCustomPages && selectionState.empty;

  const updateSelection = useCallback((pages: number[]) => {
    setUseCustomPages(true);
    setRangeQuickMode('custom');
    setPageExpression(formatPageNumbersToRanges(pages));
  }, []);

  const handleTogglePage = useCallback(
    (pageNumber: number) => {
      const nextPages = new Set(selectedPageSet);
      if (nextPages.has(pageNumber)) {
        nextPages.delete(pageNumber);
      } else {
        nextPages.add(pageNumber);
      }
      updateSelection(Array.from(nextPages));
    },
    [selectedPageSet, updateSelection],
  );

  const handleQuickModeChange = (value: 'all' | 'odd' | 'even' | 'custom') => {
    if ((value === 'odd' || value === 'even') && !isPageCountKnown) return;
    setRangeQuickMode(value);
    if (value === 'all') {
      setUseCustomPages(false);
      setPageExpression(actualPages > 1 ? `1-${actualPages}` : '1');
    } else if (value === 'odd') {
      updateSelection(
        Array.from({ length: actualPages }, (_, index) => index + 1).filter((page) => page % 2 === 1),
      );
      setRangeQuickMode('odd');
    } else if (value === 'even') {
      updateSelection(
        Array.from({ length: actualPages }, (_, index) => index + 1).filter((page) => page % 2 === 0),
      );
      setRangeQuickMode('even');
    } else {
      setUseCustomPages(true);
    }
  };

  const handleCustomPagesToggle = (checked: boolean) => {
    setUseCustomPages(checked);
    if (checked) {
      setRangeQuickMode('custom');
    } else {
      setRangeQuickMode('all');
      setPageExpression(actualPages > 1 ? `1-${actualPages}` : '1');
    }
  };

  const handleInvertSelection = () => {
    if (!isPageCountKnown || hasInvalidExpression) return;
    updateSelection(invertPageSelection(selectedPagesList, actualPages));
  };

  const buildOverride = (): FileSettingsOverride | null => {
    if (!item) return null;

    const nextOverride: FileSettingsOverride = {};
    if (useCustomColor) nextOverride.colorMode = colorMode;
    if (useCustomSides) {
      nextOverride.sidesMode = sidesMode;
      nextOverride.flipMode = flipMode;
    }
    if (useCustomCopies) nextOverride.copies = copies;
    if (useCustomPages) {
      const parseResult = parsePageRangeExpression(
        pageExpression,
        isPageCountKnown ? actualPages : undefined,
      );
      if (!parseResult.ok) {
        message.error(parseResult.message);
        return null;
      }
      nextOverride.pageRange = {
        mode: 'custom',
        expression: pageExpression.trim(),
      };
    }
    return nextOverride;
  };

  const handleSave = () => {
    const nextOverride = buildOverride();
    if (!nextOverride) return;
    onSave(nextOverride);
    onClose();
  };

  const handlePrint = () => {
    if (!onPrint || hasInvalidExpression || isEmptySelection) return;
    const nextOverride = buildOverride();
    if (nextOverride) onPrint(nextOverride);
  };

  const handleDrawerClose = useCallback(() => {
    previewGenerationRef.current += 1;
    setPreviewPage(null);
    onClose();
  }, [onClose]);

  const printDisabled = !onPrint || !item || hasInvalidExpression || isEmptySelection;
  const previewable = isPreviewableKind(item?.kind);

  return (
    <>
      <Drawer
        title="单文件高级设置"
        open={open}
        onClose={handleDrawerClose}
        width={860}
        destroyOnClose
        className="file-settings-drawer"
        extra={
          <Space wrap>
            <Button onClick={handleDrawerClose}>取消</Button>
            <Button
              icon={<Printer size={14} />}
              disabled={printDisabled}
              onClick={handlePrint}
            >
              打印选中页
            </Button>
            <Button type="primary" icon={<Check size={14} />} onClick={handleSave}>
              保存设置
            </Button>
          </Space>
        }
      >
        {item && (
          <div className="drawer-file-meta-card">
            <div className="drawer-file-header">
              <FileText size={18} className="drawer-file-icon" />
              <div className="drawer-file-info">
                <Tooltip title={item.fileName} placement="bottomLeft">
                  <Typography.Text strong className="drawer-file-name">
                    {item.fileName}
                  </Typography.Text>
                </Tooltip>
                <div className="drawer-file-path" title={item.path}>
                  {item.path}
                </div>
              </div>
            </div>
            <div className="drawer-meta-badges">
              <Tag color="blue">{item.kind.toUpperCase()}</Tag>
              <Tag color="cyan">
                {isPageCountKnown ? `共 ${actualPages} 页` : '页数自动探测/未指定'}
              </Tag>
            </div>
          </div>
        )}

        <Typography.Paragraph type="secondary" className="drawer-help-text">
          开启开关可单独覆盖公共参数，未开启项将自动继承公共默认值。
        </Typography.Paragraph>

        <div className="drawer-section-box">
          <div className="drawer-field-head">
            <div className="field-title-group">
              <BookOpen size={15} />
              <Typography.Text strong>页码范围选择</Typography.Text>
            </div>
            <Switch checked={useCustomPages} onChange={handleCustomPagesToggle} />
          </div>

          <div className="page-mode-row">
            <Segmented
              size="small"
              value={useCustomPages ? rangeQuickMode : 'all'}
              onChange={(value) => handleQuickModeChange(value as 'all' | 'odd' | 'even' | 'custom')}
              options={[
                { label: '全部页', value: 'all' },
                { label: '仅奇数页', value: 'odd', disabled: !isPageCountKnown },
                { label: '仅偶数页', value: 'even', disabled: !isPageCountKnown },
                { label: '自定义', value: 'custom' },
              ]}
            />
          </div>

          <Space size={6} wrap className="page-selection-actions">
            <Button size="small" onClick={() => handleQuickModeChange('all')}>
              全部
            </Button>
            <Button size="small" onClick={() => updateSelection([])}>
              清空
            </Button>
            <Button
              size="small"
              disabled={!isPageCountKnown || hasInvalidExpression}
              onClick={handleInvertSelection}
            >
              反选
            </Button>
          </Space>

          <div className="page-range-input-wrap">
            <Input
              disabled={!useCustomPages}
              value={pageExpression}
              placeholder={isPageCountKnown ? `例如 1, 3, 5-${actualPages}` : '例如 1, 3, 5-8'}
              onChange={(event) => {
                setUseCustomPages(true);
                setPageExpression(event.target.value);
                setRangeQuickMode('custom');
              }}
            />
            {isPageCountKnown && (
              <div className="range-summary-text">
                已选 {selectedPagesList.length} / 共 {actualPages} 页
              </div>
            )}
          </div>

          {hasInvalidExpression && (
            <Alert type="error" showIcon message={selectionState.error} />
          )}
          {isEmptySelection && (
            <Alert
              type="warning"
              showIcon
              message="当前未选择任何页面，请至少选择一页后再打印。"
            />
          )}

          {previewable ? (
            preparedPreview ? (
              <div className="visual-page-grid-container">
                <div className="grid-label">
                  真实页面预览 · 物理页码 · 点击卡片勾选，独立按钮放大
                </div>
                <PageThumbnailGrid
                  pdfPath={preparedPreview.pdfPath}
                  pageCount={preparedPreview.pageCount}
                  selectedPages={selectedPageSet}
                  onTogglePage={handleTogglePage}
                  onPreviewPage={setPreviewPage}
                />
              </div>
            ) : previewState.status === 'error' ? (
              <Alert
                type="error"
                showIcon
                message="页面预览准备失败"
                description={`${previewState.message}。仍可使用上方页码表达式保存或打印。`}
                action={
                  <Button
                    size="small"
                    icon={<RotateCw size={13} />}
                    onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
                  >
                    重试预览
                  </Button>
                }
              />
            ) : (
              <div className="preview-prepare-panel" aria-live="polite">
                <div className="preview-prepare-heading">
                  <Spin size="small" />
                  <Typography.Text strong>
                    {item?.kind === 'pdf' ? '正在准备页面预览' : '正在转换预览 PDF'}
                  </Typography.Text>
                </div>
                <Typography.Text type="secondary" className="preview-prepare-hint">
                  正在等待预览服务返回页数，缩略图会在准备完成后逐页加载。
                </Typography.Text>
                <Progress
                  percent={100}
                  status="active"
                  showInfo={false}
                  aria-label="预览准备进度（不确定）"
                />
                <Button size="small" onClick={handleDrawerClose}>
                  取消并关闭
                </Button>
              </div>
            )
          ) : isPageCountKnown ? (
            <div className="visual-page-grid-container">
              <div className="grid-label">
                实际页数 ({actualPages} 页) · 点击方块直观勾选/取消：
              </div>
              <div className="visual-page-grid">
                {Array.from({ length: Math.min(actualPages, 60) }, (_, index) => index + 1).map((page) => {
                  const isSelected = selectedPageSet.has(page);
                  return (
                    <div
                      key={page}
                      className={`page-grid-block ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleTogglePage(page)}
                      title={`点击切换第 ${page} 页`}
                    >
                      {isSelected && <CheckCheck size={11} className="check-icon" />}
                      <span className="page-num">{page}</span>
                    </div>
                  );
                })}
              </div>
              {actualPages > 60 && (
                <div className="legacy-page-grid-hint">
                  页面较多，前 60 页已展示在网格中，超出部分可通过上方输入框指定。
                </div>
              )}
            </div>
          ) : (
            <div className="legacy-page-range-hint">
              提示：当前文件类型未直接探测到物理总页数，您可在上方输入框直接填写需打印的页码区间（如 <code>1-5</code> 或 <code>1,3,5</code>）。
            </div>
          )}
        </div>

        <div className="drawer-section-box">
          <div className="drawer-field-head">
            <div className="field-title-group">
              <Typography.Text strong>色彩模式</Typography.Text>
            </div>
            <Switch checked={useCustomColor} onChange={setUseCustomColor} />
          </div>
          <Radio.Group
            disabled={!useCustomColor}
            value={colorMode}
            onChange={(event) => setColorMode(event.target.value)}
          >
            <Radio value="monochrome">黑白</Radio>
            <Radio value="color" disabled={!colorEnabled}>
              彩色 {!colorEnabled && '(打印机不支持)'}
            </Radio>
          </Radio.Group>
        </div>

        <div className="drawer-section-box">
          <div className="drawer-field-head">
            <div className="field-title-group">
              <Typography.Text strong>单双面与装订</Typography.Text>
            </div>
            <Switch checked={useCustomSides} onChange={setUseCustomSides} />
          </div>
          <Radio.Group
            disabled={!useCustomSides}
            value={sidesMode}
            onChange={(event) => setSidesMode(event.target.value)}
          >
            <Radio value="simplex">单面打印</Radio>
            <Radio value="duplex" disabled={!duplexAvailability.enabled}>
              双面打印{' '}
              {!duplexAvailability.enabled && `（${duplexAvailability.reason ?? '不可用'}）`}
            </Radio>
          </Radio.Group>
          {!duplexAvailability.enabled && (
            <div style={{ marginTop: 6 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                该文件将按单面打印，界面与纸张统计均按单面计算。
              </Typography.Text>
            </div>
          )}

          {sidesMode === 'duplex' && (
            <div style={{ marginTop: 8, paddingLeft: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
                装订翻转：
              </Typography.Text>
              <Radio.Group
                size="small"
                disabled={!useCustomSides}
                value={flipMode}
                onChange={(event) => setFlipMode(event.target.value)}
              >
                <Radio value="longEdge">长边翻转</Radio>
                <Radio value="shortEdge">短边翻转</Radio>
              </Radio.Group>
            </div>
          )}
        </div>

        <div className="drawer-section-box">
          <div className="drawer-field-head">
            <div className="field-title-group">
              <Typography.Text strong>打印份数</Typography.Text>
            </div>
            <Switch checked={useCustomCopies} onChange={setUseCustomCopies} />
          </div>
          <InputNumber
            min={1}
            max={99}
            value={copies}
            disabled={!useCustomCopies}
            onChange={(value) => setCopies(value || 1)}
            addonAfter="份"
          />
        </div>
      </Drawer>

      {preparedPreview && previewPage !== null && (
        <PagePreviewModal
          pdfPath={preparedPreview.pdfPath}
          pageCount={preparedPreview.pageCount}
          pageNumber={previewPage}
          selected={selectedPageSet.has(previewPage)}
          onClose={() => setPreviewPage(null)}
          onPageChange={setPreviewPage}
          onTogglePage={handleTogglePage}
        />
      )}
    </>
  );
}
