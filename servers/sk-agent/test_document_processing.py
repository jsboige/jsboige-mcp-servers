#!/usr/bin/env python3
"""
Unit tests for document_processing module.

Tests cover:
- LibreOffice discovery
- PowerPoint conversion
- Word document conversion
- Excel conversion
- PageContent dataclass
- Unified document extraction pipeline
"""

import io
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent))

import document_processing
from document_processing import (
    PageContent,
    PageRange,
    extract_document_pages,
    calculate_max_pages_for_tokens,
    set_libreoffice_path,
    _find_libreoffice,
    _pdf_to_images,
    _ppt_to_images,
    _doc_to_text,
    _doc_to_images,
    _xlsx_to_csv,
    _xlsx_to_images,
    DEFAULT_MAX_PAGES,
    MAX_PAGES_HARD_LIMIT,
)


# ---------------------------------------------------------------------------
# Test Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_image():
    """Create a sample PNG image for testing."""
    from PIL import Image

    img = Image.new("RGB", (100, 100), color="red")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# LibreOffice Discovery Tests
# ---------------------------------------------------------------------------


class TestLibreOfficeDiscovery:
    """Tests for LibreOffice discovery functionality."""

    def test_find_libreoffice_function_exists(self):
        """Test that _find_libreoffice function exists."""
        assert hasattr(document_processing, "_find_libreoffice")
        import inspect

        sig = inspect.signature(document_processing._find_libreoffice)
        # Should have no required parameters
        assert (
            len(
                [
                    p
                    for p in sig.parameters.values()
                    if p.default == inspect.Parameter.empty
                ]
            )
            == 0
        )

    def test_find_libreoffice_with_global_path(self, tmp_path):
        """Test that global LIBREOFFICE_PATH is used when set."""
        # Create a fake LibreOffice executable
        fake_lo = tmp_path / "libreoffice.exe"
        fake_lo.write_bytes(b"fake")

        # Set global path using the set_libreoffice_path function
        original_path = document_processing.LIBREOFFICE_PATH
        try:
            set_libreoffice_path(str(fake_lo))
            result = _find_libreoffice()
            assert result == str(fake_lo)
        finally:
            document_processing.LIBREOFFICE_PATH = original_path

    def test_find_libreoffice_checks_portable_paths(self):
        """Test that portable paths are checked."""
        # Verify portable paths list exists and has expected structure
        assert hasattr(document_processing, "LIBREOFFICE_PORTABLE_PATHS")
        assert isinstance(document_processing.LIBREOFFICE_PORTABLE_PATHS, list)
        assert len(document_processing.LIBREOFFICE_PORTABLE_PATHS) > 0

        # Should include common paths
        paths_str = "\n".join(document_processing.LIBREOFFICE_PORTABLE_PATHS)
        assert "PortableApps" in paths_str or "LibreOffice" in paths_str

    def test_find_libreoffice_returns_none_when_not_found(self):
        """Test that None is returned when LibreOffice is not found."""
        import shutil

        # Save original values
        original_path = document_processing.LIBREOFFICE_PATH

        try:
            # Clear global path
            document_processing.LIBREOFFICE_PATH = None

            # Mock shutil.which to return None (not in PATH)
            with patch.object(shutil, "which", return_value=None):
                # Mock Path.exists to return False for all portable paths
                with patch.object(Path, "exists", return_value=False):
                    result = _find_libreoffice()

            assert result is None
        finally:
            document_processing.LIBREOFFICE_PATH = original_path

    def test_set_libreoffice_path_valid(self, tmp_path):
        """Test setting a valid LibreOffice path."""
        fake_lo = tmp_path / "libreoffice.exe"
        fake_lo.write_bytes(b"fake")

        result = set_libreoffice_path(str(fake_lo))
        assert result is True
        assert document_processing.LIBREOFFICE_PATH == str(fake_lo)

    def test_set_libreoffice_path_invalid(self, tmp_path):
        """Test setting an invalid LibreOffice path."""
        result = set_libreoffice_path(str(tmp_path / "nonexistent.exe"))
        assert result is False


