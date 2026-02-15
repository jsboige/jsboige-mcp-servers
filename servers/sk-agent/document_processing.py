#!/usr/bin/env python3
"""
Document Processing Module for sk-agent.

Handles conversion and extraction from various document formats:
- PDF: PyMuPDF or pdf2image for images, PyMuPDF for text
- PPT/PPTX: LibreOffice → PDF → images, or text extraction
- DOC/DOCX: LibreOffice → PDF → images, or python-docx for text
- XLS/XLSX: LibreOffice → PDF → images, or pandas for CSV

Provides a unified PageContent interface for flexible document analysis.
"""

from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from PIL import Image

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log = logging.getLogger("sk-agent.documents")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Custom LibreOffice path (can be set via config or install_libreoffice tool)
LIBREOFFICE_PATH: str | None = None

# Common portable LibreOffice locations to check
LIBREOFFICE_PORTABLE_PATHS = [
    # PortableApps structure
    r"D:\PortableApps\PortableApps\LibreOfficePortable\LibreOfficePortable.exe",
    r"D:\PortableApps\PortableApps\LibreOfficePortable\App\libreoffice\program\soffice.exe",
    r"C:\PortableApps\PortableApps\LibreOfficePortable\LibreOfficePortable.exe",
    # Standard install paths (fallback)
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
]

# Default limits
DEFAULT_MAX_PAGES = 10
MAX_PAGES_HARD_LIMIT = 50

# Token estimation constants (approximate)
TOKENS_PER_TEXT_PAGE = 800  # Average text page
TOKENS_PER_IMAGE_PAGE = 1500  # Image encoded as base64 + context
SAFETY_MARGIN = 0.8  # Use 80% of context to leave room for prompt/response


# ---------------------------------------------------------------------------
# Document Processing Types
# ---------------------------------------------------------------------------

DocumentAnalysisMode = Literal["visual", "text", "hybrid"]


@dataclass
class PageContent:
    """Unified page content that can hold image and/or text.

    This allows flexible document processing:
    - Visual mode: image_data only
    - Text mode: text_content only
    - Hybrid mode: both image and text
    """
    page_number: int
    image_data: bytes | None = None
    media_type: str = "image/png"  # image/png or image/jpeg
    text_content: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def has_image(self) -> bool:
        return self.image_data is not None

    @property
    def has_text(self) -> bool:
        return self.text_content is not None and len(self.text_content) > 0

    def estimate_tokens(self) -> int:
        """Estimate token count for this page."""
        tokens = 0
        if self.has_image:
            tokens += TOKENS_PER_IMAGE_PAGE
        if self.has_text and self.text_content:
            # Rough estimate: ~4 chars per token
            tokens += len(self.text_content) // 4
        return max(tokens, 100)  # Minimum 100 tokens per page


@dataclass
class PageRange:
    """Optional page range for document extraction."""
    start: int = 1  # 1-indexed, inclusive
    end: int | None = None  # None means "until max_pages or end of document"

    def to_slice(self, max_pages: int) -> tuple[int, int]:
        """Convert to 0-indexed slice (start, count)."""
        start_idx = max(0, self.start - 1)
        if self.end is not None:
            count = max(0, self.end - self.start + 1)
        else:
            count = max_pages
        return (start_idx, count)


# ---------------------------------------------------------------------------
# LibreOffice Discovery
# ---------------------------------------------------------------------------

def _find_libreoffice() -> str | None:
    """Find LibreOffice executable in system PATH or common portable locations.

    Returns:
        Path to LibreOffice executable (soffice.exe or LibreOfficePortable.exe) or None
    """
    global LIBREOFFICE_PATH

    # 1. Check custom path set via config/install tool
    if LIBREOFFICE_PATH and Path(LIBREOFFICE_PATH).exists():
        log.info("Using configured LibreOffice path: %s", LIBREOFFICE_PATH)
        return LIBREOFFICE_PATH

    # 2. Check system PATH
    path_result = shutil.which("libreoffice") or shutil.which("soffice")
    if path_result:
        log.info("Found LibreOffice in PATH: %s", path_result)
        return path_result

    # 3. Check common portable installation locations
    for portable_path in LIBREOFFICE_PORTABLE_PATHS:
        if Path(portable_path).exists():
            log.info("Found portable LibreOffice: %s", portable_path)
            return portable_path

    log.warning("LibreOffice not found in PATH or portable locations")
    return None


