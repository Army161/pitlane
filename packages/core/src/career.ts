import {z} from 'zod';
import type {Actor,Db} from '../../contracts/src';
/**
 * Free learning progress and cosmetic garage preferences.
 * Independent of jobs, findings, evidence, quotas, prices and billing: nothing here can read or write them.
 */
export const CAREER_MILESTONES=['purpose','outcomes','coverage','evidence','privacy','cosmetics'] as const;
export const LIVERIES=['factory','ivory','night'] as const;
export const NUMBER_STYLES=['classic','block','outline'] as const;
export const LIGHTING=['workshop','dusk','floodlight'] as const;
/** Lessons required before each cosmetic option can be selected. Enforced again in the database. */
export const UNLOCKS={livery:{factory:0,ivory:3,night:6},numberStyle:{classic:0,block:2,outline:4},lighting:{workshop:0,dusk:1,floodlight:5}} as const;
export type Livery=typeof LIVERIES[number];
export type NumberStyle=typeof NUMBER_STYLES[number];
export type Lighting=typeof LIGHTING[number];
export interface CareerState {alias:string;optIn:boolean;livery:Livery;numberStyle:NumberStyle;lighting:Lighting;milestones:{id:string;completedAt:string}[];leaderboard:{alias:string;completed:number;self:boolean}[]}
const milestoneInput=z.object({milestone:z.enum(CAREER_MILESTONES),answer:z.string().min(1).max(64)}).strict();
const profileInput=z.object({alias:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/),optIn:z.boolean(),livery:z.enum(LIVERIES),numberStyle:z.enum(NUMBER_STYLES).default('classic'),lighting:z.enum(LIGHTING).default('workshop')}).strict();
export class Career {
 constructor(readonly db:Db){}
 private async execute(actor:Actor,sql:string,values:unknown[]=[]){return this.db.transaction(async tx=>(await tx.query<{value:CareerState}>(sql,values)).rows[0].value,actor);}
 async state(actor:Actor){return this.execute(actor,'select pitlane.career_state() as value');}
 async complete(actor:Actor,input:unknown){const v=milestoneInput.parse(input);return this.execute(actor,'select pitlane.complete_career_milestone($1,$2) as value',[v.milestone,v.answer]);}
 async profile(actor:Actor,input:unknown){const v=profileInput.parse(input);return this.execute(actor,'select pitlane.update_career_profile($1,$2,$3,$4,$5) as value',[v.alias,v.optIn,v.livery,v.numberStyle,v.lighting]);}
}
