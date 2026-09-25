import {newMap,normalizeContact} from './imports/model.mjs';
import {mapData,contactBook,scriptJson} from './community-data.mjs';
import {downloadContacts} from './export.mjs';
export function sampleMap() {
  const data=newMap('fictional-community-demo','Cedar community');
  const names=['Asha Example','Dev Example','Lina Example','Ravi Example','Maya Example','Noor Example','Sam Example','Isha Example'];
  const roles=['Engineer','Designer','Founder','Teacher','Doctor','Investor','Product manager','Architect'];
  const blocks=['Cedar','Maple','Willow','Pine','Oak','Birch'];
  data.contacts=Array.from({length:48},(_,i)=>normalizeContact({name:i<8?names[i]:`Neighbor ${String(i+1).padStart(2,'0')}`,emails:[`neighbor${i+1}@example.test`],company:['Example Labs','Sample Studio','Demo Collective'][i%3],role:roles[i%8],unit:String(101+Math.floor(i/6)),block:blocks[i%6]},'CSV'));
  return data;
}
export async function showSampleMap() {
  const data=sampleMap();
  document.getElementById('sample-export').onclick=()=>downloadContacts(data.contacts,'sample-community.csv');
  const response=await fetch('assets/community-renderer.html');
  if(!response.ok)throw new Error('Sample unavailable');
  const template=await response.text();
  document.getElementById('sample-map').srcdoc=template.replace('__COMMUNITY_DATA__',()=>scriptJson(mapData(data))).replace('__COMMUNITY_OWNER__',()=>scriptJson(data.displayName)).replace('__COMMUNITY_CONTACTS__',()=>scriptJson(contactBook(data)));
  document.getElementById('sample-loading').hidden=true;
}