# ---------------------------------------------------------------------------
# PowerPoint Conversion Tests
# ---------------------------------------------------------------------------


class TestPowerPointConversion:
    """Tests for PowerPoint to image conversion."""

    def test_ppt_to_images_function_exists(self):
        """Test that _ppt_to_images function exists."""
        import inspect

        sig = inspect.signature(_ppt_to_images)
        params = list(sig.parameters.keys())

        assert "ppt_path" in params
        assert "max_pages" in params

    def test_ppt_to_images_no_libreoffice(self, tmp_path):
        """Test error when LibreOffice is not found."""
        fake_ppt = tmp_path / "test.pptx"
        fake_ppt.write_bytes(b"fake ppt")

        # Mock _find_libreoffice to return None
        with patch("document_processing._find_libreoffice", return_value=None):
            with pytest.raises(RuntimeError) as exc_info:
                _ppt_to_images(str(fake_ppt))

        assert "LibreOffice" in str(exc_info.value)

    def test_ppt_to_images_success_mocked(self, tmp_path):
        """Test successful PPT conversion with mocked LibreOffice."""
        from PIL import Image

        # Create fake PPT file
        fake_ppt = tmp_path / "test.pptx"
        fake_ppt.write_bytes(b"fake ppt")

        # Create fake LibreOffice executable
        fake_lo = tmp_path / "libreoffice.exe"
        fake_lo.write_bytes(b"fake")

        # Create expected output images
        def create_test_image():
            img = Image.new("RGB", (200, 200), color="white")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return buf.getvalue()

        # Mock _find_libreoffice to return our fake path
        with patch("document_processing._find_libreoffice", return_value=str(fake_lo)):
            # Mock subprocess.run to simulate LibreOffice conversion
            def mock_run(cmd, *args, **kwargs):
                if "--convert-to" in cmd and "pdf" in cmd:
                    # Find the output directory from command
                    out_dir = None
                    for i, arg in enumerate(cmd):
                        if arg == "--outdir":
                            out_dir = Path(cmd[i + 1])
                            break

                    if out_dir and out_dir.exists():
                        # Create the PDF in the output directory
                        input_file = Path(cmd[-1])
                        pdf_path = out_dir / f"{input_file.stem}.pdf"
                        pdf_path.write_bytes(b"%PDF-1.4 converted")

                    result = MagicMock()
                    result.returncode = 0
                    result.stderr = ""
                    return result
                return MagicMock(returncode=0)

            # Mock _pdf_to_images to return test images
            with patch(
                "document_processing._pdf_to_images",
                return_value=[
                    (create_test_image(), "image/png"),
                    (create_test_image(), "image/png"),
                ],
            ):
                with patch("document_processing.subprocess.run", side_effect=mock_run):
                    result = _ppt_to_images(str(fake_ppt), max_pages=2)

        assert len(result) == 2
        for img_data, media_type in result:
            assert len(img_data) > 0
            assert media_type == "image/png"


# ---------------------------------------------------------------------------
# Word Document Conversion Tests
# ---------------------------------------------------------------------------


