import {getRuntime} from '../../../lib/runtime';
import {previewResponse} from '../../../lib/preview';
export const runtime='nodejs';export const dynamic='force-dynamic';
export const GET=(request:Request)=>previewResponse()??getRuntime().handle(request);
export const POST=GET;export const PATCH=GET;export const DELETE=GET;
