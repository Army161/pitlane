import Link from 'next/link';
import type {ReactNode} from 'react';
import {Brand,Icon} from './icons';

/** The original #27 garage photograph, served as responsive WebP. Decorative: every screen states its content in text. */
export function HeroPhoto({position,priority=false}:{position?:string;priority?:boolean}){
 return <picture><source type="image/webp" srcSet="/racing/garage-27-720.webp 720w, /racing/garage-27-1200.webp 1200w, /racing/garage-27-1774.webp 1774w" sizes="100vw"/><img src="/racing/garage-27-1200.webp" alt="" width={1774} height={887} decoding="async" loading={priority?'eager':'lazy'} fetchPriority={priority?'high':'auto'} style={position?{objectPosition:position}:undefined}/></picture>;
}
export function TrackPhoto(){
 return <picture><source type="image/webp" srcSet="/racing/learning-track-1000.webp 1000w, /racing/learning-track-1774.webp 1774w" sizes="(max-width: 760px) 100vw, 50vw"/><img src="/racing/learning-track-1000.webp" alt="" width={1774} height={887} decoding="async" loading="lazy"/></picture>;
}
export function RaceHero({eyebrow,title,description,children,compact=false,side,position}:{eyebrow:string;title:ReactNode;description:string;children?:ReactNode;compact?:boolean;side?:ReactNode;position?:string}){
 return <section className={'race-hero'+(compact?' compact':'')}><HeroPhoto priority position={position}/><div className="hero-copy"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p>{children}</div>{side&&<p className="hero-side" aria-hidden="true">{side}</p>}</section>;
}
const workflow:[string,string][]=[['Validate','Check the full token address and confirm the chosen network.'],['Collect','Read finalized mint data from two independent providers.'],['Compare','Evaluate the recorded settings against your requirements.'],['Report','Keep a private report with the finding and the evidence behind it.']];
/** Explains the workflow only. Live job stages are shown from persisted job states, never from this diagram. */
export function Workflow({title='From token address to a private, evidence-backed report.'}:{title?:string}){
 return <section className="track-band" aria-labelledby="workflow-title"><TrackPicture/><p className="eyebrow">Workflow preview</p><h2 id="workflow-title">{title}</h2><ol>{workflow.map(([name,copy],i)=><li key={name}><span className="step-dot" aria-hidden="true">{i+1}</span><h3>{name}</h3><p>{copy}</p></li>)}</ol><small>This explains how a check works. Live stages appear on Race control only after you submit an inspection.</small></section>;
}
function TrackPicture(){return <picture><source type="image/webp" srcSet="/racing/learning-track-1000.webp 1000w, /racing/learning-track-1774.webp 1774w" sizes="100vw"/><img src="/racing/learning-track-1000.webp" alt="" width={1774} height={887} loading="lazy" decoding="async"/></picture>;}

