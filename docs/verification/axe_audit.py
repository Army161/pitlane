"""Automated WCAG 2.2 AA + best-practice audit of every PITLANE screen state (desktop 1440 and mobile 390).
Run against `pnpm dev` (fixture mode): AXE_PATH=path/to/axe-core/axe.min.js python3 docs/verification/axe_audit.py
"""
import json, os, sys
from playwright.sync_api import sync_playwright, expect
O = os.environ.get('PITLANE_URL', 'http://127.0.0.1:3000')
AXE = open(os.environ['AXE_PATH']).read()
results = {}
def audit(page, name):
    page.wait_for_timeout(1800)
    page.add_script_tag(content=AXE)
    r = page.evaluate("""async () => { const r = await axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}); return r.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.slice(0,6).map(n=>({t:n.target.join(' '),s:(n.failureSummary||'').slice(0,260)})),count:v.nodes.length})) }""")
    results[name] = r
    print(f'== {name}: {len(r)} rule(s)')
    for v in r:
        print(f"  [{v['impact']}] {v['id']} x{v['count']}: {v['help']}")
        for n in v['nodes'][:4]:
            print('     ', n['t'][:120], '|', n['s'].replace('\n', ' ')[:200])
widths = [('d', 1440, 900), ('m', 390, 844)]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
    for tag, w, h in widths:
        page = b.new_page(viewport={'width': w, 'height': h})
        page.goto(O + '/'); audit(page, f'landing-{tag}')
        page.goto(O + '/garage'); audit(page, f'login-{tag}')
        page.get_by_role('button', name='Enter fixture workshop').click()
        page.wait_for_timeout(3000)
        for path in ['garage', 'book', 'records', 'career', 'career?view=track', 'career?view=board', 'crew', 'agents', 'sprints', 'treasury', 'manual', 'onboarding']:
            page.goto(O + '/' + path); audit(page, f'{path}-{tag}')
        page.goto(O + '/book'); page.wait_for_timeout(2500)
        page.get_by_label('Token mint address').fill('So11111111111111111111111111111111111111112')
        page.get_by_role('button', name='Transfer fee').click(); page.get_by_role('button', name='Mint authority').click()
        page.get_by_role('button', name='Get quote').click()
        expect(page.get_by_text('1 standard unit', exact=True)).to_be_visible(timeout=30000); audit(page, f'book-quote-{tag}')
        with page.expect_response(lambda r: r.url.endswith('/v1/jobs') and r.request.method == 'POST') as resp:
            page.get_by_role('button', name='Submit inspection').click()
        job = resp.value.json(); page.wait_for_timeout(800); audit(page, f'garage-live-{tag}')
        row = page.locator(f'tr[data-job-id="{job["job_id"]}"]')
        expect(row.get_by_role('link', name='View report')).to_be_visible(timeout=40000); audit(page, f'garage-done-{tag}')
        row.get_by_role('link', name='View report').click()
        expect(page.get_by_role('heading', name='Inspection report')).to_be_visible(timeout=30000); audit(page, f'report-{tag}')
        page.goto(O + '/records'); audit(page, f'records-full-{tag}')
        page.close()
    b.close()
json.dump(results, open(os.environ.get('AXE_OUT', 'axe_results.json'), 'w'), indent=1)
total = sum(v['count'] for r in results.values() for v in r)
print('TOTAL violation nodes', total)
