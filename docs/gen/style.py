"""Shared styles and flowable helpers for the design-plan PDF."""
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph, Preformatted, Spacer, Table, TableStyle, CondPageBreak,
)

NAVY = HexColor("#16325C")
TEAL = HexColor("#0E7C86")
LIGHT = HexColor("#EEF2F7")
CODEBG = HexColor("#F5F7FA")
BORDER = HexColor("#C9D4E0")
GRAYTXT = HexColor("#5A6B7B")
ROWALT = HexColor("#F7FAFC")

PAGE_W, PAGE_H = letter
MARGIN = 54
CONTENT_W = PAGE_W - 2 * MARGIN  # 504pt

S_TITLE = ParagraphStyle("TitleX", fontName="Helvetica-Bold", fontSize=25,
                         leading=30, textColor=NAVY)
S_SUB = ParagraphStyle("SubX", fontName="Helvetica", fontSize=13, leading=17,
                       textColor=GRAYTXT)
S_H1 = ParagraphStyle("H1", fontName="Helvetica-Bold", fontSize=15.5, leading=19,
                      textColor=NAVY, spaceBefore=10, spaceAfter=7)
S_H2 = ParagraphStyle("H2", fontName="Helvetica-Bold", fontSize=11.5, leading=15,
                      textColor=TEAL, spaceBefore=11, spaceAfter=4)
S_H3 = ParagraphStyle("H3", fontName="Helvetica-Bold", fontSize=9.8, leading=13,
                      textColor=NAVY, spaceBefore=8, spaceAfter=3)
S_BODY = ParagraphStyle("BodyX", fontName="Helvetica", fontSize=9.3, leading=12.6,
                        textColor=colors.black, spaceAfter=5)
S_SERVES = ParagraphStyle("Serves", fontName="Helvetica-Oblique", fontSize=8.2,
                          leading=10.5, textColor=GRAYTXT, spaceAfter=6)
S_BULL = ParagraphStyle("BullX", fontName="Helvetica", fontSize=9.3, leading=12.4,
                        leftIndent=14, bulletIndent=4, spaceAfter=2.5)
S_CODE = ParagraphStyle("CodeX", fontName="Courier", fontSize=7.6, leading=9.4)
S_CODE_SM = ParagraphStyle("CodeSm", fontName="Courier", fontSize=7.1, leading=8.8)
S_CELL = ParagraphStyle("Cell", fontName="Helvetica", fontSize=8.2, leading=10.4)
S_CELL_B = ParagraphStyle("CellB", fontName="Helvetica-Bold", fontSize=8.2,
                          leading=10.4)
S_CELL_H = ParagraphStyle("CellH", fontName="Helvetica-Bold", fontSize=8.4,
                          leading=10.6, textColor=colors.white)
S_QUOTE = ParagraphStyle("QuoteX", fontName="Helvetica-BoldOblique", fontSize=10.5,
                         leading=14.5, textColor=NAVY)
S_CALL_T = ParagraphStyle("CallT", fontName="Helvetica-Bold", fontSize=9.0,
                          leading=11.5, textColor=NAVY)
S_CALL_B = ParagraphStyle("CallB", fontName="Helvetica", fontSize=8.7,
                          leading=11.4)


def P(text, style=S_BODY):
    return Paragraph(text, style)


def serves(text):
    return Paragraph("Serves evaluation criteria: " + text, S_SERVES)


def H1(text):
    return Paragraph(text, S_H1)


def H2(text):
    return Paragraph(text, S_H2)


def H3(text):
    return Paragraph(text, S_H3)


def bull(items, style=S_BULL):
    return [Paragraph(t, style, bulletText="•") for t in items]


def sp(h=5):
    return Spacer(1, h)


def cpb(h=150):
    return CondPageBreak(h)


def _code_table(text, style):
    pre = Preformatted(text, style)
    t = Table([[pre]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODEBG),
        ("BOX", (0, 0), (-1, -1), 0.7, BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def code(text, small=False, chunk=40):
    """Boxed monospace block; long blocks are chunked so they can page-break."""
    style = S_CODE_SM if small else S_CODE
    lines = text.strip("\n").split("\n")
    out = []
    for i in range(0, len(lines), chunk):
        out.append(_code_table("\n".join(lines[i:i + chunk]), style))
        if i + chunk < len(lines):
            out.append(Spacer(1, 2))
    return out


def callout(title, body_lines):
    """Accent box used for decision rationales."""
    rows = [[Paragraph(title, S_CALL_T)]]
    for ln in body_lines:
        rows.append([Paragraph(ln, S_CALL_B)])
    t = Table(rows, colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LIGHT),
        ("LINEBEFORE", (0, 0), (0, -1), 2.5, TEAL),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (0, 0), 6),
        ("TOPPADDING", (0, 1), (-1, -1), 2),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -2), 2),
    ]))
    return t


def tbl(headers, rows, widths, header_bg=NAVY, bold_first_col=False):
    """Styled table; all cells wrapped as Paragraphs for line wrapping."""
    data = [[Paragraph(h, S_CELL_H) for h in headers]]
    for r in rows:
        cells = []
        for j, c in enumerate(r):
            st = S_CELL_B if (bold_first_col and j == 0) else S_CELL
            cells.append(Paragraph(c, st))
        data.append(cells)
    t = Table(data, colWidths=widths, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), header_bg),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), ROWALT))
    t.setStyle(TableStyle(style))
    return t