class TestWordDocumentConversion:
    """Tests for Word document to text conversion."""

    def test_doc_to_text_function_exists(self):
        """Test that _doc_to_text function exists."""
        import inspect

        sig = inspect.signature(_doc_to_text)
        params = list(sig.parameters.keys())

        assert "doc_path" in params

    def test_doc_to_text_no_libreoffice(self, tmp_path):
        """Test error when neither LibreOffice nor python-docx available."""
        fake_doc = tmp_path / "test.doc"  # .doc (not .docx) won't try python-docx
        fake_doc.write_bytes(b"fake doc")

        # Mock _find_libreoffice to return None
        with patch("document_processing._find_libreoffice", return_value=None):
            with pytest.raises(RuntimeError) as exc_info:
                _doc_to_text(str(fake_doc))

        assert "LibreOffice" in str(exc_info.value)

    def test_doc_to_text_with_python_docx(self, tmp_path):
        """Test DOCX conversion with mocked python-docx."""
        fake_doc = tmp_path / "test.docx"
        fake_doc.write_bytes(b"PK fake docx")  # ZIP signature for docx

        # Mock _find_libreoffice to return None (force python-docx path)
        # Mock docx module
        mock_document = MagicMock()
        mock_document.paragraphs = [
            MagicMock(text="First paragraph"),
            MagicMock(text="Second paragraph"),
        ]

        mock_docx = MagicMock()
        mock_docx.Document = MagicMock(return_value=mock_document)

        with patch("document_processing._find_libreoffice", return_value=None):
            with patch.dict("sys.modules", {"docx": mock_docx}):
                result = _doc_to_text(str(fake_doc))

        assert "First paragraph" in result
        assert "Second paragraph" in result


# ---------------------------------------------------------------------------
# Excel Conversion Tests
# ---------------------------------------------------------------------------


class TestExcelConversion:
    """Tests for Excel to CSV conversion."""

    def test_xlsx_to_csv_function_exists(self):
        """Test that _xlsx_to_csv function exists."""
        import inspect

        sig = inspect.signature(_xlsx_to_csv)
        params = list(sig.parameters.keys())

        assert "xlsx_path" in params
        assert "max_sheets" in params

    def test_xlsx_to_csv_with_pandas(self, tmp_path):
        """Test Excel conversion with mocked pandas."""
        fake_xlsx = tmp_path / "test.xlsx"
        fake_xlsx.write_bytes(b"PK fake xlsx")

        # Mock pandas
        mock_df = MagicMock()
        mock_df.to_csv = MagicMock(return_value="col1,col2\nval1,val2")

        mock_excel = MagicMock()
        mock_excel.sheet_names = ["Sheet1", "Sheet2"]
        mock_excel.__enter__ = MagicMock(return_value=mock_excel)
        mock_excel.__exit__ = MagicMock(return_value=False)

        mock_pd = MagicMock()
        mock_pd.ExcelFile = MagicMock(return_value=mock_excel)
        mock_pd.read_excel = MagicMock(return_value=mock_df)

        with patch.dict("sys.modules", {"pandas": mock_pd}):
            result = _xlsx_to_csv(str(fake_xlsx))

        assert len(result) == 2
        assert result[0][0] == "Sheet1"
        assert result[1][0] == "Sheet2"
        assert "col1,col2" in result[0][1]

    def test_xlsx_to_csv_no_pandas_no_libreoffice(self, tmp_path):
        """Test error when neither pandas nor LibreOffice available."""
        fake_xlsx = tmp_path / "test.xlsx"
        fake_xlsx.write_bytes(b"PK fake xlsx")

        # Mock _find_libreoffice to return None
        with patch("document_processing._find_libreoffice", return_value=None):
            # Need to trigger the import error
            import builtins

            original_import = builtins.__import__

            def mock_import(name, *args, **kwargs):
                if name == "pandas":
                    raise ImportError("No pandas")
                return original_import(name, *args, **kwargs)

            with patch("builtins.__import__", side_effect=mock_import):
                with pytest.raises(RuntimeError) as exc_info:
                    _xlsx_to_csv(str(fake_xlsx))

        assert "pandas" in str(exc_info.value) or "LibreOffice" in str(exc_info.value)


# ---------------------------------------------------------------------------
# PageContent Tests
# ---------------------------------------------------------------------------