export function Landing(){
 return <div className="landing">
  <a className="skip" href="#main">Skip to content</a>
  <header className="public-nav"><Brand small/><nav aria-label="Public"><a className="hide-sm" href="#how-it-works">How it works</a><a className="hide-sm" href="#example">Sample report</a><a className="hide-sm" href="#coverage">Coverage</a><Link className="button secondary" href="/garage">Sign in</Link></nav></header>
  <main id="main">
   <section className="landing-hero" aria-labelledby="hero-title">
    <HeroPhoto priority position="64% center"/>
    <div>
     <p className="eyebrow">Solana token checks · for developers and teams</p>
     <h1 id="hero-title">Know if a token<br/><em>fits your app.</em></h1>
     <p className="lede">Check an existing Solana token against your app’s technical requirements. Get a private report of what matches, what conflicts and what could not be verified.</p>
     <div className="hero-actions"><Link className="button large" href="/onboarding">Start an inspection <Icon name="arrow"/></Link><a className="button secondary large" href="#example">See a sample report</a></div>
     <ul className="promises">
      <li><Icon name="lock"/><span>Read-only.<br/>No wallet signing.</span></li>
      <li><Icon name="doc"/><span>Private,<br/>evidence-backed reports.</span></li>
      <li><Icon name="clock"/><span>Built for builders,<br/>not hype.</span></li>
     </ul>
    </div>
    <aside className="sample-card" aria-label="Example report summary (sample data)">
     <header><span className="ok"><Icon name="check" size={16}/></span><h2>Inspection complete</h2><span className="tag">Sample</span></header>
     <p className="mono">Example mint · devnet</p>
     <ul>
      <li><span className="dot go"><Icon name="check" size={13}/></span>Decimals: requirement met</li>
      <li><span className="dot conflict"><Icon name="alert" size={12}/></span>Transfer fee: conflicts with requirement</li>
      <li><span className="dot unknown"><Icon name="question" size={13}/></span>Metadata: not enough evidence</li>
     </ul>
     <a className="link-arrow" href="#example">How to read this <Icon name="arrow" size={16}/></a>
    </aside>
   </section>
   <div className="landing-body">
    <div className="steps-row" id="how-it-works">
     <article className="step-card"><div><p className="num">01</p><h2>Enter a token</h2><p>Paste the full address of an existing Solana token and choose its network.</p></div><div className="mini-ui" aria-hidden="true"><div className="mini-input"><Icon name="copy" size={16}/>Full mint address<span className="go"><Icon name="arrow" size={16}/></span></div></div></article>
     <article className="step-card"><div><p className="num">02</p><h2>Set requirements</h2><p>Choose the supported settings your app depends on, then review the quote before anything runs.</p></div><ul className="mini-ui mini-checks" aria-hidden="true">{[['Token program',true],['Decimals',true],['Transfer fee limit',true],['Mint authority',false],['Freeze authority',false],['Metadata fields',false]].map(([label,on])=><li key={String(label)}><span className={'box'+(on?' on':'')}>{on&&<Icon name="check" size={11}/>}</span>{label}</li>)}</ul></article>
     <article className="step-card"><div><p className="num">03</p><h2>Review evidence</h2><p>See what matched, what conflicted and what stayed unknown, next to the recorded observations.</p></div><ul className="mini-ui ivory mini-report" aria-hidden="true"><li><span className="dot go"><Icon name="check" size={12}/></span><span><b>Decimals</b><span className="why">Expected 6 · observed 6</span></span></li><li><span className="dot conflict"><Icon name="alert" size={11}/></span><span><b>Transfer fee</b><span className="why">Conflicts with requirement</span></span></li><li><span className="dot unknown"><Icon name="question" size={12}/></span><span><b>Metadata</b><span className="why">Not enough evidence</span></span></li></ul></article>
    </div>

    <section className="example-band" id="example" aria-labelledby="example-title">
     <div>
      <p className="eyebrow">A worked example</p>
      <h2 id="example-title">Your game promises 100 tokens. Does the player get 100?</h2>
      <p>Say your game rewards a player with 100 tokens. If that token has a 5% transfer fee, the player receives 95, and your app’s promise is broken. PITLANE checks the token’s recorded settings against the requirement you declare, such as “transfer fee must be absent,” and tells you whether the evidence supports it, contradicts it or cannot settle it.</p>
      <p>You still decide what to do next. PITLANE gives you the evidence to decide with.</p>
     </div>
     <div className="ledger" role="group" aria-label="Example, illustrative figures only">
      <h3><Icon name="report"/>Example only · illustrative figures</h3>
      <div className="row-line"><span>Tokens your game sends</span><span>100</span></div>
      <div className="row-line"><span>Transfer fee on the token (5%)</span><span className="delta">−5</span></div>
      <div className="row-line"><span>Tokens the player receives</span><span>95</span></div>
      <div className="finding-strip"><Icon name="alert"/><span><strong>Finding: Contradicted.</strong> Your requirement was “no transfer fee.” Both providers record a transfer fee configuration on this mint.</span></div>
      <small>This illustrates how a report reads. It is not a live inspection result.</small>
     </div>
    </section>

    <section className="audience" aria-label="Who PITLANE is for">
     <article><h3>Who it’s for</h3><p>Developers and teams integrating an existing Solana token into a game, wallet, payment flow or other app.</p></article>
     <article><h3>What you enter</h3><p>The full token (mint) address, its network, and the supported requirements your app depends on.</p></article>
     <article><h3>What you receive</h3><p>A private report: each requirement, what two independent providers observed, and a clear finding with its evidence.</p></article>
     <article><h3>Its limits</h3><p>No token creation, trading, price prediction or business validation. A report is not a safety certificate.</p></article>
    </section>

    <section className="coverage-band" id="coverage" aria-labelledby="coverage-title">
     <div className="lead"><p className="eyebrow">Coverage</p><h2 id="coverage-title">Solana / <em>Token-2022</em></h2><p>Bounded technical checks, disclosed before you submit. Anything outside this list is reported as unsupported, never guessed.</p></div>
     <div><h3><Icon name="database"/>Original Token program</h3><ul>{['Mint configuration','Decimals and supply','Mint authority status','Freeze authority status'].map(t=><li key={t}><Icon name="check" size={16}/>{t}</li>)}</ul></div>
     <div><h3><Icon name="doc"/>Token-2022 extensions</h3><ul>{['TransferFeeConfig','MintCloseAuthority','MetadataPointer','TokenMetadata'].map(t=><li key={t}><Icon name="check" size={16}/>{t}</li>)}</ul><small>Other extensions: unsupported.</small></div>
     <div><h3><Icon name="shield"/>Read-only. No wallet signing.</h3><ul>{['No transactions','No approvals','No trading','Inspection and evidence only'].map(t=><li key={t}><Icon name="check" size={16}/>{t}</li>)}</ul></div>
    </section>

    <section aria-labelledby="findings-title">
     <p className="eyebrow">Reading a report</p>
     <h2 id="findings-title" className="section-h2">Three findings. Visible limits.</h2>
     <div className="findings-row">
      <article className="finding-card"><h3><span className="dot lg go"><Icon name="check" size={14}/></span>Supported</h3><p>The recorded evidence supports the requirement you declared.</p></article>
      <article className="finding-card conflict"><h3><span className="dot lg conflict"><Icon name="alert" size={13}/></span>Contradicted</h3><p>The evidence conflicts with your requirement. Finding a conflict is a completed, useful check.</p></article>
      <article className="finding-card unknown"><h3><span className="dot lg unknown"><Icon name="question" size={14}/></span>Insufficient evidence</h3><p>The check could not establish an answer. An unknown is never shown as a pass, and is not charged.</p></article>
     </div>
    </section>

    <Workflow/>

    <section className="landing-cta" aria-labelledby="cta-title"><div><p className="eyebrow">Your next integration starts here</p><h2 id="cta-title">Bring the address.<br/><em>Keep the evidence.</em></h2></div><Link className="button large" href="/onboarding">Set up your workspace <Icon name="arrow"/></Link></section>
   </div>
  </main>
  <footer className="public-footer"><Brand small/><p className="disclaimer">Point-in-time technical evidence for supported checks only. Not a token-safety, legal or investment assessment. Original artwork and fictional livery; not affiliated with or endorsed by NASCAR or any racing team.</p><Link href="/garage">Open your workshop</Link></footer>
 </div>;
}
