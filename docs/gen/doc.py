"""Document template: page frames, footers, TOC notification, PDF outline."""
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph
from reportlab.platypus.tableofcontents import TableOfContents

from style import MARGIN, NAVY, GRAYTXT, BORDER, PAGE_W, PAGE_H

FOOT_LEFT = "interface.ai take-home - Computer-Use Automation System - Implementation & Design Plan"


def _footer(canv, doc):
    canv.saveState()
    canv.setStrokeColor(BORDER)
    canv.setLineWidth(0.5)
    canv.line(MARGIN, 40, PAGE_W - MARGIN, 40)
    canv.setFont("Helvetica", 7)
    canv.setFillColor(GRAYTXT)
    canv.drawString(MARGIN, 30, FOOT_LEFT)
    canv.drawRightString(PAGE_W - MARGIN, 30, "Page %d" % canv.getPageNumber())
    canv.restoreState()


def _cover_page(canv, doc):
    canv.saveState()
    canv.setFillColor(NAVY)
    canv.rect(0, PAGE_H - 26, PAGE_W, 26, stroke=0, fill=1)
    canv.setFillColor(NAVY)
    canv.rect(0, 0, PAGE_W, 18, stroke=0, fill=1)
    canv.restoreState()


class PlanDoc(BaseDocTemplate):
    def __init__(self, filename, **kw):
        super().__init__(filename, pagesize=(PAGE_W, PAGE_H),
                         leftMargin=MARGIN, rightMargin=MARGIN,
                         topMargin=MARGIN, bottomMargin=56, **kw)
        frame = Frame(MARGIN, 56, PAGE_W - 2 * MARGIN, PAGE_H - MARGIN - 56,
                      id="main")
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[frame], onPage=_cover_page),
            PageTemplate(id="body", frames=[frame], onPage=_footer),
        ])
        self._outline_n = 0

    def afterFlowable(self, flowable):
        if not isinstance(flowable, Paragraph):
            return
        name = flowable.style.name
        if name not in ("H1", "H2"):
            return
        text = flowable.getPlainText()
        if text == "Contents":
            return
        level = 0 if name == "H1" else 1
        self.notify("TOCEntry", (level, text, self.page))
        if name == "H1":
            self._outline_n += 1
            key = "s%d" % self._outline_n
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=0, closed=False)


def make_toc():
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle("TOC0", fontName="Helvetica-Bold", fontSize=9.6,
                       leading=13.5, textColor=NAVY, leftIndent=2),
        ParagraphStyle("TOC1", fontName="Helvetica", fontSize=8.6, leading=12,
                       textColor=GRAYTXT, leftIndent=16),
    ]
    toc.dotsMinLevel = 0
    return toc
