//! Low-resolution document previews, isolated from the high-quality print path.

use super::{detect_document_kind, office::convert_office_to_pdf, DocumentKind};
use serde::Serialize;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};

const DEFAULT_PREVIEW_MAX_EDGE: u32 = 240;
const MIN_PREVIEW_MAX_EDGE: u32 = 64;
const MAX_PREVIEW_MAX_EDGE: u32 = 2048;
const PREVIEW_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDocumentPreview {
    pub pdf_path: String,
    pub page_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedPreviewPage {
    pub page_number: u32,
    pub width: u32,
    pub height: u32,
    pub png_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SourceFingerprint {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

struct CachedOfficePreview {
    fingerprint: SourceFingerprint,
    prepared: PreparedDocumentPreview,
}

static OFFICE_PREVIEW_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedOfficePreview>>> =
    OnceLock::new();

fn office_preview_cache() -> &'static Mutex<HashMap<PathBuf, CachedOfficePreview>> {
    OFFICE_PREVIEW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn prepare_document_preview(path: String) -> Result<PreparedDocumentPreview, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_document_preview_blocking(path))
        .await
        .map_err(|error| format!("准备文档预览任务失败: {error}"))?
}

fn prepare_document_preview_blocking(path: String) -> Result<PreparedDocumentPreview, String> {
    let source_path = PathBuf::from(path);
    let kind = detect_document_kind(&source_path);

    match kind {
        DocumentKind::Pdf => {
            let page_count = pdf_page_count(&source_path)?;
            Ok(PreparedDocumentPreview {
                pdf_path: source_path.to_string_lossy().into_owned(),
                page_count,
            })
        }
        DocumentKind::Word | DocumentKind::Excel | DocumentKind::PowerPoint => {
            prepare_office_preview(source_path, kind)
        }
        DocumentKind::Image | DocumentKind::Text | DocumentKind::Unknown => Err(format!(
            "不支持预览此文件格式: {}",
            source_path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("无扩展名")
        )),
    }
}

fn prepare_office_preview(
    source_path: PathBuf,
    kind: DocumentKind,
) -> Result<PreparedDocumentPreview, String> {
    cleanup_stale_preview_files();
    let source_path = fs::canonicalize(&source_path)
        .map_err(|error| format!("无法解析 Office 源文件路径: {error}"))?;
    let fingerprint = source_fingerprint(&source_path)?;
    let mut cache = office_preview_cache()
        .lock()
        .map_err(|_| "Office 预览缓存锁已失效".to_string())?;

    if let Some(cached) = cache.get(&fingerprint.path) {
        if cached.fingerprint == fingerprint
            && Path::new(&cached.prepared.pdf_path).is_file()
            && cached.prepared.page_count > 0
        {
            return Ok(cached.prepared.clone());
        }
    }

    // Keep the lock through conversion so concurrent requests cannot export the
    // same Office document or compete for the Office COM automation pipeline.
    let generated_pdf = convert_office_to_pdf(&fingerprint.path, kind)?;
    let cache_path = preview_cache_path(&fingerprint);
    move_to_preview_cache(&generated_pdf, &cache_path)?;
    let page_count = match pdf_page_count(&cache_path) {
        Ok(page_count) => page_count,
        Err(error) => {
            let _ = fs::remove_file(&cache_path);
            return Err(error);
        }
    };
    let prepared = PreparedDocumentPreview {
        pdf_path: cache_path.to_string_lossy().into_owned(),
        page_count,
    };

    if let Some(previous) = cache.insert(
        fingerprint.path.clone(),
        CachedOfficePreview {
            fingerprint,
            prepared: prepared.clone(),
        },
    ) {
        if previous.prepared.pdf_path != prepared.pdf_path {
            let _ = fs::remove_file(previous.prepared.pdf_path);
        }
    }
    Ok(prepared)
}

fn cleanup_stale_preview_files() {
    let directory = std::env::temp_dir().join("printassist-document-preview-v1");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let now = SystemTime::now();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("pdf") {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|metadata| metadata.modified()) else {
            continue;
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age > PREVIEW_CACHE_TTL)
        {
            let _ = fs::remove_file(path);
        }
    }
}

fn source_fingerprint(path: &Path) -> Result<SourceFingerprint, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取源文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err("预览源路径不是文件".to_string());
    }
    let modified = metadata
        .modified()
        .map_err(|error| format!("无法读取源文件修改时间: {error}"))?;

    Ok(SourceFingerprint {
        path: path.to_path_buf(),
        size: metadata.len(),
        modified,
    })
}

