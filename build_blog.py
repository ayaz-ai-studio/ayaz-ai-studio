#!/usr/bin/env python3
"""Build blog index + article pages. Run after build_pages.py (or standalone)."""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_pages as bp  # noqa: F401  (also writes static pages on import)
from articles_1 import ARTICLES_1
from articles_2 import ARTICLES_2
from articles_3 import ARTICLES_3
from articles_4 import ARTICLES_4
from articles_5 import ARTICLES_5
from articles_6 import ARTICLES_6
from articles_7 import ARTICLES_7
from articles_8 import ARTICLES_8
from expansions import EXPANSIONS
from expansions2 import EXPANSIONS_2, EXPANSIONS_3

ARTICLES = ARTICLES_1 + ARTICLES_2 + ARTICLES_3 + ARTICLES_4 + ARTICLES_5 + ARTICLES_6 + ARTICLES_7 + ARTICLES_8
for a in ARTICLES:
    extra = EXPANSIONS.get(a["slug"], "") + EXPANSIONS_2.get(a["slug"], "") + EXPANSIONS_3.get(a["slug"], "")
    if extra:
        a["body"] = a["body"].replace(
            '\n<p><a class="cta"',
            "\n" + extra + '\n<p><a class="cta"',
        )

# word-count sanity check
for a in ARTICLES:
    words = len(a["body"].replace("<", " <").split())
    status = "OK " if words >= 800 else "SHORT"
    print(f"{status} {words:5d} words  {a['slug']}")

BLOG_INTRO = """<h1>The Ayaz AI Studio Blog</h1>
<p class="excerpt">Practical guides on AI image and video generation: prompting, tools, workflows,
and the business of creating with AI. New articles every week.</p>
"""

# ── Adsterra ads (LIVE since 2026-10-21) ─────────────────────────────
# Banner 728x90 + Native Banner on blog pages only (1 banner per page).
# Popunder is intentionally NOT included anywhere (AdSense review pending).
ADSTERRA_BANNER = """<div style="overflow:hidden;text-align:center;margin:28px auto;max-width:728px">
<script>
  atOptions = {
    'key' : 'f8797c2cfbe17e23c21c08f18aa5c024',
    'format' : 'iframe',
    'height' : 90,
    'width' : 728,
    'params' : {}
  };
</script>
<script src="https://bauval.org/22/f8797c2cfbe17e23c21c08f18aa5c024"></script>
</div>"""

ADSTERRA_NATIVE = """<div style="margin:28px auto;max-width:640px">
<script async="async" data-cfasync="false" src="https://bauval.org/21/aaf72fb702011f9587015662a8107457"></script>
<div id="container-aaf72fb702011f9587015662a8107457"></div>
</div>"""

cards = []
for a in ARTICLES:
    cards.append(
        f'<div class="card"><h3><a href="/blog/{a["slug"]}">{a["title"]}</a></h3>'
        f'<p class="meta">{a["date"]}</p><p class="excerpt">{a["excerpt"]}</p></div>'
    )
bp.page("blog/index.html", "Blog — Guides on AI Image & Video Generation",
        "Practical guides on AI image and video generation: prompting techniques, tools, workflows and monetization.",
        BLOG_INTRO + "\n".join(cards) + "\n" + ADSTERRA_NATIVE + "\n" + ADSTERRA_BANNER)

for a in ARTICLES:
    body = (a["body"] + "\n" + ADSTERRA_NATIVE + "\n" + ADSTERRA_BANNER
            + '\n<p style="margin-top:32px"><a href="/blog">&larr; Back to all articles</a></p>')
    bp.page(f"blog/{a['slug']}.html", a["title"], a["desc"], body)

print("done:", len(ARTICLES), "articles")
