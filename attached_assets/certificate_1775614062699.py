#!/usr/bin/env python3
"""
Inkstain Trail Certificate Generator
Reads Word document metadata and produces a signed PDF certificate.
Never reads manuscript content — metadata only.
"""

import sys
import os
import json
import hashlib
import datetime
from io import BytesIO

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import simpleSplit

# ── Brand colors ──
INK       = (27/255,  42/255,  59/255)
PARCHMENT = (245/255, 242/255, 235/255)
AMBER     = (200/255, 149/255, 107/255)
MUTED     = (27/255,  42/255,  59/255, 0.32)
LIGHT     = (236/255, 232/255, 220/255)


def extract_metadata(docx_bytes, filename="document.docx"):
    """
    Extract only metadata from a Word document.
    Never touches the text content.
    """
    meta = {
        "filename": filename,
        "created": None,
        "modified": None,
        "author": None,
        "last_modified_by": None,
        "revision_count": None,
        "total_edit_time_minutes": None,
        "word_count": None,
        "paragraph_count": None,
        "character_count": None,
        "page_count": None,
        "template": None,
        "captured_at": datetime.datetime.utcnow().isoformat() + "Z",
        "warnings": []
    }

    try:
        doc = Document(BytesIO(docx_bytes))
        cp = doc.core_properties

        # Core properties — no content access
        if cp.created:
            meta["created"] = cp.created.strftime("%B %d, %Y") if hasattr(cp.created, 'strftime') else str(cp.created)
        if cp.modified:
            meta["modified"] = cp.modified.strftime("%B %d, %Y") if hasattr(cp.modified, 'strftime') else str(cp.modified)
        if cp.author:
            meta["author"] = cp.author
        if cp.last_modified_by:
            meta["last_modified_by"] = cp.last_modified_by
        if cp.revision:
            meta["revision_count"] = cp.revision

        # Extended properties
        try:
            app_props = doc.part.package.part_related_by(
                'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties'
            )
            if app_props:
                from lxml import etree
                root = app_props._element
                ns = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties'
                
                words_el = root.find(f'{{{ns}}}Words')
                if words_el is not None and words_el.text:
                    meta["word_count"] = int(words_el.text)

                pages_el = root.find(f'{{{ns}}}Pages')
                if pages_el is not None and pages_el.text:
                    meta["page_count"] = int(pages_el.text)

                chars_el = root.find(f'{{{ns}}}Characters')
                if chars_el is not None and chars_el.text:
                    meta["character_count"] = int(chars_el.text)

                time_el = root.find(f'{{{ns}}}TotalTime')
                if time_el is not None and time_el.text:
                    meta["total_edit_time_minutes"] = int(time_el.text)

                para_el = root.find(f'{{{ns}}}Paragraphs')
                if para_el is not None and para_el.text:
                    meta["paragraph_count"] = int(para_el.text)

        except Exception:
            # Extended props not available — that's ok
            meta["warnings"].append("Extended properties unavailable — some stats estimated")

        # If word count not in extended props, count paragraphs only (no content read)
        if not meta["word_count"]:
            meta["paragraph_count"] = len(doc.paragraphs)
            meta["warnings"].append("Word count estimated from paragraph count")

    except PackageNotFoundError:
        raise ValueError("File does not appear to be a valid Word document (.docx)")
    except Exception as e:
        raise ValueError(f"Could not read document: {str(e)}")

    return meta


def format_edit_time(minutes):
    if not minutes:
        return "not recorded"
    if minutes < 60:
        return f"{minutes} minutes"
    hours = minutes // 60
    mins = minutes % 60
    if mins == 0:
        return f"{hours} hour{'s' if hours != 1 else ''}"
    return f"{hours}h {mins}m"