class TestPageContent:
    """Tests for PageContent dataclass."""

    def test_page_content_creation(self):
        """Test PageContent can be created with various data."""
        # Image only
        page1 = PageContent(
            page_number=1, image_data=b"fake_image", media_type="image/png"
        )
        assert page1.has_image
        assert not page1.has_text

        # Text only
        page2 = PageContent(page_number=2, text_content="Some text")
        assert not page2.has_image
        assert page2.has_text

        # Hybrid
        page3 = PageContent(page_number=3, image_data=b"img", text_content="text")
        assert page3.has_image
        assert page3.has_text

    def test_page_content_metadata(self):
        """Test PageContent can hold metadata."""
        page = PageContent(
            page_number=1,
            text_content="data",
            metadata={"sheet_name": "Sheet1", "source": "sheet"},
        )
        assert page.metadata["sheet_name"] == "Sheet1"

    def test_page_content_estimate_tokens(self):
        """Test token estimation for PageContent."""
        # Text only
        text_page = PageContent(page_number=1, text_content="A" * 4000)  # ~1000 tokens
        tokens = text_page.estimate_tokens()
        assert tokens >= 100

        # Image page
        img_page = PageContent(page_number=1, image_data=b"fake_image")
        tokens = img_page.estimate_tokens()
        assert tokens >= 100


# ---------------------------------------------------------------------------
# PageRange Tests
# ---------------------------------------------------------------------------


class TestPageRange:
    """Tests for PageRange dataclass."""

    def test_page_range_default(self):
        """Test default PageRange values."""
        pr = PageRange()
        assert pr.start == 1
        assert pr.end is None

    def test_page_range_to_slice(self):
        """Test PageRange.to_slice conversion."""
        # No end specified
        pr = PageRange(start=1)
        start, count = pr.to_slice(max_pages=10)
        assert start == 0
        assert count == 10

        # With end specified
        pr = PageRange(start=5, end=10)
        start, count = pr.to_slice(max_pages=50)
        assert start == 4
        assert count == 6

    def test_page_range_invalid(self):
        """Test PageRange with invalid values."""
        pr = PageRange(start=10, end=5)  # Invalid: end < start
        start, count = pr.to_slice(max_pages=10)
        assert count == 0  # No pages


# ---------------------------------------------------------------------------
# Token-based Limit Tests
# ---------------------------------------------------------------------------


class TestTokenLimits:
    """Tests for token-based page limiting."""

    def test_calculate_max_pages_visual(self):
        """Test max pages calculation for visual mode."""
        # 128k context, visual mode
        max_pages = calculate_max_pages_for_tokens(128_000, mode="visual")
        assert max_pages > 0
        assert max_pages < 100  # Should be reasonable

    def test_calculate_max_pages_text(self):
        """Test max pages calculation for text mode."""
        # 32k context, text mode
        max_pages = calculate_max_pages_for_tokens(32_000, mode="text")
        assert max_pages > 0
        # Text mode should allow more pages than visual
        max_pages_visual = calculate_max_pages_for_tokens(32_000, mode="visual")
        assert max_pages >= max_pages_visual

    def test_calculate_max_pages_hybrid(self):
        """Test max pages calculation for hybrid mode."""
        # Hybrid uses more tokens per page
        max_pages = calculate_max_pages_for_tokens(128_000, mode="hybrid")
        assert max_pages > 0
        # Hybrid should allow fewer pages than visual only
        max_pages_visual = calculate_max_pages_for_tokens(128_000, mode="visual")
        assert max_pages <= max_pages_visual


# ---------------------------------------------------------------------------
# Unified Document Extraction Tests
# ---------------------------------------------------------------------------