def set_libreoffice_path(path: str) -> bool:
    """Set custom LibreOffice path.

    Args:
        path: Path to LibreOffice executable

    Returns:
        True if path is valid and was set
    """
    global LIBREOFFICE_PATH
    if Path(path).exists():
        LIBREOFFICE_PATH = path
        log.info("Set LibreOffice path to: %s", path)
        return True
    log.warning("LibreOffice path does not exist: %s", path)
    return False


# ---------------------------------------------------------------------------
# PDF Processing
# ---------------------------------------------------------------------------

def _pdf_to_images(
    pdf_path: str,
    max_pages: int = 10,
    start_page: int = 0,
) -> list[tuple[bytes, str]]:
    """Convert PDF pages to images using pdf2image or PyMuPDF.

    Optimized for GLM-4.6V: DPI 180, PNG format (lossless).

    Args:
        pdf_path: Path to the PDF file
        max_pages: Maximum number of pages to convert
        start_page: 0-indexed starting page

    Returns:
        List of (image_bytes, media_type) tuples
    """
    images = []

    # Calculate page range
    first_page = start_page + 1  # 1-indexed for libraries
    last_page = start_page + max_pages

    # Try PyMuPDF first (better quality control, matches GLM-V gradio implementation)
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(pdf_path)
        page_count = doc.page_count

        # Clamp to actual pages
        first_page = max(1, min(first_page, page_count))
        last_page = min(last_page, page_count)

        for page_idx in range(first_page - 1, last_page):
            page = doc[page_idx]
            # Render page to image at DPI 180 (matches GLM-V gradio)
            pix = page.get_pixmap(dpi=180)
            img_data = pix.tobytes("png")  # PNG for lossless quality
            images.append((img_data, "image/png"))
            log.info("Converted PDF page %d to PNG (PyMuPDF, DPI=180)", page_idx + 1)

        doc.close()
        log.info("Converted %d pages from PDF: %s", len(images), pdf_path)
        return images
    except ImportError:
        log.debug("PyMuPDF not available, trying pdf2image")
    except Exception as e:
        log.warning("PyMuPDF failed: %s, trying pdf2image", e)

    # Fallback to pdf2image
    try:
        from pdf2image import convert_from_path

        pages = convert_from_path(
            pdf_path,
            first_page=first_page,
            last_page=last_page,
            dpi=180
        )
        for i, page in enumerate(pages):
            buf = io.BytesIO()
            page.save(buf, format="PNG")  # PNG for lossless quality
            images.append((buf.getvalue(), "image/png"))
            log.info("Converted PDF page %d to PNG (pdf2image, DPI=180)", first_page + i)

        log.info("Converted %d pages from PDF: %s", len(images), pdf_path)
        return images
    except ImportError:
        log.error("Neither PyMuPDF nor pdf2image available for PDF conversion")
        raise RuntimeError(
            "PDF conversion requires PyMuPDF or pdf2image. "
            "Install with: pip install PyMuPDF or pip install pdf2image"
        )
    except Exception as e:
        log.error("PDF conversion failed: %s", e)
        raise


# ---------------------------------------------------------------------------
# PowerPoint Processing
# ---------------------------------------------------------------------------

