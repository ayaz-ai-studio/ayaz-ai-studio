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
from articles_9 import ARTICLES_9
from expansions import EXPANSIONS
from expansions2 import EXPANSIONS_2, EXPANSIONS_3

ARTICLES = ARTICLES_1 + ARTICLES_2 + ARTICLES_3 + ARTICLES_4 + ARTICLES_5 + ARTICLES_6 + ARTICLES_7 + ARTICLES_8 + ARTICLES_9
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
        BLOG_INTRO + "\n".join(cards)

for a in ARTICLES:
    body = (a["body].replace('<p class="meta">', '<p class="meta">By Khan Ayaz — Ayaz AI Studio · ', 1)
            + "\n<h2>Related guides</h2>\n<ul>" + "".join(f'<li><a href="/blog/{ARTICLES[s]["slug"]}">{ARTICLES[s]["title"]}</a></li>' for s in [[3,9,4],[14,7,16],[0,3,10],[0,2,4],[0,9,5],[4,15,10],[11,13,4],[1,14,8],[1,16,13],[0,4,5],[15,2,5],[13,6,8],[14,1,13],[11,12,1],[1,12,7],[10,5,4],[1,8,14]][ARTICLES.index(a)]) + "</ul>" + '\n<p style="margin-top:32px"><a href="/blog">&larr; Back to all articles</a></p>')
    bp.page(f"blog/{a['slug']}.html", a["title"], a["desc"], body)

print("done:", len(ARTICLES), "articles")