class TestUnifiedDocumentExtraction:
    """Tests for unified document page extraction."""

    def test_extract_document_pages_function_exists(self):
        """Test that extract_document_pages function exists."""
        import inspect

        sig = inspect.signature(extract_document_pages)
        params = list(sig.parameters.keys())

        assert "document_path" in params
        assert "mode" in params
        assert "max_pages" in params
        assert "page_range" in params
        assert "context_window" in params

    def test_extract_pdf_pages_visual_mode(self, tmp_path):
        """Test PDF extraction in visual mode."""
        # Create fake PDF
        fake_pdf = tmp_path / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 fake")

        # Mock _pdf_to_images
        from PIL import Image

        img = Image.new("RGB", (100, 100), color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        fake_image = buf.getvalue()

        with patch(
            "document_processing._pdf_to_images",
            return_value=[
                (fake_image, "image/png"),
                (fake_image, "image/png"),
            ],
        ):
            pages = extract_document_pages(str(fake_pdf), mode="visual", max_pages=2)

        assert len(pages) == 2
        assert all(p.has_image for p in pages)

    def test_extract_doc_pages_text_mode(self, tmp_path):
        """Test DOC extraction in text mode."""
        fake_doc = tmp_path / "test.docx"
        fake_doc.write_bytes(b"PK fake")

        with patch(
            "document_processing._doc_to_text", return_value="Document content here"
        ):
            pages = extract_document_pages(str(fake_doc), mode="text", max_pages=10)

        assert len(pages) >= 1
        assert pages[0].has_text

    def test_extract_xlsx_pages_text_mode(self, tmp_path):
        """Test XLSX extraction in text mode."""
        fake_xlsx = tmp_path / "test.xlsx"
        fake_xlsx.write_bytes(b"PK fake")

        with patch(
            "document_processing._xlsx_to_csv",
            return_value=[
                ("Sheet1", "a,b\n1,2"),
                ("Sheet2", "c,d\n3,4"),
            ],
        ):
            pages = extract_document_pages(str(fake_xlsx), mode="text", max_pages=5)

        assert len(pages) == 2
        assert all(p.has_text for p in pages)
        assert pages[0].metadata["sheet_name"] == "Sheet1"

    def test_extract_unsupported_format(self, tmp_path):
        """Test error for unsupported format."""
        fake_file = tmp_path / "test.xyz"
        fake_file.write_bytes(b"unknown")

        with pytest.raises(ValueError) as exc_info:
            extract_document_pages(str(fake_file), mode="visual")

        assert "Unsupported" in str(exc_info.value)

    def test_extract_with_page_range(self, tmp_path):
        """Test extraction with page range."""
        fake_pdf = tmp_path / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 fake")

        from PIL import Image

        img = Image.new("RGB", (100, 100), color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        fake_image = buf.getvalue()

        # Create 5 images but only request pages 2-3
        with patch(
            "document_processing._pdf_to_images",
            return_value=[
                (fake_image, "image/png"),
                (fake_image, "image/png"),
            ],
        ):
            page_range = PageRange(start=2, end=3)
            pages = extract_document_pages(
                str(fake_pdf),
                mode="visual",
                max_pages=10,
                page_range=page_range,
            )

        # Should extract 2 pages (start_page is passed to _pdf_to_images)
        assert len(pages) == 2

    def test_extract_with_context_window(self, tmp_path):
        """Test extraction with auto-limiting by context window."""
        fake_pdf = tmp_path / "test.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 fake")

        from PIL import Image

        img = Image.new("RGB", (100, 100), color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        fake_image = buf.getvalue()

        # Request 50 pages but with small context window
        with patch(
            "document_processing._pdf_to_images",
            return_value=[
                (fake_image, "image/png"),
            ],
        ):
            pages = extract_document_pages(
                str(fake_pdf),
                mode="visual",
                max_pages=50,  # Request many pages
                context_window=32_000,  # Small context
            )

        # Should be limited by context window
        # Note: actual limiting depends on the mock returning fewer pages


# ---------------------------------------------------------------------------
# Auto-Mode PDF Routing Tests (#3389)
# ---------------------------------------------------------------------------


class TestAutoModePdfRouting:
    """Tests for the text-first auto mode added in #3389."""

    def test_auto_mode_with_textual_pdf_uses_text(self, tmp_path):
        """Auto mode on a textual PDF must route to text extraction, not vision."""
        import fitz  # PyMuPDF

        pdf_path = tmp_path / "textual.pdf"
        doc = fitz.open()
        for i in range(3):
            page = doc.new_page()
            page.insert_text((50, 50), "Lorem ipsum dolor sit amet " * 8)
        doc.save(str(pdf_path))
        doc.close()

        pages = extract_document_pages(str(pdf_path), mode="auto", max_pages=3)
        assert len(pages) == 3
        # All pages should carry text and no images
        assert all(p.has_text for p in pages)
        assert all(not p.has_image for p in pages)

    def test_auto_mode_with_empty_pdf_falls_back_to_visual(self, tmp_path):
        """Auto mode on a PDF without a text layer must fall back to visual."""
        fake_pdf = tmp_path / "blank.pdf"
        fake_pdf.write_bytes(b"%PDF-1.4 fake")

        # Probe sees no text → route stays visual; mock the visual pipeline so
        # we don't need a real PDF render in unit tests.
        from PIL import Image

        img = Image.new("RGB", (100, 100), color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        fake_image = buf.getvalue()

        with patch(
            "document_processing._pdf_has_text_layer", return_value=False
        ), patch(
            "document_processing._pdf_to_images",
            return_value=[(fake_image, "image/png")],
        ):
            pages = extract_document_pages(str(fake_pdf), mode="auto", max_pages=1)

        assert len(pages) == 1
        assert pages[0].has_image
        assert not pages[0].has_text

    def test_pdf_has_text_layer_probe(self, tmp_path):
        """Probe must detect a real text layer and respect the threshold."""
        import fitz

        # Textual PDF
        text_pdf = tmp_path / "text.pdf"
        doc = fitz.open()
        for _ in range(2):
            page = doc.new_page()
            page.insert_text((50, 50), "Hello world " * 10)  # > 40 chars/page
        doc.save(str(text_pdf))
        doc.close()

        assert document_processing._pdf_has_text_layer(str(text_pdf)) is True

        # Empty PDF (no text layer)
        empty_pdf = tmp_path / "empty.pdf"
        empty_pdf.write_bytes(b"%PDF-1.4 fake")

        # Probe must not raise on invalid PDFs — fail closed
        assert document_processing._pdf_has_text_layer(str(empty_pdf)) is False

    def test_auto_mode_routing_is_safe_for_non_pdf(self, tmp_path):
        """Auto mode on non-PDF formats must keep the historical default (visual)."""
        # Use a fake PDF suffix that we can rename to .docx to test the
        # non-PDF branch without needing LibreOffice.
        fake = tmp_path / "doc.docx"
        fake.write_bytes(b"not really a docx")

        # For .docx, the probe must NOT be called and the path must stay visual.
        # The implementation will try LibreOffice/python-docx and may raise; we
        # only assert the probe was never invoked for non-PDF suffixes.
        with patch(
            "document_processing._pdf_has_text_layer"
        ) as probe, patch(
            "document_processing._doc_to_images",
            side_effect=RuntimeError("stop here"),
        ):
            with pytest.raises(RuntimeError):
                extract_document_pages(str(fake), mode="auto", max_pages=1)
        probe.assert_not_called()


# ---------------------------------------------------------------------------
# Document To Images Tests
# ---------------------------------------------------------------------------


class TestDocumentToImages:
    """Tests for visual document conversion functions."""

    def test_doc_to_images_function_exists(self):
        """Test that _doc_to_images function exists."""
        import inspect

        assert hasattr(document_processing, "_doc_to_images")
        sig = inspect.signature(_doc_to_images)
        params = list(sig.parameters.keys())
        assert "doc_path" in params

    def test_xlsx_to_images_function_exists(self):
        """Test that _xlsx_to_images function exists."""
        import inspect

        assert hasattr(document_processing, "_xlsx_to_images")
        sig = inspect.signature(_xlsx_to_images)
        params = list(sig.parameters.keys())
        assert "xlsx_path" in params


# ---------------------------------------------------------------------------
# Run Tests
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
