import {test as base,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const test=base.extend<{browserErrors:string[]}>({browserErrors:[async({page},use)=>{const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await use(errors);expect(errors).toEqual([]);},{auto:true}]});
async function signIn(page:Page,second=false){await page.goto('/book');await page.getByRole('button',{name:second?'Enter second fixture workspace':'Enter fixture workshop',exact:true}).click();await expect(page.getByRole('heading',{name:'Check a token’s configuration',exact:true})).toBeVisible();}
async function submit(page:Page){await page.getByRole('button',{name:'Get quote',exact:true}).click();await expect(page.getByText('1 standard unit',{exact:true})).toBeVisible();const accepted=page.waitForResponse(r=>r.url().endsWith('/v1/jobs')&&r.request().method()==='POST');await page.getByRole('button',{name:'Submit inspection',exact:true}).click();const j=await (await accepted).json();await expect(page.getByRole('heading',{name:'Your next inspection starts here.',exact:true})).toBeVisible();const bay=page.locator(`tr[data-job-id="${j.job_id}"]`);await expect(bay.getByRole('link',{name:'View report',exact:true})).toBeVisible({timeout:20000});await bay.getByRole('link',{name:'View report',exact:true}).click();await expect(page.getByRole('heading',{name:'Inspection report',exact:true})).toBeVisible();return j;}
test('books real durable fixture work and views and exports its receipt across all six areas',async({page})=>{
 await signIn(page);await page.getByLabel('Mint address').fill('So11111111111111111111111111111111111111112');const job=await submit(page);
 await expect(page.getByText('supported',{exact:true}).first()).toBeVisible();await expect(page.getByText('Fixture evidence — not a live Solana observation.',{exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('link',{name:'Export exact JSON',exact:true}).click();const artifact=await download;expect(artifact.suggestedFilename()).toMatch(/^pitlane-.*\.json$/);const saved=JSON.parse(await readFile((await artifact.path())!,'utf8'));expect(saved.jobId).toBe(job.job_id);expect(saved.origin).toBe('fixture');expect(saved.observations).toHaveLength(2);
 for(const [path,title] of [['/crew','Crew'],['/treasury','Treasury'],['/manual','Manual'],['/records','Inspection reports']]){await page.goto(path);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();}
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Enter fixture workshop',exact:true})).toBeVisible();expect((await page.request.get('/v1/projects')).status()).toBe(401);
});
test('invalid addresses do not create a quote; declared negative findings remain completed delivery',async({page})=>{
 await signIn(page);await page.getByLabel('Mint address').fill('111111111111111111111111111111111');const rejected=page.waitForResponse(r=>r.url().endsWith('/v1/quotes')&&r.request().method()==='POST');await page.getByRole('button',{name:'Get quote',exact:true}).click();expect((await rejected).status()).toBe(422);await expect(page.getByRole('alert').filter({hasText:'Check the declared inputs'})).toBeVisible();await expect(page.getByRole('button',{name:'Submit inspection',exact:true})).toHaveCount(0);
 await page.getByLabel('Mint address').fill('So11111111111111111111111111111111111111112');await page.getByRole('combobox',{name:'Template',exact:true}).selectOption('solana.integration_expectations');await page.getByLabel('Expected value',{exact:true}).fill('8');await submit(page);await expect(page.getByText('contradicted',{exact:true}).first()).toBeVisible();await expect(page.getByText('completed / fixture',{exact:true})).toBeVisible();
});
test('a different workspace cannot read, stream or export another project',async({page})=>{
 await signIn(page,true);const foreign='20000000-0000-4000-8000-000000000001';for(const path of [`/v1/jobs?project_id=${foreign}`,`/v1/projects/${foreign}/receipts`,`/v1/projects/${foreign}/crew`]){const r=await page.request.get(path,{headers:{'x-tenant-id':'10000000-0000-4000-8000-000000000001'}});expect(r.status()).toBe(404);expect(await r.json()).toHaveProperty('code','NOT_FOUND');}
 await expect(page.getByLabel('Project')).not.toContainText('Fixture Devnet Integration');
});
test('responsive booking and receipt screens keep keyboard controls and page width usable',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await signIn(page);await page.screenshot({path:'docs/screenshots/book-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});await expect(page.getByRole('heading',{name:'Check a token’s configuration',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await page.getByLabel('Mint address').focus();await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.activeElement?.tagName)).toBe('BUTTON');await page.screenshot({path:'docs/screenshots/book-mobile.png',fullPage:true});
 await page.getByLabel('Mint address').fill('So11111111111111111111111111111111111111112');await submit(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await page.screenshot({path:'docs/screenshots/receipt-mobile.png',fullPage:true});
});
test('private conversations and sprint work survive reload without a configured AI provider',async({page})=>{
 await signIn(page);await page.goto('/agents');
 await expect(page.getByRole('heading',{name:'Agent workspace',exact:true})).toBeVisible();
 await expect(page.getByText('Provider unavailable',{exact:true})).toBeVisible();
 const title='Evidence review '+Date.now();
 await page.getByLabel('Conversation title').fill(title);await page.getByRole('button',{name:'New conversation',exact:true}).click();
 await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
 await page.getByLabel('Message',{exact:true}).fill('Please record the mint authority follow-up for the integration review.');
 await page.getByRole('button',{name:'Save message',exact:true}).click();
 await expect(page.getByRole('list',{name:'Conversation messages'})).toContainText('mint authority follow-up');
 await expect(page.getByText('Agent explanation',{exact:true})).toHaveCount(0);
 await page.reload();await expect(page.getByRole('list',{name:'Conversation messages'})).toContainText('mint authority follow-up');
 await page.screenshot({path:'docs/screenshots/agents-desktop.png',fullPage:true});
 await page.goto('/sprints');const sprint='Integration sprint '+Date.now();
 await page.getByLabel('Sprint title',{exact:true}).fill(sprint);await page.getByLabel('Goal',{exact:true}).fill('Resolve recorded integration questions');
 await page.getByRole('button',{name:'Create sprint',exact:true}).click();await expect(page.getByRole('heading',{name:sprint,exact:true})).toBeVisible();
 await page.getByLabel('Work title',{exact:true}).fill('Verify declared authority');await page.getByRole('button',{name:'Add work item',exact:true}).click();
 const item=page.locator('article.work-item').filter({has:page.getByRole('heading',{name:'Verify declared authority',exact:true})});
 await expect(item).toBeVisible();await item.getByLabel('Work state').selectOption('done');
 await expect(page.getByRole('region',{name:'done',exact:true}).getByRole('heading',{name:'Verify declared authority',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('region',{name:'done',exact:true}).getByRole('heading',{name:'Verify declared authority',exact:true})).toBeVisible();
 await page.screenshot({path:'docs/screenshots/sprints-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
 await page.screenshot({path:'docs/screenshots/sprints-mobile.png',fullPage:true});
});
test('public landing explains the product before sign-in and the garage records free learning without touching inspections',async({page})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:'Know if a token fits your app.',exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Your game promises 100 tokens. Does the player get 100?',exact:true})).toBeVisible();await expect(page.getByText('This illustrates how a report reads. It is not a live inspection result.',{exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await expect(page.getByText('No transactions',{exact:true})).toBeVisible();
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('link',{name:'Start an inspection',exact:true}).click();await page.getByRole('button',{name:'Enter fixture workshop',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Your role',exact:true})).toBeVisible();await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('heading',{name:'Ready for your first inspection',exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('heading',{name:'Ready for your first inspection',exact:true})).toBeVisible();
 const jobsBefore=await (await page.request.get('/v1/jobs?project_id=20000000-0000-4000-8000-000000000001',{headers:{'x-tenant-id':'10000000-0000-4000-8000-000000000001'}})).text();
 await page.goto('/career');await expect(page.getByRole('heading',{name:'My garage',exact:true})).toBeVisible();await expect(page.getByText('No members opted in yet',{exact:true})).toBeVisible();
 await expect(page.getByLabel('Night blue')).toBeDisabled();
 await page.getByRole('tab',{name:'Track map',exact:true}).click();await expect(page).toHaveURL(/view=track/);
 const lesson=page.locator('#lesson-purpose');await lesson.getByLabel('Whether supported settings meet declared requirements').check();await lesson.getByRole('button',{name:'Check understanding',exact:true}).click();await expect(lesson.getByRole('button',{name:'Lesson complete',exact:true})).toBeDisabled();
 await page.reload();await expect(page.locator('#lesson-purpose').getByRole('button',{name:'Lesson complete',exact:true})).toBeDisabled();
 await page.getByRole('tab',{name:'My garage',exact:true}).click();await page.getByLabel('Dusk').click();await expect(page.getByLabel('Dusk')).toBeChecked();
 expect(await (await page.request.get('/v1/jobs?project_id=20000000-0000-4000-8000-000000000001',{headers:{'x-tenant-id':'10000000-0000-4000-8000-000000000001'}})).text()).toBe(jobsBefore);
});