fn preview_cache_path(fingerprint: &SourceFingerprint) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    std::process::id().hash(&mut hasher);
    fingerprint.hash(&mut hasher);
    std::env::temp_dir()
        .join("printassist-document-preview-v1")
        .join(format!("{:016x}.pdf", hasher.finish()))
}

fn move_to_preview_cache(generated: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "预览缓存路径没有父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建预览缓存目录: {error}"))?;

    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|error| format!("无法替换旧的预览缓存文件: {error}"))?;
    }

    match fs::rename(generated, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(generated, destination).map_err(|copy_error| {
                format!(
                    "无法保存 Office 预览 PDF（移动失败: {rename_error}；复制失败: {copy_error}）"
                )
            })?;
            fs::remove_file(generated)
                .map_err(|error| format!("无法清理 Office 转换临时文件: {error}"))?;
            Ok(())
        }
    }
}

fn pdf_page_count(path: &Path) -> Result<u32, String> {
    let document = lopdf::Document::load(path)
        .map_err(|error| format!("无法读取预览 PDF（{}）: {error}", path.display()))?;
    let page_count = u32::try_from(document.get_pages().len())
        .map_err(|_| "PDF 页数超出支持范围".to_string())?;
    if page_count == 0 {
        return Err("PDF 不含可预览页面".to_string());
    }
    Ok(page_count)
}

#[tauri::command]
pub async fn render_document_preview_page(
    path: String,
    page_number: u32,
    max_edge: Option<u32>,
) -> Result<RenderedPreviewPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        render_document_preview_page_blocking(path, page_number, max_edge)
    })
    .await
    .map_err(|error| format!("渲染文档预览任务失败: {error}"))?
}

#[cfg(windows)]
fn render_document_preview_page_blocking(
    path: String,
    page_number: u32,
    max_edge: Option<u32>,
) -> Result<RenderedPreviewPage, String> {
    winrt_preview::render_page(&path, page_number, normalized_max_edge(max_edge))
}

#[cfg(not(windows))]
fn render_document_preview_page_blocking(
    path: String,
    page_number: u32,
    max_edge: Option<u32>,
) -> Result<RenderedPreviewPage, String> {
    let _ = (path, page_number, max_edge);
    Err("当前平台不支持原生 PDF 预览渲染，请在 Windows 上使用此命令".to_string())
}

fn normalized_max_edge(max_edge: Option<u32>) -> u32 {
    max_edge
        .unwrap_or(DEFAULT_PREVIEW_MAX_EDGE)
        .clamp(MIN_PREVIEW_MAX_EDGE, MAX_PREVIEW_MAX_EDGE)
}

fn validate_page_number(page_number: u32, page_count: u32) -> Result<(), String> {
    if page_count == 0 {
        return Err("PDF 不含可预览页面".to_string());
    }
    if page_number == 0 {
        return Err("预览页码必须从 1 开始".to_string());
    }
    if page_number > page_count {
        return Err(format!(
            "预览页码 {page_number} 超出 PDF 页数范围 1..={page_count}"
        ));
    }
    Ok(())
}

