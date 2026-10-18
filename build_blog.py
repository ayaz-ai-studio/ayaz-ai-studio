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
from expansions import EXPANSIONS
from expansions2 import EXPANSIONS_2, EXPANSIONS_3

ARTICLES = ARTICLES_1 + ARTICLES_2 + ARTICLES_3 + ARTICLES_4 + ARTICLES_5
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

cards = []
for a in ARTICLES:
    cards.append(
        f'<div class="card"><h3><a href="/blog/{a["slug"]}">{a["title"]}</a></h3>'
        f'<p class="meta">{a["date"]}</p><p class="excerpt">{a["excerpt"]}</p></div>'
    )
bp.page("blog/index.html", "Blog — Guides on AI Image & Video Generation",
        "Practical guides on AI image and video generation: prompting techniques, tools, workflows and monetization.",
        BLOG_INTRO + "\n".join(cards))

for a in ARTICLES:
    body = a["body"] + '\n<p style="margin-top:32px"><a href="/blog">&larr; Back to all articles</a></p>'
    bp.page(f"blog/{a['slug']}.html", a["title"], a["desc"], body)

print("done:", len(ARTICLES), "articles")
