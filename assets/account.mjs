import { loadGoogleIdentity } from './imports/google.mjs';
import { toBase64 } from './vault.mjs';
export async function emailMapId(email) {
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode('kyn-email:v1:'+email.trim().toLowerCase()));
  return 'email:'+Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
export function googleMapSecret(account, record) {
  if (!/^google:[A-Za-z0-9_-]{43}$/.test(account.id) || !/^[A-Za-z0-9_-]{43}$/.test(account.unlockPart)) throw new Error('Google sign-in returned an invalid account.');
  if (record && (record.id !== account.id || record.auth?.method !== 'google' || !/^[A-Za-z0-9+/]{43}=$/.test(record.auth.deviceSeed))) throw new Error('This Google map cannot be opened on this device.');
  const auth = record?.auth || {method:'google',deviceSeed:toBase64(crypto.getRandomValues(new Uint8Array(32)))};
  return {auth,password:'google-map:v1:'+account.unlockPart+':'+auth.deviceSeed};
}
export async function mountGoogleSignIn(element, config, onSuccess, onError, onBusy) {
  if (!config.googleClientId || !config.callbackOrigin) throw new Error('Google sign-in is not configured. You can use email and a map password.');
  await loadGoogleIdentity();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
  let active=false;
  google.accounts.id.initialize({client_id:config.googleClientId,nonce,auto_select:false,callback:async result=>{
    if(active)return;
    active=true;
    onBusy(true);
    let account;
    try {
      const response = await fetch(config.callbackOrigin+'/v1/auth/google',{method:'POST',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:result.credential,nonce}),signal:AbortSignal.timeout(110000)});
      if (!response.ok) throw new Error('Google sign-in could not finish. Please try again.');
      account = await response.json();
      await onSuccess(account);
    } catch(error) {onError(error);} finally {if(account)account.unlockPart="";active=false;onBusy(false);}
  }});
  google.accounts.id.renderButton(element,{theme:'filled_black',size:'large',shape:'pill',text:'continue_with',width:300});
}
