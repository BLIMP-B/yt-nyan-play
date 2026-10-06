function validWebhook(value) {
  try {
    const u = new URL(String(value || '').trim().replace(/^<|>$/g, ''));
    return u.protocol === 'https:' && !u.username && !u.password && ['discord.com','discordapp.com'].includes(u.hostname) && /^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname) ? u.href : null;
  } catch { return null; }
}
async function send(url, content) {
  const target = validWebhook(url); if (!target) throw new Error('DiscordのWebhook URLを設定してください。');
  const response = await fetch(target, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,allowed_mentions:{parse:[]}}),signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw new Error(`送信失敗（HTTP ${response.status}）`);
}
async function registerAdditionalSites() {
  const origins=(await chrome.permissions.getAll()).origins||[];
  const fixed=new Set(chrome.runtime.getManifest().host_permissions);
  const extra=origins.filter(x=>!fixed.has(x)&&/^https:\/\//.test(x)&&x!=='https://*/*');
  const registered=await chrome.scripting.getRegisteredContentScripts();
  const old=registered.filter(x=>x.id.startsWith('nyan-extra-')).map(x=>x.id);
  if(old.length)await chrome.scripting.unregisterContentScripts({ids:old});
  if(extra.length)await chrome.scripting.registerContentScripts(extra.map((origin,i)=>({id:`nyan-extra-${i}`,matches:[origin],js:['media-adapters.js','content-script.js'],runAt:'document_idle',persistAcrossSessions:true})));
}
chrome.runtime.onInstalled.addListener(()=>{registerAdditionalSites().catch(()=>{});});
chrome.runtime.onStartup.addListener(()=>{registerAdditionalSites().catch(()=>{});});
chrome.permissions.onAdded.addListener(()=>{registerAdditionalSites().catch(()=>{});});
chrome.permissions.onRemoved.addListener(()=>{registerAdditionalSites().catch(()=>{});});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((msg,_sender,reply)=>{
  (async()=>{
    if(msg?.type==='OPEN_OPTIONS'){await chrome.runtime.openOptionsPage();return {ok:true};}
    if(msg?.type==='REGISTER_ADDITIONAL_SITES'){await registerAdditionalSites();return {ok:true};}
    if(msg?.type==='ENSURE_DEFAULT_DESTINATIONS')return {ok:true,seeded:false};
    if(msg?.type!=='SEND_TO_DISCORD_WEBHOOKS')return {ok:false,ignored:true};
    if(!Array.isArray(msg.webhookUrls)||!msg.webhookUrls.length||msg.webhookUrls.length>25||typeof msg.content!=='string'||!msg.content.trim()||msg.content.length>2000)return {ok:false,error:'宛先と送信内容を確認してください。'};
    const results=[];
    for(const url of [...new Set(msg.webhookUrls)]){
      try{await send(url,msg.content);results.push({url,ok:true});}
      catch(e){results.push({url,ok:false,error:e.name==='TimeoutError'?'送信がタイムアウトしました。':e.name==='TypeError'?'接続できませんでした。':e.message});}
    }
    return {ok:results.every(r=>r.ok),results};
  })().then(reply,()=>reply({ok:false,error:'処理に失敗しました。'}));
  return true;
});
