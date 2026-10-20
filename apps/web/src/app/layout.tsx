import type {ReactNode} from 'react';
import './globals.css';
import './racing.css';
const origin=process.env.PITLANE_ORIGIN??(process.env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+process.env.VERCEL_PROJECT_PRODUCTION_URL:undefined);
export const metadata={metadataBase:origin?new URL(origin):undefined,title:'PITLANE — Check a Solana token before your app relies on it',description:'Check an existing Solana token against your app’s technical requirements and keep a private, evidence-backed report. Read-only; no wallet signing.',openGraph:{type:'website',siteName:'PITLANE'},robots:process.env.PITLANE_FRONTEND_PREVIEW==='true'?{index:false,follow:false}:undefined};
export const viewport={themeColor:'#0c0f12',colorScheme:'dark'};
export default function RootLayout({children}:{children:ReactNode}){return <html lang="en"><head><link rel="preload" href="/racing/fonts/Anton-Latin.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/></head><body>{process.env.PITLANE_FRONTEND_PREVIEW==='true'&&<div className="preview-banner" role="status">Frontend preview · Sign-in, live inspections and payments are not connected.</div>}{children}</body></html>}
