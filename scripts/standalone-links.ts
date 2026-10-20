import {lstat,readdir,readlink,realpath,rename,symlink,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {isEntrypoint} from '../packages/adapters/src/service-host';

function inside(root:string,path:string){const value=relative(root,path);return value===''||(!isAbsolute(value)&&value!=='..'&&!value.startsWith('..'+sep));}
function ensure(value:unknown,code:string):asserts value{if(!value)throw new Error(code);}

export async function normalizeStandaloneLinks(workspace:string,standalone:string){
 const source=await realpath(workspace),root=await realpath(standalone);
 ensure(inside(source,root)&&root!==source,'STANDALONE_ROOT_OUTSIDE_WORKSPACE');
 ensure(!(await lstat(standalone)).isSymbolicLink(),'STANDALONE_ROOT_LINK_PROHIBITED');
 const plans:{path:string,target:string,original:string,type:'dir'|'file',rebased:boolean}[]=[];let checked=0;
 async function walk(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=resolve(directory,entry.name);
   if(entry.isSymbolicLink()){
    checked++;const original=await readlink(path),originalTarget=resolve(dirname(path),original);
    let target=originalTarget,rebased=false;
    if(!inside(root,target)){
     ensure(inside(source,target),'STANDALONE_LINK_OUTSIDE_WORKSPACE');
     target=resolve(root,relative(source,target));rebased=true;
    }
    // Resolve only the traced target, never a source dependency or an external link.
    const actual=await realpath(target);
    ensure(inside(root,actual),'STANDALONE_LINK_OUTSIDE_PACKAGE');
    const directoryTarget=(await lstat(actual)).isDirectory();
    if(rebased||isAbsolute(original)||(process.platform==='win32'&&directoryTarget))plans.push({path,target:relative(dirname(path),actual),original,type:directoryTarget?'dir':'file',rebased});
   }else if(entry.isDirectory())await walk(path);
  }
 }
 // Validate every link before changing any generated file; traversal never follows links.
 await walk(root);
 for(const plan of plans){
  const temporary=plan.path+'.pitlane-'+randomUUID();let removed=false;
  try{
   await symlink(plan.target,temporary,plan.type);
   await unlink(plan.path);removed=true;await rename(temporary,plan.path);
  }catch(error){
   if(removed)await symlink(plan.original,plan.path,plan.type).catch(()=>{});
   throw error;
  }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
 }
 return {linksChecked:checked,linksRebased:plans.filter(plan=>plan.rebased).length,absoluteLinksRelativized:plans.filter(plan=>isAbsolute(plan.original)).length,windowsDirectoryLinks:process.platform==='win32'?plans.filter(plan=>plan.type==='dir').length:0};
}
if(isEntrypoint(import.meta.url)){
 const workspace=resolve(import.meta.dirname,'..');
 process.stdout.write(JSON.stringify(await normalizeStandaloneLinks(workspace,resolve(workspace,'apps/web/.next/standalone')))+'\n');
}
