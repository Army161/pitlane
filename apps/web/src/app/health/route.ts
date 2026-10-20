import {getRuntime} from '../../lib/runtime';export const runtime='nodejs';export const dynamic='force-dynamic';export const GET=(request:Request)=>getRuntime().handle(request);
