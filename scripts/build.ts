import {spawn} from 'node:child_process';
import {cp,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildServices} from './build-services';
import {normalizeStandaloneLinks} from './standalone-links';
const child=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'build','apps/web'],{windowsHide:true,stdio:'inherit',env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'}});
const code=await new Promise<number>((done,reject)=>{child.on('error',reject);child.on('exit',code=>done(code??1));});
if(code!==0)process.exit(code);
await buildServices();
const destination=resolve('apps/web/.next/standalone/apps/web');
await cp('apps/web/.next/static',destination+'/.next/static',{recursive:true,force:true});
try{await access('apps/web/public');await cp('apps/web/public',destination+'/public',{recursive:true,force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
await normalizeStandaloneLinks(resolve('.'),resolve('apps/web/.next/standalone'));
process.stdout.write('PITLANE standalone web assets and Node service executables built.\n');
