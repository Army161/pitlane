import type {RuntimeConfig} from '../../contracts/src';
import {required} from '../../core/src/config';
import {LocalStorage} from './local-storage';
import {SupabaseStorage} from './supabase-storage';
export async function serviceStorage(env:Record<string,string|undefined>,config:RuntimeConfig){
 if(config.mode==='local')return new LocalStorage(env.PITLANE_LOCAL_STORAGE_DIR??'.data/artifacts');
 const storage=new SupabaseStorage(required(env,'PITLANE_SUPABASE_URL'),required(env,'PITLANE_STORAGE_SECRET_KEY'),env.PITLANE_STORAGE_BUCKET??'pitlane-private',required(env,'PITLANE_EXPECTED_PROJECT_ID'));
 await storage.verifyPrivate();return storage;
}
