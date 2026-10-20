import type {ReactNode} from 'react';
import './globals.css';
import './racing.css';
export const metadata={title:'PITLANE — Check a Solana token before your app relies on it',description:'Check an existing Solana token against your app’s technical requirements and keep a private, evidence-backed report. Read-only; no wallet signing.'};
export const viewport={themeColor:'#0c0f12',colorScheme:'dark'};
export default function RootLayout({children}:{children:ReactNode}){return <html lang="en"><head><link rel="preload" href="/racing/fonts/Anton-Latin.ttf" as="font" type="font/ttf" crossOrigin="anonymous"/></head><body>{process.env.PITLANE_FRONTEND_PREVIEW==='true'&&<div className="preview-banner" role="status">Frontend preview · Sign-in, live inspections and payments are not connected.</div>}{children}</body></html>}
