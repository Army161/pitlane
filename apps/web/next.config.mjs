import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const build=process.env.PITLANE_BUILD_SHA??'local-development';
export default {env:{PITLANE_WEB_COMPILED_BUILD:build},output:'standalone',outputFileTracingRoot:root,turbopack:{root},poweredByHeader:false,serverExternalPackages:['pg','stripe','@supabase/supabase-js'],async headers(){return [{source:'/:path*',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'same-origin'},{key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},{key:'X-Frame-Options',value:'DENY'}]}]}};
