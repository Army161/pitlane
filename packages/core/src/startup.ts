import {z} from 'zod';
import {GENESIS,type Db,type Network,type RuntimeConfig} from '../../contracts/src';
import type {ProviderIdentity} from '../../adapters/src/solana-rpc';
export const SERVICE_SCHEMA_VERSION='036';
declare const __PITLANE_COMPILED_BUILD__:string;
const compiledBuild=typeof __PITLANE_COMPILED_BUILD__==='string'?__PITLANE_COMPILED_BUILD__:undefined;
export type ServiceRole='pitlane_web'|'pitlane_worker'|'pitlane_billing'|'pitlane_auth'|'pitlane_gateway'|'pitlane_artifact'|'pitlane_maintenance';
const identity=z.object({id:z.string().min(1).max(64),upstreamId:z.string().min(1).max(128),network:z.enum(['devnet','mainnet-beta']),genesis:z.string().min(1).max(128),maximumMicro:z.string().regex(/^(0|[1-9][0-9]*)$/)});
export function validateProviderRegistry(value:unknown,networks:Network[]=['devnet','mainnet-beta']):ProviderIdentity[]{
 const result=z.array(identity).max(16).safeParse(value);
 if(!result.success)throw new Error('INVALID_PROVIDER_REGISTRY');
 const profiles=result.data;
 if(new Set(profiles.map(p=>p.id)).size!==profiles.length||profiles.some(p=>p.genesis!==GENESIS[p.network]||BigInt(p.maximumMicro)>9223372036854775807n))throw new Error('INVALID_PROVIDER_REGISTRY');
 for(const network of networks){const pair=profiles.filter(p=>p.network===network);if(pair.length!==2||pair[0].upstreamId===pair[1].upstreamId)throw new Error('INDEPENDENT_PROVIDERS_REQUIRED');}
 return profiles;
}
export async function verifyProviderRegistry(db:Pick<Db,'query'>,profiles:ProviderIdentity[],networks:Network[]=['devnet','mainnet-beta']){
 validateProviderRegistry(profiles,networks);
 const registry=(await db.query<{value:ProviderIdentity[]}>('select pitlane.provider_registry() as value')).rows[0].value;
 for(const p of profiles){const configured=registry.find(r=>r.id===p.id);if(!configured||['id','upstreamId','network','genesis','maximumMicro'].some(k=>configured[k as keyof ProviderIdentity]!==p[k as keyof ProviderIdentity]))throw new Error('GATEWAY_PROFILE_MISMATCH');}
}
function validateBuild(build:string,config:RuntimeConfig){
 if(config.mode!=='local'&&!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(build))throw new Error('HOSTED_BUILD_REQUIRED');
 if(!build||build.length>128)throw new Error('INVALID_BUILD');return build;
}
export function serviceBuild(env:Record<string,string|undefined>,config:RuntimeConfig,packagedBuild=compiledBuild){
 const build=env.PITLANE_BUILD_SHA??(config.mode==='local'?'local-development':'');
 validateBuild(build,config);
 if(config.mode!=='local'){
  if(!packagedBuild||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(packagedBuild))throw new Error('HOSTED_COMPILED_BUILD_REQUIRED');
  if(build!==packagedBuild)throw new Error('BUILD_IDENTITY_MISMATCH');
 }
 return build;
}
export async function validateStartup(db:Pick<Db,'query'>,config:RuntimeConfig,role:ServiceRole,build:string){
 validateBuild(build,config);
 const info=(await db.query<{value:Record<string,any>}>('select pitlane.runtime_info() as value')).rows[0]?.value;
 if(!info||info.mode!==config.mode||info.environment_id!==config.environmentId||info.billing_mode!==config.billingMode||config.mode!=='local'&&info.auth_project_id!==config.expectedProjectId)throw new Error('FOREIGN_ENVIRONMENT');
 if(info.contract!=='1'||info.schema_version!==SERVICE_SCHEMA_VERSION)throw new Error('INCOMPATIBLE_RUNTIME');
 if(config.mode==='local')return;
 const connection=(await db.query<{role:string;superuser:boolean;bypass:boolean;mixed:boolean;directWrites:boolean}>(`
 select current_user as role,
 exists(select from pg_roles where rolname in(session_user,current_user) and rolsuper) as superuser,
 exists(select from pg_roles where rolname in(session_user,current_user) and rolbypassrls) as bypass,
 exists(select from unnest(array['pitlane_web','pitlane_worker','pitlane_billing','pitlane_auth','pitlane_gateway','pitlane_artifact','pitlane_maintenance']) as r(name) where r.name<>$1 and pg_has_role(session_user,r.name,'MEMBER')) as mixed,
 has_table_privilege(session_user,'pitlane.jobs','INSERT,UPDATE,DELETE') as "directWrites"
 `,[role])).rows[0];
 if(!connection||connection.role!==role||connection.superuser||connection.bypass||connection.directWrites)throw new Error('PRIVILEGED_DATABASE_IDENTITY');
 if(connection.mixed)throw new Error('MIXED_DATABASE_CAPABILITIES');
}
