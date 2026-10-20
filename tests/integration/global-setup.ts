import {startLocalPostgres} from '../../scripts/local-postgres';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
export default async function(){
 const port=await new Promise<number>(done=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const p=(server.address() as {port:number}).port;server.close(()=>done(p))})});
 const dir=resolve('.data',`integration-${process.pid}-${Date.now()}`);await mkdir(dir,{recursive:true});
 const postgres=await startLocalPostgres(dir,port,'pitlane_test');process.env.PITLANE_TEST_DATABASE_URL=postgres.url;
 return async()=>{await postgres.stop()};
}
