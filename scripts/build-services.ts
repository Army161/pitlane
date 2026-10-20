import {build,type Plugin} from 'esbuild';
import {mkdir,writeFile,readFile,stat,realpath} from 'node:fs/promises';
import {resolve,dirname,extname,sep,isAbsolute} from 'node:path';
import {isEntrypoint} from '../packages/adapters/src/service-host';
import {SERVICE_SCHEMA_VERSION} from '../packages/core/src/startup';
export async function buildServices(env:Record<string,string|undefined>=process.env){
 const identity=env.PITLANE_BUILD_SHA??'local-development';
 if(identity!=='local-development'&&!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(identity))throw new Error('INVALID_BUILD_IDENTITY');
 await mkdir('.dist',{recursive:true});
 const root=await realpath(resolve('.'));
 const inside=(path:string)=>path.toLowerCase().startsWith((root+sep).toLowerCase());
 // Resolve only our source tree. This also avoids native resolver scans of inaccessible Windows ancestors.
 const scopedSource:Plugin={name:'pitlane-source',setup(builder){
  builder.onResolve({filter:/.*/},async args=>{
   if(args.kind!=='entry-point'&&!args.path.startsWith('.')&&!isAbsolute(args.path))return {path:args.path,external:true};
   const base=isAbsolute(args.path)?args.path:resolve(args.importer?dirname(args.importer):root,args.path);
   if(!inside(base))throw new Error('BUILD_SOURCE_OUTSIDE_WORKSPACE');
   for(const candidate of [base,base+'.ts',base+'.tsx',base+'.js',resolve(base,'index.ts')]){
    try{if(!(await stat(candidate)).isFile())continue;const actual=await realpath(candidate);if(!inside(actual))throw new Error('BUILD_SOURCE_OUTSIDE_WORKSPACE');return {path:actual,namespace:'pitlane-source'};}
    catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
   }
   throw new Error('BUILD_SOURCE_NOT_FOUND');
  });
  builder.onLoad({filter:/.*/,namespace:'pitlane-source'},async args=>({contents:await readFile(args.path,'utf8'),loader:extname(args.path)==='.tsx'?'tsx':extname(args.path)==='.json'?'json':'ts'}));
 }};
 const result=await build({absWorkingDir:root,define:{__PITLANE_COMPILED_BUILD__:JSON.stringify(identity)},tsconfigRaw:{compilerOptions:{target:'ES2022',useDefineForClassFields:true}},plugins:[scopedSource],entryPoints:{worker:resolve('apps/worker/src/main.ts'),gateway:resolve('apps/gateway/src/main.ts'),artifact:resolve('apps/artifact/src/main.ts'),billing:resolve('apps/billing/src/main.ts'),maintenance:resolve('apps/maintenance/src/main.ts'),migrate:resolve('scripts/migrate.ts')},outdir:resolve('.dist'),outExtension:{'.js':'.mjs'},platform:'node',target:'node24',format:'esm',bundle:true,packages:'external',sourcemap:true,metafile:true});
 await writeFile('.dist/build-manifest.json',JSON.stringify({schema:'pitlane.build.v1',node:'24',build:identity,serviceSchema:SERVICE_SCHEMA_VERSION,outputs:result.metafile.outputs},null,2)+'\n');
}
if(isEntrypoint(import.meta.url))await buildServices();
