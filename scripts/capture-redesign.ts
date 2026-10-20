import {chromium,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const out=resolve(process.env.PITLANE_CAPTURE_DIR??'../PITLANE-redesign-delivery-2026-10-20/screenshots');await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PITLANE_CHROMIUM_PATH??'C:/Users/Armyg/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'});
const page=await browser.newPage({viewport:{width:1586,height:992},deviceScaleFactor:1});
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
const origin=process.env.PITLANE_CAPTURE_ORIGIN??'http://127.0.0.1:3000';
async function capture(name:string){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:resolve(out,name+'.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);}
try{
 await page.goto(origin);await expect(page.getByRole('heading',{name:'Know if a token fits your app.'})).toBeVisible();await capture('landing-desktop');
 await page.setViewportSize({width:390,height:844});await capture('landing-mobile');
 await page.setViewportSize({width:1586,height:992});await page.getByRole('link',{name:'Start an inspection',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign in to PITLANE'})).toBeVisible();await capture('signin-desktop');
 await page.getByRole('button',{name:'Enter fixture workshop',exact:true}).click();await expect(page.getByRole('heading',{name:'Your role'})).toBeVisible();await capture('onboarding-desktop');
 for(const [path,name,heading] of [['/garage','dashboard','Your next inspection starts here.'],['/book','inspection','Check a token’s configuration'],['/career','career','My garage']]){
  await page.goto(origin+path);await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();if(path==='/career')await expect(page.getByRole('heading',{name:'Your crew career'})).toBeVisible();await capture(name+'-desktop');await page.setViewportSize({width:390,height:844});await capture(name+'-mobile');await page.setViewportSize({width:1586,height:992});
 }
 await page.getByRole('tab',{name:'Team leaderboard',exact:true}).click();await expect(page.getByText('No members opted in yet',{exact:true})).toBeVisible();await capture('leaderboard-empty-desktop');
 await page.getByRole('tab',{name:'Track map',exact:true}).click();await capture('track-desktop');
 const lesson=page.locator('#lesson-purpose');await lesson.getByLabel('Whether supported settings meet declared requirements').check();await lesson.getByRole('button',{name:'Check understanding'}).click();await expect(lesson.getByRole('button')).toBeDisabled();
 await page.reload();await page.getByRole('tab',{name:'Track map',exact:true}).click();await expect(page.locator('#lesson-purpose').getByRole('button')).toBeDisabled();
 await page.goto(origin+'/book');await page.getByLabel('Mint address').fill('So11111111111111111111111111111111111111112');await page.getByRole('button',{name:'Get quote',exact:true}).click();await expect(page.getByRole('button',{name:'Submit inspection'})).toBeVisible();
 const accepted=page.waitForResponse(r=>r.url().endsWith('/v1/jobs')&&r.request().method()==='POST');await page.getByRole('button',{name:'Submit inspection'}).click();const job=await(await accepted).json();const card=page.locator(`tr[data-job-id="${job.job_id}"]`);await expect(card.getByRole('link',{name:'View report'})).toBeVisible({timeout:30000});await card.getByRole('link',{name:'View report'}).click();await expect(page.getByRole('heading',{name:'Inspection report',exact:true})).toBeVisible();await capture('evidence-desktop');await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});await capture('evidence-mobile');
 await writeFile(resolve(out,'browser-check.json'),JSON.stringify({viewport:{desktop:'1586x992',mobile:'390x844'},errors,checked:['landing navigation','fixture sign-in','onboarding','dashboard','inspection quote and durable job','exact evidence view','private empty leaderboard','persisted learning milestone','mobile overflow','reduced motion']},null,2));expect(errors).toEqual([]);
}finally{await browser.close();}