def _ppt_to_images(
    ppt_path: str,
    max_pages: int = 10,
    start_page: int = 0,
) -> list[tuple[bytes, str]]:
    """Convert PowerPoint slides to images using LibreOffice + PyMuPDF.

    Matches GLM-V gradio implementation: libreoffice --headless --convert-to pdf

    Args:
        ppt_path: Path to the PPT/PPTX file
        max_pages: Maximum number of slides to convert
        start_page: 0-indexed starting page

    Returns:
        List of (image_bytes, media_type) tuples
    """
    # Check if LibreOffice is available
    libreoffice_cmd = _find_libreoffice()
    if not libreoffice_cmd:
        raise RuntimeError(
            "PowerPoint conversion requires LibreOffice. "
            "Use install_libreoffice tool or install from: https://www.libreoffice.org/download/"
        )

    # Create temp directory for conversion
    tmp_dir = tempfile.mkdtemp(prefix="ppt_convert_")
    pdf_path = None

    try:
        # Convert PPT to PDF using LibreOffice headless
        result = subprocess.run(
            [libreoffice_cmd, "--headless", "--convert-to", "pdf", "--outdir", tmp_dir, ppt_path],
            capture_output=True,
            text=True,
            timeout=120  # 2 minute timeout
        )

        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

        # Find the generated PDF
        ppt_stem = Path(ppt_path).stem
        pdf_path = Path(tmp_dir) / f"{ppt_stem}.pdf"

        if not pdf_path.exists():
            raise RuntimeError(f"PDF not generated at {pdf_path}")

        log.info("Converted PPT to PDF: %s", pdf_path)

        # Convert PDF to images using existing function
        images = _pdf_to_images(str(pdf_path), max_pages=max_pages, start_page=start_page)
        log.info("Converted %d slides from PPT: %s", len(images), ppt_path)
        return images

    except subprocess.TimeoutExpired:
        raise RuntimeError("LibreOffice conversion timed out (>120s)")
    finally:
        # Cleanup temp directory
        if pdf_path and pdf_path.parent.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Word Document Processing
# ---------------------------------------------------------------------------

def _doc_to_text(doc_path: str) -> str:
    """Convert Word document (DOC/DOCX) to plain text using LibreOffice.

    Args:
        doc_path: Path to the DOC/DOCX file

    Returns:
        Extracted text content
    """
    libreoffice_cmd = _find_libreoffice()
    if not libreoffice_cmd:
        # Fallback: try python-docx for DOCX files
        if doc_path.lower().endswith(".docx"):
            try:
                from docx import Document
                doc = Document(doc_path)
                text_parts = [para.text for para in doc.paragraphs]
                return "\n".join(text_parts)
            except ImportError:
                raise RuntimeError(
                    "Word document conversion requires LibreOffice or python-docx. "
                    "Install with: pip install python-docx"
                )
        raise RuntimeError(
            "Word document conversion requires LibreOffice. "
            "Use install_libreoffice tool or install from: https://www.libreoffice.org/download/"
        )

    tmp_dir = tempfile.mkdtemp(prefix="doc_convert_")
    txt_path = None

    try:
        # Convert DOC to TXT using LibreOffice headless
        result = subprocess.run(
            [libreoffice_cmd, "--headless", "--convert-to", "txt:Text", "--outdir", tmp_dir, doc_path],
            capture_output=True,
            text=True,
            timeout=120
        )

        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

        # Find the generated TXT file
        doc_stem = Path(doc_path).stem
        txt_path = Path(tmp_dir) / f"{doc_stem}.txt"

        if not txt_path.exists():
            # Try with different encoding suffix
            for f in Path(tmp_dir).glob("*.txt"):
                txt_path = f
                break
            else:
                raise RuntimeError(f"Text file not generated at {txt_path}")

        # Read the text content
        with open(txt_path, encoding="utf-8", errors="replace") as f:
            text = f.read()

        log.info("Converted DOC to text: %s (%d chars)", doc_path, len(text))
        return text

    except subprocess.TimeoutExpired:
        raise RuntimeError("LibreOffice conversion timed out (>120s)")
    finally:
        if txt_path and txt_path.parent.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _doc_to_images(
    doc_path: str,
    max_pages: int = 50,
    start_page: int = 0,
) -> list[tuple[bytes, str]]:
    """Convert Word document (DOC/DOCX) pages to images using LibreOffice.

    Converts via: DOC/DOCX → PDF → Images (same pipeline as PPT).

    Args:
        doc_path: Path to the DOC/DOCX file
        max_pages: Maximum number of pages to convert
        start_page: 0-indexed starting page

    Returns:
        List of (image_bytes, media_type) tuples
    """
    libreoffice_cmd = _find_libreoffice()
    if not libreoffice_cmd:
        raise RuntimeError(
            "Word document visual conversion requires LibreOffice. "
            "Use install_libreoffice tool or install from: https://www.libreoffice.org/download/"
        )

    tmp_dir = tempfile.mkdtemp(prefix="doc_convert_")
    pdf_path = None

    try:
        # Convert DOC to PDF using LibreOffice headless
        result = subprocess.run(
            [libreoffice_cmd, "--headless", "--convert-to", "pdf", "--outdir", tmp_dir, doc_path],
            capture_output=True,
            text=True,
            timeout=120
        )

        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

        # Find the generated PDF
        doc_stem = Path(doc_path).stem
        pdf_path = Path(tmp_dir) / f"{doc_stem}.pdf"

        if not pdf_path.exists():
            raise RuntimeError(f"PDF not generated at {pdf_path}")

        log.info("Converted DOC to PDF: %s", pdf_path)

        # Convert PDF to images using existing function
        images = _pdf_to_images(str(pdf_path), max_pages=max_pages, start_page=start_page)
        log.info("Converted %d pages from Word document: %s", len(images), doc_path)
        return images

    except subprocess.TimeoutExpired:
        raise RuntimeError("LibreOffice conversion timed out (>120s)")
    finally:
        if pdf_path and pdf_path.parent.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Excel Processing
