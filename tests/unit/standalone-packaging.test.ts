import {it,expect} from 'vitest';
import {mkdir,mkdtemp,readFile,readlink,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {normalizeStandaloneLinks} from '../../scripts/standalone-links';

async function fixture(run:(workspace:string,standalone:string)=>Promise<void>){
 const temporary=await realpath(tmpdir()),workspace=await mkdtemp(join(temporary,'pitlane-standalone-test-')),standalone=join(workspace,'output');
 try{await mkdir(standalone);await run(workspace,standalone);}
 finally{const owned=relative(temporary,workspace);if(!owned.startsWith('pitlane-standalone-test-')||owned.includes(sep))throw new Error('TEST_CLEANUP_OUTSIDE_TEMP');await rm(workspace,{recursive:true,force:true});}
}
async function packageAt(path:string){await mkdir(path,{recursive:true});await writeFile(join(path,'package.json'),JSON.stringify({name:'packaging-fixture',main:'index.cjs'}));await writeFile(join(path,'index.cjs'),'module.exports="traced-copy";');}

it('loads a traced directory through a correctly typed relative dependency link',async()=>fixture(async(workspace,standalone)=>{
 const target=join(standalone,'node_modules','.pnpm','packaging-fixture','node_modules','packaging-fixture'),link=join(standalone,'node_modules','packaging-fixture');await packageAt(target);
 // Next creates these directory targets using the default Windows file-link type.
 await symlink(relative(join(standalone,'node_modules'),target),link,'file');
 if(process.platform==='win32')await expect(realpath(link)).rejects.toHaveProperty('code','EPERM');
 await normalizeStandaloneLinks(workspace,standalone);
 expect(await realpath(link)).toBe(await realpath(target));
 expect(createRequire(join(standalone,'server.cjs'))('packaging-fixture')).toBe('traced-copy');
}));

it('rebases absolute source aliases onto traced copies and keeps the package movable',async()=>fixture(async(workspace,standalone)=>{
 const source=join(workspace,'node_modules','packaging-fixture'),traced=join(standalone,'node_modules','packaging-fixture'),aliases=join(standalone,'apps','web','.next','node_modules');
 await packageAt(source);await writeFile(join(source,'index.cjs'),'module.exports="source-copy";');await packageAt(traced);await mkdir(aliases,{recursive:true});
 const link=join(aliases,'packaging-fixture-alias');await symlink(source,link,'dir');
 const result=await normalizeStandaloneLinks(workspace,standalone);expect(result.linksRebased).toBe(1);
 expect(await readlink(link)).toBe(relative(aliases,traced));
 const moved=join(workspace,'relocated');expect(relative(workspace,standalone)).toBe('output');expect(relative(workspace,moved)).toBe('relocated');await rename(standalone,moved);
 expect(createRequire(join(moved,'apps','web','.next','server.cjs'))('packaging-fixture-alias')).toBe('traced-copy');
 expect(await readFile(join(source,'index.cjs'),'utf8')).toBe('module.exports="source-copy";');
}));

it('returns a nonzero CLI status when standalone acceptance rejects its environment',async()=>{
 const child=spawn(process.execPath,['--import','tsx',resolve('scripts/verify-standalone.ts')],{cwd:resolve('.'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PITLANE_MODE:'staging',NODE_OPTIONS:''}});
 let output='';child.stderr.on('data',bytes=>{output+=bytes.toString();});
 const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('exit',done);});
 expect(code).toBe(1);expect(output).toContain('LOCAL_STANDALONE_CHECK_REQUIRED');
});

it('rejects an external target before altering any generated dependency link',async()=>fixture(async(workspace,standalone)=>{
 const valid=join(standalone,'valid'),alias=join(standalone,'a-source-alias'),external=join(standalone,'z-external');await packageAt(valid);
 await symlink(join(workspace,'valid'),alias,'dir');await symlink(resolve(workspace,'..'),external,'dir');
 await expect(normalizeStandaloneLinks(workspace,standalone)).rejects.toThrow('STANDALONE_LINK_OUTSIDE_WORKSPACE');
 expect(await readlink(alias)).toBe(join(workspace,'valid'));expect(await readlink(external)).toBe(resolve(workspace,'..'));
}));

it('relativizes contained absolute directory and file targets before relocation',async()=>fixture(async(workspace,standalone)=>{
 const target=join(standalone,'node_modules','package-copy'),directoryAlias=join(standalone,'node_modules','contained-directory'),file=join(standalone,'file.cjs'),fileAlias=join(standalone,'contained-file.cjs');
 await packageAt(target);await writeFile(file,'module.exports="traced-file";');await symlink(target,directoryAlias,'dir');await symlink(file,fileAlias,'file');
 const result=await normalizeStandaloneLinks(workspace,standalone);expect(result.absoluteLinksRelativized).toBe(2);
 expect(await readlink(directoryAlias)).toBe('package-copy');expect(await readlink(fileAlias)).toBe('file.cjs');
 const moved=join(workspace,'relocated');expect(relative(workspace,standalone)).toBe('output');expect(relative(workspace,moved)).toBe('relocated');await rename(standalone,moved);
 const requireMoved=createRequire(join(moved,'server.cjs'));expect(requireMoved('contained-directory')).toBe('traced-copy');expect(requireMoved('./contained-file.cjs')).toBe('traced-file');
}));