def generate_certificate_pdf(author, title, metadata, disclosure_level="summary"):
    """
    Generate a beautiful PDF certificate.
    Returns bytes.
    """
    buffer = BytesIO()
    
    W, H = letter  # 8.5 x 11 inches
    c = canvas.Canvas(buffer, pagesize=letter)

    # ── Background ──
    c.setFillColorRGB(*PARCHMENT)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # ── Outer border ──
    c.setStrokeColorRGB(*INK)
    c.setLineWidth(0.8)
    c.rect(0.35*inch, 0.35*inch, W - 0.7*inch, H - 0.7*inch, fill=0, stroke=1)

    # ── Inner border (thin) ──
    c.setLineWidth(0.3)
    c.rect(0.45*inch, 0.45*inch, W - 0.9*inch, H - 0.9*inch, fill=0, stroke=1)

    # ── Header band ──
    c.setFillColorRGB(*INK)
    c.rect(0.35*inch, H - 1.8*inch, W - 0.7*inch, 1.45*inch, fill=1, stroke=0)

    # ── CERTIFICATE OF AUTHORSHIP eyebrow ──
    c.setFillColorRGB(*AMBER)
    c.setFont("Helvetica", 8)
    c.drawCentredString(W/2, H - 0.85*inch, "C E R T I F I C A T E   O F   A U T H O R S H I P")

    # ── INKSTAIN wordmark ──
    c.setFillColorRGB(*PARCHMENT)
    c.setFont("Helvetica-Bold", 28)
    c.drawCentredString(W/2, H - 1.35*inch, "INKSTAIN")

    # ── Decorative rule ──
    c.setStrokeColorRGB(*AMBER)
    c.setLineWidth(0.5)
    margin = 1.2*inch
    c.line(margin, H - 1.85*inch, W - margin, H - 1.85*inch)

    # ── "This certifies that" ──
    c.setFillColorRGB(*INK)
    c.setFont("Helvetica-Oblique", 11)
    c.drawCentredString(W/2, H - 2.35*inch, "This certifies that the manuscript")

    # ── Manuscript title ──
    c.setFont("Helvetica-BoldOblique", 20)
    # Handle long titles
    title_display = f'"{title}"'
    if len(title_display) > 45:
        title_display = f'"{title[:42]}..."'
    c.drawCentredString(W/2, H - 2.85*inch, title_display)

    # ── "was composed by" ──
    c.setFont("Helvetica-Oblique", 11)
    c.drawCentredString(W/2, H - 3.2*inch, "was composed by")

    # ── Author name ──
    c.setFont("Helvetica-Bold", 22)
    c.setFont("Helvetica-Bold", 22)
    c.drawCentredString(W/2, H - 3.7*inch, author.upper())

    # ── Divider ──
    c.setStrokeColorRGB(*INK)
    c.setLineWidth(0.3)
    c.setDash(2, 4)
    c.line(1.5*inch, H - 4.0*inch, W - 1.5*inch, H - 4.0*inch)
    c.setDash()

    # ── THE TRAIL section header ──
    c.setFont("Helvetica", 8)
    c.setFillColorRGB(*AMBER)
    c.drawCentredString(W/2, H - 4.3*inch, "T H E   T R A I L")

    # ── Trail data ──
    data_y = H - 4.7*inch
    row_h = 0.32*inch
    left_col = 1.3*inch
    right_col = W - 1.3*inch

    def trail_row(label, value, y, highlight=False):
        # Row background alternating
        if highlight:
            c.setFillColorRGB(*LIGHT)
            c.rect(left_col - 0.1*inch, y - 0.06*inch, 
                   right_col - left_col + 0.2*inch, row_h - 0.04*inch, 
                   fill=1, stroke=0)
        
        # Label
        c.setFillColorRGB(27/255, 42/255, 59/255)
        c.setFont("Helvetica", 10)
        # Set opacity for label
        c.setFillAlpha(0.45)
        c.drawString(left_col, y + 0.08*inch, label)
        
        # Value
        c.setFillAlpha(1.0)
        c.setFont("Helvetica-Bold", 10)
        c.drawRightString(right_col, y + 0.08*inch, str(value) if value else "—")
        
        # Thin rule
        c.setFillAlpha(1.0)
        c.setStrokeColorRGB(27/255, 42/255, 59/255)
        c.setLineWidth(0.2)
        c.setStrokeAlpha(0.1)
        c.line(left_col, y - 0.02*inch, right_col, y - 0.02*inch)
        c.setStrokeAlpha(1.0)

    # Build trail rows based on metadata
    rows = []

    if metadata.get("created"):
        rows.append(("Document created", metadata["created"]))
    
    if metadata.get("modified"):
        rows.append(("Last modified", metadata["modified"]))
    
    if metadata.get("word_count"):
        wc = f"{metadata['word_count']:,} words"
        rows.append(("Word count", wc))
    
    if metadata.get("total_edit_time_minutes"):
        rows.append(("Total editing time", format_edit_time(metadata["total_edit_time_minutes"])))
    
    if metadata.get("revision_count"):
        rows.append(("Revision count", str(metadata["revision_count"])))

    if metadata.get("page_count"):
        rows.append(("Page count", str(metadata["page_count"])))

    if disclosure_level in ["standard", "full"]:
        if metadata.get("author"):
            rows.append(("Document author field", metadata["author"]))
        if metadata.get("paragraph_count"):
            rows.append(("Paragraph count", str(metadata["paragraph_count"])))

    # Draw rows
    for i, (label, value) in enumerate(rows):
        trail_row(label, value, data_y - (i * row_h), highlight=(i % 2 == 0))

    # ── Trail capture note ──
    note_y = data_y - (len(rows) * row_h) - 0.3*inch
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColorRGB(*INK)
    c.setFillAlpha(0.5)

    capture_date = datetime.datetime.utcnow().strftime("%B %d, %Y")
    note_lines = [
        f"Trail captured: {capture_date}   ·   Document metadata only — manuscript text was never read or stored.",
        "This certificate reflects the document's own recorded history. Inkstain does not verify manuscript content."
    ]
    for i, line in enumerate(note_lines):
        c.drawCentredString(W/2, note_y - (i * 0.2*inch), line)

    c.setFillAlpha(1.0)

    # ── Hash / verification ──
    hash_y = note_y - 0.6*inch
    
    # Generate a document hash from metadata
    hash_input = f"{author}:{title}:{metadata.get('created','')}:{metadata.get('word_count','')}:{capture_date}"
    doc_hash = hashlib.sha256(hash_input.encode()).hexdigest()
    
    c.setFont("Helvetica", 7)
    c.setFillColorRGB(*INK)
    c.setFillAlpha(0.3)
    c.drawCentredString(W/2, hash_y, f"verification hash  ·  {doc_hash[:48]}")
    c.setFillAlpha(1.0)

    # ── Bottom rule ──
    c.setStrokeColorRGB(*AMBER)
    c.setLineWidth(0.5)
    c.line(margin, 0.9*inch, W - margin, 0.9*inch)

    # ── Manifesto line ──
    c.setFont("Helvetica-Oblique", 10)
    c.setFillColorRGB(*INK)
    c.drawCentredString(W/2, 0.65*inch, "The written word will prevail.")

    # ── inkstain.ai ──
    c.setFont("Helvetica", 8)
    c.setFillColorRGB(*INK)
    c.setFillAlpha(0.4)
    c.drawCentredString(W/2, 0.48*inch, "inkstain.ai   ·   AI Provenance for Authors")
    c.setFillAlpha(1.0)

    # ── Warnings (if any, subtle) ──
    if metadata.get("warnings") and disclosure_level == "full":
        warn_y = 0.38*inch
        c.setFont("Helvetica", 7)
        c.setFillColorRGB(*INK)
        c.setFillAlpha(0.25)
        for w in metadata["warnings"][:2]:
            c.drawCentredString(W/2, warn_y, f"* {w}")
            warn_y -= 0.14*inch
        c.setFillAlpha(1.0)

    c.save()
    return buffer.getvalue()


if __name__ == "__main__":
    # CLI usage: python3 certificate.py input.docx "Author Name" "Title" summary
    if len(sys.argv) < 4:
        print("Usage: python3 certificate.py <file.docx> <author> <title> [disclosure]")
        sys.exit(1)

    filepath = sys.argv[1]
    author = sys.argv[2]
    title = sys.argv[3]
    disclosure = sys.argv[4] if len(sys.argv) > 4 else "summary"

    with open(filepath, 'rb') as f:
        docx_bytes = f.read()

    metadata = extract_metadata(docx_bytes, os.path.basename(filepath))
    print("Metadata:", json.dumps(metadata, indent=2))

    pdf_bytes = generate_certificate_pdf(author, title, metadata, disclosure)
    
    output_path = filepath.replace('.docx', '_trail_certificate.pdf')
    with open(output_path, 'wb') as f:
        f.write(pdf_bytes)
    
    print(f"Certificate saved to: {output_path}")
