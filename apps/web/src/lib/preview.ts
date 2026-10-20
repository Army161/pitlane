/** Explicit frontend-only previews never initialize services or pretend to be ready. */
export function previewResponse(env:Record<string,string|undefined>=process.env){
 if(env.PITLANE_FRONTEND_PREVIEW!=='true')return null;
 return Response.json({code:'FRONTEND_PREVIEW',ready:false,mode:'frontend-preview',message:'This is a frontend preview. Sign-in, live inspections and payments are not connected.'},{status:503,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