# ---------------------------------------------------------------------------

def _xlsx_to_csv(xlsx_path: str, max_sheets: int = 10) -> list[tuple[str, str]]:
    """Convert Excel spreadsheet (XLS/XLSX) to CSV using pandas or LibreOffice.

    Args:
        xlsx_path: Path to the XLS/XLSX file
        max_sheets: Maximum number of sheets to convert

    Returns:
        List of (sheet_name, csv_content) tuples
    """
    sheets = []

    # Try pandas first (faster and more reliable for XLSX)
    try:
        import pandas as pd

        # Read all sheets
        xlsx = pd.ExcelFile(xlsx_path)
        for i, sheet_name in enumerate(xlsx.sheet_names):
            if i >= max_sheets:
                break
            df = pd.read_excel(xlsx, sheet_name=sheet_name)
            csv_content = df.to_csv(index=False)
            sheets.append((sheet_name, csv_content))
            log.info("Converted sheet '%s' to CSV (%d rows)", sheet_name, len(df))

        log.info("Converted %d sheets from Excel: %s", len(sheets), xlsx_path)
        return sheets

    except ImportError:
        log.debug("pandas not available, trying LibreOffice")
    except Exception as e:
        log.warning("pandas Excel read failed: %s, trying LibreOffice", e)

    # Fallback to LibreOffice
    libreoffice_cmd = _find_libreoffice()
    if not libreoffice_cmd:
        raise RuntimeError(
            "Excel conversion requires pandas or LibreOffice. "
            "Install with: pip install pandas openpyxl"
        )

    tmp_dir = tempfile.mkdtemp(prefix="xlsx_convert_")
    csv_path = None

    try:
        # Convert XLSX to CSV using LibreOffice headless
        result = subprocess.run(
            [libreoffice_cmd, "--headless", "--convert-to", "csv", "--outdir", tmp_dir, xlsx_path],
            capture_output=True,
            text=True,
            timeout=120
        )

        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

        # Find generated CSV files (one per sheet)
        for csv_file in sorted(Path(tmp_dir).glob("*.csv"))[:max_sheets]:
            with open(csv_file, encoding="utf-8", errors="replace") as f:
                csv_content = f.read()
            sheet_name = csv_file.stem.replace(Path(xlsx_path).stem + "_", "")
            sheets.append((sheet_name, csv_content))
            log.info("Converted sheet '%s' to CSV", sheet_name)

        log.info("Converted %d sheets from Excel: %s", len(sheets), xlsx_path)
        return sheets

    except subprocess.TimeoutExpired:
        raise RuntimeError("LibreOffice conversion timed out (>120s)")
    finally:
        if csv_path and csv_path.parent.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _xlsx_to_images(
    xlsx_path: str,
    max_sheets: int = 10,
    start_sheet: int = 0,
) -> list[tuple[bytes, str]]:
    """Convert Excel spreadsheet sheets to images using LibreOffice.

    Converts via: XLS/XLSX → PDF → Images (each sheet becomes a page).

    Args:
        xlsx_path: Path to the XLS/XLSX file
        max_sheets: Maximum number of sheets to convert
        start_sheet: 0-indexed starting sheet

    Returns:
        List of (image_bytes, media_type) tuples
    """
    libreoffice_cmd = _find_libreoffice()
    if not libreoffice_cmd:
        raise RuntimeError(
            "Excel visual conversion requires LibreOffice. "
            "Use install_libreoffice tool or install from: https://www.libreoffice.org/download/"
        )

    tmp_dir = tempfile.mkdtemp(prefix="xlsx_convert_")
    pdf_path = None

    try:
        # Convert XLSX to PDF using LibreOffice headless
        result = subprocess.run(
            [libreoffice_cmd, "--headless", "--convert-to", "pdf", "--outdir", tmp_dir, xlsx_path],
            capture_output=True,
            text=True,
            timeout=120
        )

        if result.returncode != 0:
            raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

        # Find the generated PDF
        xlsx_stem = Path(xlsx_path).stem
        pdf_path = Path(tmp_dir) / f"{xlsx_stem}.pdf"

        if not pdf_path.exists():
            raise RuntimeError(f"PDF not generated at {pdf_path}")

        log.info("Converted XLSX to PDF: %s", pdf_path)

        # Convert PDF to images (each sheet is typically a page)
        images = _pdf_to_images(str(pdf_path), max_pages=max_sheets, start_page=start_sheet)
        log.info("Converted %d sheets from Excel: %s", len(images), xlsx_path)
        return images

    except subprocess.TimeoutExpired:
        raise RuntimeError("LibreOffice conversion timed out (>120s)")
    finally:
        if pdf_path and pdf_path.parent.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Unified Document Page Extraction
