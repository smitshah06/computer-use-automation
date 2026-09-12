"""Builds Implementation_Design_Plan.pdf. Run: python3 docs/generate_plan_pdf.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "gen"))

from doc import PlanDoc  # noqa: E402
import sec_front, sec_mid, sec_back  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "..", "Implementation_Design_Plan.pdf")


def main():
    story = []
    story += sec_front.cover()
    story += sec_front.toc_page()
    story += sec_front.sec1()
    story += sec_front.sec2()
    story += sec_front.sec3()
    story += sec_front.sec4()
    story += sec_mid.sec5()
    story += sec_mid.sec6()
    story += sec_mid.sec7()
    story += sec_mid.sec8()
    story += sec_mid.sec9()
    story += sec_back.sec10()
    story += sec_back.sec11()
    story += sec_back.sec12()
    story += sec_back.sec13()
    story += sec_back.sec14()
    story += sec_back.sec15()
    story += sec_back.appendices()

    doc = PlanDoc(os.path.abspath(OUT),
                  title="Computer-Use Automation System - Implementation & Design Plan",
                  author="interface.ai take-home submission")
    doc.multiBuild(story)
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
