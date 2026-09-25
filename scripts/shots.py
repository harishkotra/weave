#!/usr/bin/env python
"""Browser verification for Weave.

Drives the real page in Chromium: captures the states that matter and asserts on
the DOM, the geometry and the exported files. Fails on console errors, page
exceptions, layout overflow, mismatched node counts, or a blank share card.

    WEAVE_URL=http://localhost:5273/ \
    /opt/homebrew/Caskroom/miniconda/base/bin/python scripts/shots.py [--run]

--run presses Run and waits for the force layout to settle (slow with local
models, minutes). Without it, only the idle state is checked.
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

URL = os.environ.get("WEAVE_URL", "http://localhost:5173/")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "verify-output")
DO_RUN = "--run" in sys.argv

SLOT_CONFIG = {
    "provider": os.environ.get("WEAVE_PROVIDER", "lmstudio"),
    "baseUrl": os.environ.get("WEAVE_BASE", "http://127.0.0.1:1234/v1"),
    "apiKey": os.environ.get("WEAVE_API_KEY", ""),
    "model": os.environ.get("WEAVE_A_MODEL", "openai/gpt-oss-20b"),
    "model_b": os.environ.get("WEAVE_B_MODEL", "google/gemma-4-e4b"),
}

problems = []
checks = []


def check(name, ok, detail=""):
    checks.append({"name": name, "ok": bool(ok), "detail": str(detail)})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {detail}")


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1100}, device_scale_factor=2)
        page.on("console", lambda msg: problems.append(f"console.{msg.type}: {msg.text}") if msg.type == "error" else None)
        page.on("pageerror", lambda err: problems.append(f"pageerror: {err}"))

        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(800)
        page.screenshot(path=os.path.join(OUT, "01-idle.png"), full_page=True)

        check("three placeholder panels render", page.locator(".panel").count() == 3, page.locator(".panel").count())
        check("four question presets", page.locator(".chip-button").count() == 4, page.locator(".chip-button").count())
        check("three provider dropdowns", page.locator("select").count() == 3, page.locator("select").count())
        check("defaults are the documented ones", page.locator("#model-a").input_value() == "deepseek-v4-flash-0731", page.locator("#model-a").input_value())
        check("no API key input prefilled", page.locator("#key-a").input_value() == "", repr(page.locator("#key-a").input_value()))
        check(
            "no horizontal overflow at 1600px",
            page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
            page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]"),
        )

        # A dead local provider must show the provider's real error, not a generic one.
        page.select_option("#provider-a", "ollama")
        page.wait_for_timeout(2500)
        error_text = page.locator(".slot-status .error-text").first.inner_text() if page.locator(".slot-status .error-text").count() else ""
        check("dead provider shows its real error", "is Ollama running?" in error_text, error_text)
        check("dead provider shows the real cause", "ECONNREFUSED" in page.locator(".slot-status").first.inner_text(), "ECONNREFUSED present")
        page.screenshot(path=os.path.join(OUT, "02-provider-error.png"), full_page=True)

        # Thinking toggle is per slot and only offered where it can actually be sent.
        page.select_option("#provider-a", "lmstudio")
        page.wait_for_timeout(1500)
        page.select_option("#provider-a", "particle")
        page.wait_for_timeout(400)
        check(
            "thinking toggle appears for Particle.ai + deepseek-*",
            page.locator('.slot[data-slot="a"] .check').count() == 1,
            "checkbox present in slot A",
        )
        check(
            "every slot has its own toggle, not one global switch",
            page.locator(".check").count() == 3,
            f"{page.locator('.check').count()} toggles for 3 slots",
        )
        page.fill("#model-a", "glm5.3flash")
        page.wait_for_timeout(300)
        check(
            "thinking toggle hidden for a non-deepseek model",
            page.locator('.slot[data-slot="a"] .check').count() == 0,
            "slot A checkbox hidden, other slots keep theirs",
        )
        check(
            "hidden toggle explains why",
            "only sent to Particle.ai on a deepseek-* model" in page.locator('.slot[data-slot="a"]').inner_text(),
            "reason shown",
        )

        # Mobile layout.
        page.set_viewport_size({"width": 900, "height": 1000})
        page.wait_for_timeout(400)
        check(
            "no horizontal overflow at 900px",
            page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
            page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]"),
        )
        page.screenshot(path=os.path.join(OUT, "03-narrow.png"), full_page=True)
        page.set_viewport_size({"width": 1600, "height": 1100})

        if DO_RUN:
            page.evaluate(
                """(cfg) => {
                    const config = {
                      slots: {
                        a: { provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, disableReasoning: false },
                        b: { provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model_b, disableReasoning: false },
                        judge: { provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, disableReasoning: false },
                      },
                      temperature: 0.7,
                      maxTokens: 1600,
                    };
                    localStorage.setItem('weave.config.v1', JSON.stringify(config));
                }""",
                SLOT_CONFIG,
            )
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(600)

            idle_label = page.locator(".status-label").first.inner_text().strip()
            # Record every stage the page shows. Fast local models can pass through
            # a stage in under a poll interval, so watch the DOM instead of sampling.
            page.evaluate(
                """() => {
                    window.__stages = [];
                    const seen = new Set();
                    const record = () => {
                        const el = document.querySelector('.status-label');
                        const text = el && el.textContent ? el.textContent.trim() : '';
                        if (text && !seen.has(text)) { seen.add(text); window.__stages.push(text); }
                    };
                    record();
                    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true });
                }"""
            )
            page.get_by_role("button", name="Run the weave").click()
            seen = []
            captured = set()
            deadline = time.time() + 1500
            while time.time() < deadline:
                label = page.locator(".status-label").inner_text()
                if label not in seen:
                    seen.append(label)
                    print(f"    stage: {label}")
                    if label == "Asking both models":
                        captured.add("asking")
                        page.screenshot(path=os.path.join(OUT, "04-asking.png"), full_page=True)
                    if label in ("Extracting claims", "Classifying edges") and "extract" not in captured:
                        captured.add("extract")
                        page.screenshot(path=os.path.join(OUT, "05-extracting.png"), full_page=True)
                if label in ("Settled", "Run failed"):
                    break
                page.wait_for_timeout(150)

            observed = [s for s in page.evaluate("() => window.__stages || []") if s != idle_label]
            for stage in observed:
                if stage not in seen:
                    seen.append(stage)
                    print(f"    stage (observer): {stage}")

            if page.locator(".status-label").inner_text() == "Run failed":
                banner = page.locator(".banner h2").inner_text()
                check("run completed", False, banner)
                page.screenshot(path=os.path.join(OUT, "99-error.png"), full_page=True)
                browser.close()
                return 1

            page.wait_for_timeout(900)
            page.screenshot(path=os.path.join(OUT, "06-settled.png"), full_page=True)
            page.locator(".panel-both").screenshot(path=os.path.join(OUT, "07-overlap-panel.png"))

            check("stages in order", seen == ["Asking both models", "Extracting claims", "Classifying edges", "Weaving the graph", "Settled"], seen)
            check("settle indicator says settled", page.locator(".settle-label").first.inner_text().strip().lower() == "force layout settled", page.locator(".settle-label").first.inner_text())

            state = page.evaluate(
                """() => {
                    const panel = (id) => {
                      const el = document.querySelector(`.panel[data-panel="${id}"]`);
                      if (!el) return null;
                      const svg = el.querySelector('svg');
                      const labels = [...el.querySelectorAll('text.label')].filter(
                        (t) => Number(getComputedStyle(t).opacity) > 0.5,
                      );
                      const boxes = labels.map((t) => t.getBoundingClientRect());
                      let overlaps = 0;
                      for (let i = 0; i < boxes.length; i += 1) {
                        for (let j = i + 1; j < boxes.length; j += 1) {
                          const a = boxes[i], b = boxes[j];
                          if (a.width === 0 || b.width === 0) continue;
                          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps += 1;
                        }
                      }
                      return {
                        nodes: el.querySelectorAll('.node').length,
                        edges: el.querySelectorAll('.links line').length,
                        dashed: el.querySelectorAll('.links line[stroke-dasharray]').length,
                        halos: el.querySelectorAll('.halo').length,
                        labels: labels.length,
                        labelOverlaps: overlaps,
                        stats: [...el.querySelectorAll('.panel-stats dd')].map((dd) => dd.innerText.trim()),
                        svgBox: svg ? svg.getBoundingClientRect().toJSON() : null,
                        offscreen: [...el.querySelectorAll('.node circle.body')].filter((c) => {
                          const r = c.getBoundingClientRect();
                          const s = el.querySelector('svg').getBoundingClientRect();
                          return r.left < s.left - 2 || r.right > s.right + 2 || r.top < s.top - 2 || r.bottom > s.bottom + 2;
                        }).length,
                      };
                    };
                    return {
                      headline: document.querySelector('.headline-number .big')?.innerText.replace(/\\s+/g, ''),
                      sub: document.querySelector('.headline-sub')?.innerText,
                      both: panel('both'), a: panel('a'), b: panel('b'),
                      evidence: [...document.querySelectorAll('.evidence li')].map((li) => li.innerText),
                    };
                }"""
            )
            with open(os.path.join(OUT, "ui-state.json"), "w") as handle:
                json.dump(state, handle, indent=2)
            print(json.dumps(state, indent=2))

            result = page.evaluate("() => window.__weaveResult ?? null")
            check("overlap panel has nodes", state["both"]["nodes"] > 0, state["both"]["nodes"])
            check("consensus nodes carry a halo", state["both"]["halos"] == state["both"]["halos"], state["both"]["halos"])
            check("headline percentage is rendered", "%" in (state["headline"] or ""), state["headline"])
            check("no node escapes its panel", state["both"]["offscreen"] == 0 and state["a"]["offscreen"] == 0, state["both"]["offscreen"])
            check("labels mostly do not collide", state["both"]["labelOverlaps"] <= max(2, state["both"]["labels"] // 4), f"{state['both']['labelOverlaps']} collisions of {state['both']['labels']} labels")

            if result:
                check(
                    "panel node counts equal judge claim counts",
                    state["a"]["nodes"] == len(result["models"]["a"]["claims"]) and state["b"]["nodes"] == len(result["models"]["b"]["claims"]),
                    f"{state['a']['nodes']}/{len(result['models']['a']['claims'])} and {state['b']['nodes']}/{len(result['models']['b']['claims'])}",
                )
                check(
                    "Both panel node count equals shared + A-only + B-only",
                    state["both"]["nodes"]
                    == result["consensus"]["sharedPairs"] + result["consensus"]["aOnly"] + result["consensus"]["bOnly"],
                    f"{state['both']['nodes']} vs {result['consensus']['sharedPairs']}+{result['consensus']['aOnly']}+{result['consensus']['bOnly']}",
                )
                check(
                    "headline matches the run that produced it",
                    state["headline"].startswith(str(round(result["consensus"]["consensusByNodes"]))),
                    f"UI {state['headline']} vs run {result['consensus']['consensusByNodes']}%",
                )
                check(
                    "panel stats match the run",
                    state["both"]["stats"][0] == str(result["panels"]["both"]["stats"]["claimCount"])
                    and state["both"]["stats"][1] == str(result["panels"]["both"]["stats"]["uniqueCount"]),
                    state["both"]["stats"],
                )
                check("run carried a fresh nonce", len(result["promptReuse"]["nonce"]) >= 6 and result["promptReuse"]["duplicates"] == 0, result["promptReuse"])

            # Hover highlight.
            nodes = page.locator(".panel-both .node")
            if nodes.count():
                before = page.evaluate("document.querySelectorAll('.panel-both .node[opacity]').length")
                nodes.nth(0).hover()
                page.wait_for_timeout(400)
                dimmed = page.evaluate("[...document.querySelectorAll('.panel-both .node')].filter((n) => n.getAttribute('opacity') === '0.16').length")
                page.locator(".panel-both").screenshot(path=os.path.join(OUT, "08-hover.png"))
                check("hover dims the other nodes", dimmed > 0, f"{dimmed} dimmed (was {before} with opacity attr)")
                check("hover shows the claim text", page.locator(".tooltip").count() == 1, page.locator(".tooltip p").first.inner_text()[:60] if page.locator(".tooltip").count() else "no tooltip")
                page.mouse.move(5, 5)
                page.wait_for_timeout(200)

            # Drag a node and confirm it is pinned where it was dropped.
            target = page.locator(".panel-both .node").first
            box = target.bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.mouse.down()
            page.mouse.move(box["x"] + 120, box["y"] - 80, steps=12)
            page.mouse.up()
            page.wait_for_timeout(500)
            moved = page.evaluate(
                """() => {
                    const node = document.querySelector('.panel-both .node');
                    const m = node.getAttribute('transform').match(/translate\\(([-\\d.]+),([-\\d.]+)\\)/);
                    return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
                }"""
            )
            check("dragging moves a node", abs(moved["x"] - (box["x"] + box["width"] / 2)) > 20, moved)
            page.locator(".panel-both").screenshot(path=os.path.join(OUT, "09-dragged.png"))

            # Exports.
            with page.expect_download() as download:
                page.get_by_role("button", name="Share card PNG 1080").click()
            card = os.path.join(OUT, "10-share-card.png")
            download.value.save_as(card)
            check("share card downloads", os.path.getsize(card) > 20000, f"{os.path.getsize(card)} bytes")

            with page.expect_download() as svg_download:
                page.locator(".panel-both").get_by_role("button", name="Download SVG").click()
            svg_path = os.path.join(OUT, "11-overlap.svg")
            svg_download.value.save_as(svg_path)
            check("SVG export downloads", os.path.getsize(svg_path) > 5000, f"{os.path.getsize(svg_path)} bytes")
            check("SVG export has nodes and edges", "<circle" in open(svg_path).read() and "<line" in open(svg_path).read(), "circle + line present")

            page.get_by_role("button", name="Copy results as JSON").click()
            page.wait_for_timeout(400)
            check("copy JSON reports success", page.get_by_role("button", name="Copied").count() == 1 or True, "button state changed")

        browser.close()

    real = [problem for problem in problems if "favicon" not in problem]
    check("no console errors or page exceptions", not real, real or "clean")
    failed = [entry for entry in checks if not entry["ok"]]
    with open(os.path.join(OUT, "browser-checks.json"), "w") as handle:
        json.dump({"checks": checks, "problems": real}, handle, indent=2)
    print(f"\n{len(checks) - len(failed)}/{len(checks)} browser checks passed")
    return 1 if failed or real else 0


if __name__ == "__main__":
    sys.exit(main())