# ---------------------------------------------------------------------------

def calculate_max_pages_for_tokens(
    context_window: int,
    mode: DocumentAnalysisMode = "visual",
    reserve_tokens: int = 4000,
) -> int:
    """Calculate max pages based on token budget.

    Args:
        context_window: Model's context window in tokens
        mode: Analysis mode (affects token estimation)
        reserve_tokens: Tokens to reserve for prompt and response

    Returns:
        Maximum number of pages that fit within the budget
    """
    available = int((context_window - reserve_tokens) * SAFETY_MARGIN)

    if mode == "text":
        tokens_per_page = TOKENS_PER_TEXT_PAGE
    elif mode == "hybrid":
        tokens_per_page = TOKENS_PER_TEXT_PAGE + TOKENS_PER_IMAGE_PAGE
    else:  # visual
        tokens_per_page = TOKENS_PER_IMAGE_PAGE

    return max(1, available // tokens_per_page)


def extract_document_pages(
    document_path: str,
    mode: DocumentAnalysisMode = "visual",
    max_pages: int = DEFAULT_MAX_PAGES,
    page_range: PageRange | None = None,
    context_window: int | None = None,
) -> list[PageContent]:
    """Extract pages from any document type with unified output.

    Supports: PDF, PPT/PPTX, DOC/DOCX, XLS/XLSX

    Args:
        document_path: Path to the document file
        mode: Analysis mode - "visual" (images), "text" (extracted text), "hybrid" (both)
        max_pages: Maximum number of pages/sheets to extract
        page_range: Optional page range (start_page, end_page)
        context_window: Optional context window to auto-limit pages

    Returns:
        List of PageContent objects with image and/or text content

    Raises:
        RuntimeError: If required tools/libraries are not available
        ValueError: If document format is not supported
    """
    doc_path = Path(document_path)
    suffix = doc_path.suffix.lower() if doc_path.suffix else ""

    # Apply page range if specified
    if page_range:
        start_idx, count = page_range.to_slice(max_pages)
        max_pages = min(count, max_pages)
    else:
        start_idx = 0

    # Auto-limit based on context window if specified
    if context_window:
        token_limit = calculate_max_pages_for_tokens(context_window, mode)
        max_pages = min(max_pages, token_limit)
        log.info("Auto-limited to %d pages based on %d token context window", max_pages, context_window)

    # Hard limit
    max_pages = min(max_pages, MAX_PAGES_HARD_LIMIT)

    pages: list[PageContent] = []

    # Route based on document type and mode
    if suffix == ".pdf":
        pages = _extract_pdf_pages(document_path, mode, max_pages, start_idx)
    elif suffix in (".ppt", ".pptx"):
        pages = _extract_ppt_pages(document_path, mode, max_pages, start_idx)
    elif suffix in (".doc", ".docx"):
        pages = _extract_doc_pages(document_path, mode, max_pages, start_idx)
    elif suffix in (".xls", ".xlsx"):
        pages = _extract_xlsx_pages(document_path, mode, max_pages, start_idx)
    else:
        raise ValueError(
            f"Unsupported document format: {suffix}. "
            f"Supported: PDF, PPT, PPTX, DOC, DOCX, XLS, XLSX"
        )

    log.info(
        "Extracted %d pages from %s (mode=%s, format=%s, start=%d)",
        len(pages), document_path, mode, suffix, start_idx + 1
    )
    return pages


def _extract_pdf_pages(
    pdf_path: str,
    mode: DocumentAnalysisMode,
    max_pages: int,
    start_page: int = 0,
) -> list[PageContent]:
    """Extract pages from PDF."""
    pages: list[PageContent] = []

    if mode in ("visual", "hybrid"):
        # Get images
        try:
            images = _pdf_to_images(pdf_path, max_pages=max_pages, start_page=start_page)
            for i, (img_data, media_type) in enumerate(images):
                page = PageContent(
                    page_number=start_page + i + 1,
                    image_data=img_data,
                    media_type=media_type,
                )

                # For hybrid mode, try to extract text too
                if mode == "hybrid":
                    try:
                        import fitz  # PyMuPDF
                        doc = fitz.open(pdf_path)
                        page_idx = start_page + i
                        if page_idx < doc.page_count:
                            text = doc.load_page(page_idx).get_text()
                            page.text_content = text if text.strip() else None
                        doc.close()
                    except Exception:
                        pass

                pages.append(page)
        except Exception as e:
            if mode == "visual":
                raise
            log.warning("PDF image extraction failed, falling back to text: %s", e)

    if mode == "text" or (mode == "hybrid" and not pages):
        # Extract text only
        try:
            import fitz  # PyMuPDF
            doc = fitz.open(pdf_path)
            end_page = min(start_page + max_pages, doc.page_count)
            for page_idx in range(start_page, end_page):
                text = doc.load_page(page_idx).get_text()
                pages.append(PageContent(
                    page_number=page_idx + 1,
                    text_content=text if text.strip() else None,
                ))
            doc.close()
        except ImportError:
            raise RuntimeError("PDF text extraction requires PyMuPDF. Install with: pip install PyMuPDF")

    return pages


def _extract_ppt_pages(
    ppt_path: str,
    mode: DocumentAnalysisMode,
    max_pages: int,
    start_page: int = 0,
) -> list[PageContent]:
    """Extract pages from PowerPoint."""
    pages: list[PageContent] = []

    if mode in ("visual", "hybrid"):
        # Get images via LibreOffice
        images = _ppt_to_images(ppt_path, max_pages=max_pages, start_page=start_page)
        for i, (img_data, media_type) in enumerate(images):
            pages.append(PageContent(
                page_number=start_page + i + 1,
                image_data=img_data,
                media_type=media_type,
                metadata={"source": "slide"},
            ))

    if mode == "text":
        # Text extraction from PPT is limited - convert to text via LibreOffice
        text = _doc_to_text(ppt_path)
        pages.append(PageContent(
            page_number=1,
            text_content=text,
            metadata={"source": "all_slides"},
        ))

    return pages


def _extract_doc_pages(
    doc_path: str,
    mode: DocumentAnalysisMode,
    max_pages: int,
    start_page: int = 0,
) -> list[PageContent]:
    """Extract pages from Word document."""
    pages: list[PageContent] = []

    if mode in ("visual", "hybrid"):
        # Get images via LibreOffice (DOC → PDF → Images)
        try:
            images = _doc_to_images(doc_path, max_pages=max_pages, start_page=start_page)
            for i, (img_data, media_type) in enumerate(images):
                page = PageContent(
                    page_number=start_page + i + 1,
                    image_data=img_data,
                    media_type=media_type,
                )

                # For hybrid mode, we'd need page-by-page text extraction
                # This is complex - for now, skip per-page text in hybrid mode
                pages.append(page)
        except Exception as e:
            if mode == "visual":
                raise
            log.warning("DOC image extraction failed, falling back to text: %s", e)

    if mode == "text" or (mode == "hybrid" and not pages):
        # Get all text
        text = _doc_to_text(doc_path)
        # Split by form feed or approximate pages
        if "\f" in text:
            text_parts = text.split("\f")[start_page:start_page + max_pages]
            for i, part in enumerate(text_parts):
                if part.strip():
                    pages.append(PageContent(
                        page_number=start_page + i + 1,
                        text_content=part.strip(),
                    ))
        else:
            pages.append(PageContent(
                page_number=1,
                text_content=text,
                metadata={"source": "full_document"},
            ))

    return pages


def _extract_xlsx_pages(
    xlsx_path: str,
    mode: DocumentAnalysisMode,
    max_pages: int,
    start_sheet: int = 0,
) -> list[PageContent]:
    """Extract pages from Excel spreadsheet."""
    pages: list[PageContent] = []

    if mode in ("visual", "hybrid"):
        # Get images via LibreOffice (XLSX → PDF → Images)
        try:
            images = _xlsx_to_images(xlsx_path, max_sheets=max_pages, start_sheet=start_sheet)
            for i, (img_data, media_type) in enumerate(images):
                page = PageContent(
                    page_number=start_sheet + i + 1,
                    image_data=img_data,
                    media_type=media_type,
                    metadata={"source": "sheet"},
                )
                pages.append(page)
        except Exception as e:
            if mode == "visual":
                raise
            log.warning("XLSX image extraction failed, falling back to text: %s", e)

    if mode == "text" or (mode == "hybrid" and not pages):
        # Get CSV data per sheet
        sheets = _xlsx_to_csv(xlsx_path, max_sheets=max_pages + start_sheet)
        for i, (sheet_name, csv_content) in enumerate(sheets[start_sheet:]):
            pages.append(PageContent(
                page_number=start_sheet + i + 1,
                text_content=csv_content,
                metadata={"source": "sheet", "sheet_name": sheet_name},
            ))

    return pages