fn preview_dimensions(
    source_width: f32,
    source_height: f32,
    max_edge: u32,
) -> Result<(u32, u32), String> {
    if !source_width.is_finite()
        || !source_height.is_finite()
        || source_width <= 0.0
        || source_height <= 0.0
    {
        return Err("PDF 页面尺寸无效".to_string());
    }

    let source_width = f64::from(source_width);
    let source_height = f64::from(source_height);
    let longest_edge = source_width.max(source_height);
    let scale = (f64::from(max_edge) / longest_edge).min(1.0);
    let width = (source_width * scale).round().max(1.0) as u32;
    let height = (source_height * scale).round().max(1.0) as u32;
    Ok((width.min(max_edge), height.min(max_edge)))
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut encoded = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);

        encoded.push(ALPHABET[usize::from(first >> 2)] as char);
        encoded.push(ALPHABET[usize::from(((first & 0b0000_0011) << 4) | (second >> 4))] as char);
        if chunk.len() > 1 {
            encoded
                .push(ALPHABET[usize::from(((second & 0b0000_1111) << 2) | (third >> 6))] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(ALPHABET[usize::from(third & 0b0011_1111)] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

#[cfg(windows)]
mod winrt_preview {
    use super::{encode_base64, preview_dimensions, validate_page_number, RenderedPreviewPage};
    use crate::documents::office_com::{absolute_path_text, ComApartment};
    use windows::{
        core::HSTRING,
        Data::Pdf::{PdfDocument, PdfPage, PdfPageRenderOptions},
        Storage::{
            StorageFile,
            Streams::{DataReader, InMemoryRandomAccessStream},
        },
    };

    struct PageGuard(PdfPage);

    impl Drop for PageGuard {
        fn drop(&mut self) {
            let _ = self.0.Close();
        }
    }

    pub(super) fn render_page(
        path: &str,
        page_number: u32,
        max_edge: u32,
    ) -> Result<RenderedPreviewPage, String> {
        let _apartment = ComApartment::enter()?;
        let path = std::fs::canonicalize(path)
            .map_err(|error| format!("无法解析预览 PDF 路径: {error}"))?;
        let path = absolute_path_text(&path)?;
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
            .map_err(|error| format!("无法打开预览 PDF: {error}"))?
            .get()
            .map_err(|error| format!("等待打开预览 PDF 失败: {error}"))?;
        let document = PdfDocument::LoadFromFileAsync(&file)
            .map_err(|error| format!("无法加载预览 PDF: {error}"))?
            .get()
            .map_err(|error| format!("等待加载预览 PDF 失败: {error}"))?;
        let page_count = document
            .PageCount()
            .map_err(|error| format!("无法读取预览 PDF 页数: {error}"))?;
        validate_page_number(page_number, page_count)?;

        // Load and prepare only the requested page; never enumerate the document.
        let page = PageGuard(
            document
                .GetPage(page_number - 1)
                .map_err(|error| format!("无法加载预览页 {page_number}: {error}"))?,
        );
        page.0
            .PreparePageAsync()
            .map_err(|error| format!("无法准备预览页 {page_number}: {error}"))?
            .get()
            .map_err(|error| format!("等待准备预览页 {page_number} 失败: {error}"))?;
        let page_size = page
            .0
            .Size()
            .map_err(|error| format!("无法读取预览页尺寸: {error}"))?;
        let (width, height) = preview_dimensions(page_size.Width, page_size.Height, max_edge)?;

        let options = PdfPageRenderOptions::new()
            .map_err(|error| format!("无法创建 PDF 预览渲染选项: {error}"))?;
        options
            .SetDestinationWidth(width)
            .map_err(|error| format!("无法设置预览宽度: {error}"))?;
        options
            .SetDestinationHeight(height)
            .map_err(|error| format!("无法设置预览高度: {error}"))?;
        options
            .SetIsIgnoringHighContrast(true)
            .map_err(|error| format!("无法设置预览高对比度选项: {error}"))?;

        let stream = InMemoryRandomAccessStream::new()
            .map_err(|error| format!("无法创建预览 PNG 内存流: {error}"))?;
        page.0
            .RenderWithOptionsToStreamAsync(&stream, &options)
            .map_err(|error| format!("无法渲染预览页 {page_number}: {error}"))?
            .get()
            .map_err(|error| format!("等待渲染预览页 {page_number} 失败: {error}"))?;

        let read_result = read_png_bytes(&stream);
        let close_result = stream.Close();
        let png = read_result?;
        close_result.map_err(|error| format!("关闭预览 PNG 内存流失败: {error}"))?;
        if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("WinRT 预览渲染结果不是 PNG 数据".to_string());
        }

        Ok(RenderedPreviewPage {
            page_number,
            width,
            height,
            png_base64: encode_base64(&png),
        })
    }

    fn read_png_bytes(stream: &InMemoryRandomAccessStream) -> Result<Vec<u8>, String> {
        let size = stream
            .Size()
            .map_err(|error| format!("无法读取预览 PNG 大小: {error}"))?;
        let count = u32::try_from(size).map_err(|_| "预览 PNG 数据超出支持范围".to_string())?;
        if count == 0 {
            return Err("WinRT 未生成预览 PNG 数据".to_string());
        }
        let input = stream
            .GetInputStreamAt(0)
            .map_err(|error| format!("无法读取预览 PNG 流: {error}"))?;
        let reader = DataReader::CreateDataReader(&input)
            .map_err(|error| format!("无法创建预览 PNG 读取器: {error}"))?;

        let result = (|| {
            let loaded = reader
                .LoadAsync(count)
                .map_err(|error| format!("无法加载预览 PNG 数据: {error}"))?
                .get()
                .map_err(|error| format!("等待读取预览 PNG 数据失败: {error}"))?;
            if loaded != count {
                return Err(format!(
                    "预览 PNG 读取不完整：预期 {count} 字节，实际 {loaded} 字节"
                ));
            }
            let mut bytes = vec![0_u8; count as usize];
            reader
                .ReadBytes(&mut bytes)
                .map_err(|error| format!("无法复制预览 PNG 数据: {error}"))?;
            Ok(bytes)
        })();
        let close_result = reader.Close();
        let bytes = result?;
        close_result.map_err(|error| format!("关闭预览 PNG 读取器失败: {error}"))?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn rejects_unsupported_preview_formats_before_io() {
        for path in ["fixture.png", "fixture.txt", "fixture"] {
            let error = prepare_document_preview_blocking(path.to_string()).unwrap_err();
            assert!(error.contains("不支持预览此文件格式"), "{error}");
        }
    }

    #[test]
    fn clamps_preview_edge_and_uses_default() {
        assert_eq!(normalized_max_edge(None), 240);
        assert_eq!(normalized_max_edge(Some(1)), 64);
        assert_eq!(normalized_max_edge(Some(64)), 64);
        assert_eq!(normalized_max_edge(Some(2048)), 2048);
        assert_eq!(normalized_max_edge(Some(4096)), 2048);
    }

    #[test]
    fn validates_one_based_page_numbers() {
        assert!(validate_page_number(1, 2).is_ok());
        assert!(validate_page_number(2, 2).is_ok());
        assert!(validate_page_number(0, 2)
            .unwrap_err()
            .contains("从 1 开始"));
        assert!(validate_page_number(3, 2).unwrap_err().contains("超出"));
        assert!(validate_page_number(1, 0).is_err());
    }

    #[test]
    fn computes_aspect_preserving_bounded_dimensions() {
        assert_eq!(preview_dimensions(200.0, 100.0, 100).unwrap(), (100, 50));
        assert_eq!(preview_dimensions(100.0, 200.0, 100).unwrap(), (50, 100));
        assert_eq!(preview_dimensions(100.0, 50.0, 240).unwrap(), (100, 50));
        assert_eq!(preview_dimensions(1.0, 1000.0, 100).unwrap(), (1, 100));
        assert!(preview_dimensions(0.0, 100.0, 100).is_err());
        assert!(preview_dimensions(f32::NAN, 100.0, 100).is_err());
    }

    #[test]
    fn fingerprint_changes_with_path_size_and_modification_time() {
        let modified = UNIX_EPOCH + Duration::from_secs(100);
        let original = SourceFingerprint {
            path: PathBuf::from("documents/a/report.docx"),
            size: 10,
            modified,
        };
        assert_eq!(original, original.clone());
        assert_ne!(
            original,
            SourceFingerprint {
                size: 11,
                ..original.clone()
            }
        );
        assert_ne!(
            original,
            SourceFingerprint {
                modified: modified + Duration::from_nanos(1),
                ..original.clone()
            }
        );
        let same_stem_elsewhere = SourceFingerprint {
            path: PathBuf::from("documents/b/report.docx"),
            ..original.clone()
        };
        assert_ne!(original, same_stem_elsewhere);
        assert_ne!(
            preview_cache_path(&original),
            preview_cache_path(&same_stem_elsewhere)
        );
    }

    #[test]
    fn encodes_standard_base64_vectors() {
        for (input, expected) in [
            (&b""[..], ""),
            (&b"f"[..], "Zg=="),
            (&b"fo"[..], "Zm8="),
            (&b"foo"[..], "Zm9v"),
            (&b"foobar"[..], "Zm9vYmFy"),
            (&[0_u8, 255, 16, 128][..], "AP8QgA=="),
        ] {
            assert_eq!(encode_base64(input), expected);
        }
    }

    #[test]
    fn serializes_command_results_with_camel_case_fields() {
        let prepared = serde_json::to_value(PreparedDocumentPreview {
            pdf_path: "preview.pdf".to_string(),
            page_count: 3,
        })
        .unwrap();
        assert_eq!(
            prepared,
            serde_json::json!({"pdfPath": "preview.pdf", "pageCount": 3})
        );

        let rendered = serde_json::to_value(RenderedPreviewPage {
            page_number: 1,
            width: 100,
            height: 200,
            png_base64: "AA==".to_string(),
        })
        .unwrap();
        assert_eq!(
            rendered,
            serde_json::json!({
                "pageNumber": 1,
                "width": 100,
                "height": 200,
                "pngBase64": "AA=="
            })
        );
    }
}
