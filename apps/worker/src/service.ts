import {GENESIS,type Db,type Lease,type Network,type RpcPort,type StoragePort,type RuntimeConfig} from '../../../packages/contracts/src';
import {Jobs} from '../../../packages/core/src/jobs';
import {Monitors} from '../../../packages/core/src/monitors';
import {Artifacts} from '../../../packages/core/src/artifacts';
import {loadConfig} from '../../../packages/core/src/config';
import {validateStartup,validateProviderRegistry,verifyProviderRegistry,SERVICE_SCHEMA_VERSION} from '../../../packages/core/src/startup';
import {LocalStorage} from '../../../packages/adapters/src/local-storage';
import type {ProviderIdentity} from '../../../packages/adapters/src/solana-rpc';
import {Inspector,FixtureRpc} from './runner';
export interface WorkerOptions {db:Db;id:string;mode:'local'|'staging'|'production';build:string;config?:RuntimeConfig;networks?:Network[];fixtureReadDelayMs?:number;storageRoot?:string;providers?:ProviderIdentity[];rpcFactory?:(lease:Lease)=>RpcPort;storageFactory?:(lease:Lease)=>StoragePort}
export class WorkerService {
 private active:Promise<void>|null=null;private draining=false;readonly jobs:Jobs;private initialized=false;
 readonly config:RuntimeConfig;readonly networks:Network[];
 constructor(readonly options:WorkerOptions){
  this.jobs=new Jobs(options.db);this.config=options.config??loadConfig({PITLANE_MODE:options.mode});this.networks=options.networks??['devnet','mainnet-beta'];
  if(this.config.mode!==options.mode)throw new Error('FOREIGN_ENVIRONMENT');
  if(options.mode!=='local'&&(!options.rpcFactory||!options.storageFactory||!options.providers))throw new Error('HOSTED_ADAPTERS_REQUIRED');
  if(options.fixtureReadDelayMs&&options.mode!=='local')throw new Error('FIXTURE_MODE_PROHIBITED');
  if(options.providers)validateProviderRegistry(options.providers,this.networks);
 }
 private async ready(){
  await validateStartup(this.options.db,this.config,'pitlane_worker',this.options.build);
  if(this.options.mode!=='local')await verifyProviderRegistry(this.options.db,this.options.providers!,this.networks);
 }
 async heartbeat(){
  try{
   await this.ready();
   await this.options.db.query('select pitlane.worker_heartbeat($1,$2,$3,$4)',[this.options.id,this.options.build,this.active?1:0,{contract:'1',schema:SERVICE_SCHEMA_VERSION,corrections:true,networks:this.networks,logicalStages:['inspection','verification'],origin:this.options.mode==='local'?'fixture':'internal',draining:this.draining}]);
   this.initialized=true;
  }catch(error){this.initialized=false;throw error;}
 }
 async tick(){
  if(this.draining||this.active)return;
  const work=this.performTick();this.active=work;
  try{await work;}finally{this.active=null;await this.heartbeat();}
 }
 private async performTick(){
  await this.heartbeat();
  await this.jobs.reap();await new Monitors(this.options.db).scheduleDue();
  const lease=await this.jobs.claim(this.options.id);if(!lease)return;
  await this.heartbeat();const job=await this.jobs.get(lease);
  const rpc=this.options.rpcFactory?.(lease)??new FixtureRpc('local',job.input.network,this.options.fixtureReadDelayMs);
  const storage=this.options.storageFactory?.(lease)??new LocalStorage(this.options.storageRoot??'.data/artifacts');
  const providers=this.options.providers?.filter(p=>p.network===job.input.network)??['a','b'].map(p=>({id:'fixture-'+p,upstreamId:'fixture-'+p,network:job.input.network,genesis:GENESIS[job.input.network],maximumMicro:'100'}));
  await new Inspector(this.jobs,new Artifacts(this.options.db,storage),rpc,providers,{build:this.options.build}).inspect(lease);
 }
 async drain(){this.draining=true;try{await this.active;}finally{await this.heartbeat();}}
 get status(){return {ready:this.initialized&&!this.draining,draining:this.draining,active:this.active?1:0,mode:this.options.mode,build:this.options.build,origin:this.options.mode==='local'?'fixture':'internal',schema:SERVICE_SCHEMA_VERSION,networks:this.networks};}
}
