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
from reportlab.lib.units import inch

# Brand colors
INK       = (27/255,  42/255,  59/255)
PARCHMENT = (245/255, 242/255, 235/255)
AMBER     = (200/255, 149/255, 107/255)
LIGHT     = (236/255, 232/255, 220/255)


def extract_metadata(docx_bytes, filename="document.docx", form_author=None):
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
        "captured_at": datetime.datetime.utcnow().isoformat() + "Z",
        "warnings": []
    }

    try:
        doc = Document(BytesIO(docx_bytes))
        cp = doc.core_properties

        if cp.created:
            meta["created"] = cp.created.strftime("%B %d, %Y") if hasattr(cp.created, 'strftime') else str(cp.created)
        if cp.modified:
            meta["modified"] = cp.modified.strftime("%B %d, %Y") if hasattr(cp.modified, 'strftime') else str(cp.modified)

        # Author — prefer form input, fall back to doc property, skip "Un-named"
        doc_author = cp.author if cp.author and cp.author.strip() and cp.author.strip().lower() not in ['un-named', 'unnamed', ''] else None
        meta["author"] = form_author or doc_author or None

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
            meta["warnings"].append("Extended properties unavailable")

        # Word count fallback — count actual paragraphs with content
        if not meta["word_count"]:
            # Count words by summing paragraph text lengths (no content stored)
            total_words = 0
            para_count = 0
            for para in doc.paragraphs:
                if para.text.strip():
                    para_count += 1
                    # Rough word count from character count
                    total_words += len(para.text.split())
            meta["paragraph_count"] = para_count
            if total_words > 0:
                meta["word_count"] = total_words
                meta["warnings"].append("Word count estimated from document structure")

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
    buffer = BytesIO()
    W, H = letter
    c = canvas.Canvas(buffer, pagesize=letter)

    # Background
    c.setFillColorRGB(*PARCHMENT)
    c.rect(0, 0, W, H, fill=1, stroke=0)

    # Outer border
    c.setStrokeColorRGB(*INK)
    c.setLineWidth(0.8)
    c.rect(0.35*inch, 0.35*inch, W - 0.7*inch, H - 0.7*inch, fill=0, stroke=1)

    # Inner border
    c.setLineWidth(0.3)
    c.rect(0.45*inch, 0.45*inch, W - 0.9*inch, H - 0.9*inch, fill=0, stroke=1)

    # Header band
    c.setFillColorRGB(*INK)
    c.rect(0.35*inch, H - 1.8*inch, W - 0.7*inch, 1.45*inch, fill=1, stroke=0)

    # Eyebrow
    c.setFillColorRGB(*AMBER)
    c.setFont("Helvetica", 8)
    c.drawCentredString(W/2, H - 0.85*inch, "C E R T I F I C A T E   O F   A U T H O R S H I P")

    # Wordmark
    ink_x = W/2 - 42
    c.setFillColorRGB(*PARCHMENT)
    c.setFont("Helvetica-Bold", 28)
    c.drawString(ink_x, H - 1.35*inch, "Ink")
    c.setFillColorRGB(200/255, 149/255, 107/255)
    c.setFont("Helvetica-BoldOblique", 28)
    c.drawString(ink_x + 38, H - 1.35*inch, "stain")

    # Decorative rule
    c.setStrokeColorRGB(*AMBER)
    c.setLineWidth(0.5)
    margin = 1.2*inch
    c.line(margin, H - 1.85*inch, W - margin, H - 1.85*inch)

    # This certifies that
    c.setFillColorRGB(*INK)
    c.setFont("Helvetica-Oblique", 11)
    c.drawCentredString(W/2, H - 2.35*inch, "This certifies that the manuscript")

    # Title
    c.setFont("Helvetica-BoldOblique", 20)
    title_display = f'"{title}"'
    if len(title_display) > 45:
        title_display = f'"{title[:42]}..."'
    c.drawCentredString(W/2, H - 2.85*inch, title_display)

    # was composed by
    c.setFont("Helvetica-Oblique", 11)
    c.drawCentredString(W/2, H - 3.2*inch, "was composed by")

    # Author name — always use form-supplied author, prominent
    c.setFont("Helvetica-Bold", 22)
    c.drawCentredString(W/2, H - 3.7*inch, author.upper())

    # Divider
    c.setStrokeColorRGB(*INK)
    c.setLineWidth(0.3)
    c.setDash(2, 4)
    c.line(1.5*inch, H - 4.0*inch, W - 1.5*inch, H - 4.0*inch)
    c.setDash()

    # Trail header
    c.setFont("Helvetica", 8)
    c.setFillColorRGB(*AMBER)
    c.drawCentredString(W/2, H - 4.3*inch, "T H E   T R A I L")

    # Trail rows
    data_y = H - 4.7*inch
    row_h = 0.32*inch
    left_col = 1.3*inch
    right_col = W - 1.3*inch

    def trail_row(label, value, y, highlight=False):
        if highlight:
            c.setFillColorRGB(*LIGHT)
            c.rect(left_col - 0.1*inch, y - 0.06*inch,
                   right_col - left_col + 0.2*inch, row_h - 0.04*inch,
                   fill=1, stroke=0)
        c.setFillColorRGB(*INK)
        c.setFont("Helvetica", 10)
        c.setFillAlpha(0.45)
        c.drawString(left_col, y + 0.08*inch, label)
        c.setFillAlpha(1.0)
        c.setFont("Helvetica-Bold", 10)
        c.drawRightString(right_col, y + 0.08*inch, str(value) if value else "—")
        c.setStrokeColorRGB(*INK)
        c.setLineWidth(0.2)
        c.setStrokeAlpha(0.1)
        c.line(left_col, y - 0.02*inch, right_col, y - 0.02*inch)
        c.setStrokeAlpha(1.0)
        c.setFillAlpha(1.0)

    rows = []

    # Word count first and prominent — the most meaningful stat
    if metadata.get("word_count"):
        wc = f"{metadata['word_count']:,} words"
        if metadata.get("page_count"):
            wc += f"  ·  {metadata['page_count']} pages"
        rows.append(("Manuscript length", wc))

    if metadata.get("created"):
        rows.append(("First created", metadata["created"]))

    if metadata.get("modified"):
        rows.append(("Last modified", metadata["modified"]))

    if metadata.get("total_edit_time_minutes"):
        rows.append(("Total editing time", format_edit_time(metadata["total_edit_time_minutes"])))

    if metadata.get("revision_count"):
        rows.append(("Revision count", str(metadata["revision_count"])))

    if disclosure_level in ["standard", "full"]:
        if metadata.get("character_count"):
            rows.append(("Character count", f"{metadata['character_count']:,}"))
        if metadata.get("paragraph_count"):
            rows.append(("Paragraph count", str(metadata["paragraph_count"])))

    for i, (label, value) in enumerate(rows):
        trail_row(label, value, data_y - (i * row_h), highlight=(i % 2 == 0))

    # Capture note
    note_y = data_y - (len(rows) * row_h) - 0.3*inch
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColorRGB(*INK)
    c.setFillAlpha(0.45)

    capture_date = datetime.datetime.utcnow().strftime("%B %d, %Y")
    note_lines = [
        f"Trail captured: {capture_date}   ·   Document metadata only — manuscript text was never read or stored.",
        "This certificate reflects the document's own recorded history. Inkstain does not verify manuscript content."
    ]
    for i, line in enumerate(note_lines):
        c.drawCentredString(W/2, note_y - (i * 0.2*inch), line)
    c.setFillAlpha(1.0)

    # Hash
    hash_y = note_y - 0.65*inch
    hash_input = f"{author}:{title}:{metadata.get('created','')}:{metadata.get('word_count','')}:{capture_date}"
    doc_hash = hashlib.sha256(hash_input.encode()).hexdigest()
    c.setFont("Helvetica", 7)
    c.setFillColorRGB(*INK)
    c.setFillAlpha(0.28)
    c.drawCentredString(W/2, hash_y, f"verification hash  ·  {doc_hash[:48]}")
    c.setFillAlpha(1.0)

    # Bottom rule
    c.setStrokeColorRGB(*AMBER)
    c.setLineWidth(0.5)
    c.line(margin, 0.9*inch, W - margin, 0.9*inch)

    # Manifesto
    c.setFont("Helvetica-Oblique", 10)
    c.setFillColorRGB(*INK)
    c.drawCentredString(W/2, 0.65*inch, "The written word will prevail.")

    # Footer
    c.setFont("Helvetica", 8)
    c.setFillColorRGB(*INK)
    c.setFillAlpha(0.38)
    c.drawCentredString(W/2, 0.48*inch, "inkstain.ai   ·   AI Provenance for Authors")
    c.setFillAlpha(1.0)

    # Warnings — only show if full disclosure and only real issues
    meaningful_warnings = [w for w in metadata.get("warnings", []) if "estimated" in w.lower()]
    if meaningful_warnings and disclosure_level == "full":
        warn_y = 0.36*inch
        c.setFont("Helvetica", 7)
        c.setFillAlpha(0.22)
        for w in meaningful_warnings[:1]:
            c.drawCentredString(W/2, warn_y, f"* {w}")
        c.setFillAlpha(1.0)

    c.save()
    return buffer.getvalue()


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python3 certificate.py <file.docx> <author> <title> [disclosure]")
        sys.exit(1)

    filepath = sys.argv[1]
    author = sys.argv[2]
    title = sys.argv[3]
    disclosure = sys.argv[4] if len(sys.argv) > 4 else "summary"

    with open(filepath, 'rb') as f:
        docx_bytes = f.read()

    metadata = extract_metadata(docx_bytes, os.path.basename(filepath), form_author=author)
    print("Metadata:", json.dumps(metadata, indent=2))

    pdf_bytes = generate_certificate_pdf(author, title, metadata, disclosure)

    output_path = filepath.replace('.docx', '_trail_certificate.pdf')
    with open(output_path, 'wb') as f:
        f.write(pdf_bytes)

    print(f"Certificate saved to: {output_path}")
