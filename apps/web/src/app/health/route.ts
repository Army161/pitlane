import {previewResponse} from '../../lib/preview';
import {getRuntime} from '../../lib/runtime';export const runtime='nodejs';export const dynamic='force-dynamic';export const GET=(request:Request)=>previewResponse()??getRuntime().handle(request);
