import {text} from './imports/model.mjs';
const qid = id => /^Q[1-9]\d*$/.test(id || '');
const login = name => /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(name || '');
const label = entity => text(entity?.labels?.en?.value);
function values(entity, property) {
  const claims = (entity?.claims?.[property] || []).filter(c => c.rank !== 'deprecated' && !c.qualifiers?.P582);
  const preferred = claims.filter(c => c.rank === 'preferred');
  return (preferred.length ? preferred : claims).map(c => c.mainsnak?.datavalue?.value?.id).filter(qid);
}
export function profileURL(source, id) {
  if (source === 'Wikidata' && qid(id)) return `https://www.wikidata.org/wiki/${id}`;
  if (source === 'GitHub' && login(id)) return `https://github.com/${id}`;
  throw new Error('Unsupported public profile.');
}
// Queries are deliberately individual, explicit and name-only. No map, email,
// phone, OAuth token or residency data is ever sent to these public services.
export async function searchProfiles(query, source, {signal, request = fetch} = {}) {
  query = text(query).slice(0, 100);
  if (query.length < 2) throw new Error('Enter a name with at least two characters.');
  const timeout = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  async function json(url) {
    const response = await request(url, {signal: combined, credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer'});
    if (response.status === 403 || response.status === 429) throw new Error('This public source has reached its free request limit. Please try later.');
    if (!response.ok) throw new Error('The public source is unavailable. Your map has not changed.');
    const data = await response.json();
    if (data.error) throw new Error('The public source could not complete the search. Please try later.');
    return data;
  }
  if (source === 'Wikidata') {
    const wiki = params => json('https://www.wikidata.org/w/api.php?' + new URLSearchParams({format:'json', origin:'*', ...params}));
    const found = await wiki({action:'wbsearchentities',search:query,language:'en',type:'item',limit:'5'});
    const ids = (found.search || []).map(x=>x.id).filter(qid).slice(0,5);
    if (!ids.length) return [];
    const entities = (await wiki({action:'wbgetentities',ids:ids.join('|'),props:'labels|descriptions|claims',languages:'en'})).entities || {};
    const humans = ids.map(id=>entities[id]).filter(e=>e && values(e,'P31').includes('Q5'));
    const facts = [...new Set(humans.flatMap(e=>[...values(e,'P106'),...values(e,'P108')]))].slice(0,50);
    const labels = facts.length ? (await wiki({action:'wbgetentities',ids:facts.join('|'),props:'labels',languages:'en'})).entities : {};
    return humans.map(e=>({source,id:e.id,name:label(e),description:text(e.descriptions?.en?.value),role:values(e,'P106').map(id=>label(labels?.[id])).filter(Boolean).join(', '),company:values(e,'P108').map(id=>label(labels?.[id])).filter(Boolean).join(', '),url:profileURL(source,e.id)}));
  }
  if (source === 'GitHub') {
    // Quote the name and remove search operators; use only public user profiles.
    const name = query.replace(/[^\p{L}\p{N}\s.'-]/gu,' ').trim();
    if (name.length < 2) throw new Error('Enter a person’s name.');
    const found = await json('https://api.github.com/search/users?' + new URLSearchParams({q:`"${name}" in:fullname type:user`,per_page:'3'}));
    const results = [];
    for (const item of (found.items || []).slice(0,3)) {
      if (!login(item.login)) continue;
      const p = await json(`https://api.github.com/users/${item.login}`);
      if (p.type !== 'User') continue;
      results.push({source,id:p.login,name:text(p.name)||p.login,description:text(p.bio),role:'',company:text(p.company),url:profileURL(source,p.login)});
    }
    return results;
  }
  throw new Error('Choose a supported public source.');
}
export function applyEnrichment(dataset, ownerId, contactId, candidate, {role, company, confirmed} = {}) {
  if (dataset.ownerId !== ownerId) throw new Error('This map belongs to another account.');
  if (!confirmed) throw new Error('Confirm the person and profession before saving.');
  const contact = dataset.contacts.find(c=>c.id===contactId);
  if (!contact) throw new Error('This contact is no longer in your map.');
  if (!text(role)) throw new Error('Enter the profession supported by this profile.');
  const enrichment = {source:candidate.source,profileId:candidate.id,url:profileURL(candidate.source,candidate.id),name:text(candidate.name),description:text(candidate.description),role:text(role),company:text(company),sourceRole:text(candidate.role),sourceCompany:text(candidate.company),confirmedAt:new Date().toISOString(),confidence:'Confirmed by you'};
  return {...dataset,contacts:dataset.contacts.map(c=>c.id===contactId?{...c,enrichment}:c)};
}
export function removeEnrichment(dataset, ownerId, contactId) {
  if (dataset.ownerId !== ownerId) throw new Error('This map belongs to another account.');
  return {...dataset,contacts:dataset.contacts.map(c=>{
    if (c.id!==contactId) return c;
    const {enrichment, ...original}=c;
    return original;
  })};
}
