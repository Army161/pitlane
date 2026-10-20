import {notFound} from 'next/navigation';
import Workshop from '../../ui/workshop';
import {Landing} from '../../ui/racing';
export default async function Page({params}:{params:Promise<{section?:string[]}>}){
 const {section=[]}=await params;if(!section.length)return <Landing/>;const name=section[0];
 if(!['onboarding','career','garage','crew','records','agents','sprints','treasury','book','manual'].includes(name)||section.length>2||section.length===2&&(name!=='records'||!/^[0-9a-f-]{36}$/.test(section[1])))notFound();
 return <Workshop section={name} receiptId={section[1]}/>;
}
