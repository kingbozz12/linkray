const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const modal=$('#loginModal'), dash=$('#dashboardDemo'), toast=$('#toast');
const state={session:null,data:null,login:'',loading:false};
const nf=new Intl.NumberFormat('ru-RU');
const df=new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

function lock(v){document.body.classList.toggle('locked',v)}
function showToast(text,type='ok'){toast.textContent=text;toast.dataset.type=type;toast.classList.add('show');clearTimeout(showToast.timer);showToast.timer=setTimeout(()=>toast.classList.remove('show'),3200)}
function setButtonLoading(button,loading,text){if(!button)return;button.disabled=loading;if(loading){button.dataset.old=button.innerHTML;button.innerHTML=`<span class="mini-spinner"></span> ${text||'Подождите'}`}else if(button.dataset.old){button.innerHTML=button.dataset.old;delete button.dataset.old}}
function escapeHtml(value){const el=document.createElement('div');el.textContent=String(value??'');return el.innerHTML}
function formatNumber(value){return nf.format(Number(value||0))}
function formatSigned(value){const n=Number(value||0);return `${n>0?'+':''}${nf.format(n)}`}
function formatDate(value){if(!value)return '—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':df.format(d)}
function initials(name){const parts=String(name||'L').trim().split(/\s+/).filter(Boolean);return (parts.slice(0,2).map(x=>x[0]).join('')||'L').toUpperCase()}
function pill(text,kind=''){return `<span class="pill ${kind}">${escapeHtml(text)}</span>`}
function errorText(error){return error?.message||'Произошла ошибка'}

async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.ok===false){const error=new Error(data.message||`Ошибка ${response.status}`);error.status=response.status;error.code=data.error;throw error}
  return data;
}

function openLogin(){
  $('#loginError').hidden=true;
  modal.classList.add('open');lock(true);
  setTimeout(()=>$('#loginId')?.focus(),100);
}
function closeLogin(){modal.classList.remove('open');if(!dash.classList.contains('open'))lock(false)}
async function openDash(){
  if(!state.session?.authenticated){openLogin();return}
  closeLogin();dash.classList.add('open');lock(true);await loadDashboard();
}
function closeDash(){dash.classList.remove('open');lock(false)}
function setLoginStep(step){
  $('#loginStepRequest').hidden=step!=='request';$('#loginStepVerify').hidden=step!=='verify';
  $('#loginError').hidden=true;
  setTimeout(()=>$(step==='verify'?'#loginCode':'#loginId')?.focus(),80);
}
function showLoginError(text){const el=$('#loginError');el.textContent=text;el.hidden=false}

async function checkSession(){
  try{state.session=await api('/api/web/session');}
  catch{state.session={authenticated:false}}
  updateAccountButtons();
}
function updateAccountButtons(){
  $$('[data-login]').forEach(button=>{
    const label=state.session?.authenticated?'Открыть кабинет':'Личный кабинет';
    const textNodes=[...button.childNodes].filter(n=>n.nodeType===Node.TEXT_NODE);
    if(textNodes.length)textNodes.at(-1).textContent=` ${label}`;
  });
}

async function requestCode(){
  const login=$('#loginId').value.trim();
  if(!/^\d+$/.test(login)){showLoginError('Введите числовой ID LinkRay или MAX ID');return}
  const button=$('#requestCodeBtn');setButtonLoading(button,true,'Отправляем код');
  try{
    await api('/api/web/auth/request-code',{method:'POST',body:JSON.stringify({login})});
    state.login=login;setLoginStep('verify');showToast('Код отправлен личным сообщением в MAX');
  }catch(error){showLoginError(errorText(error))}
  finally{setButtonLoading(button,false)}
}
async function verifyCode(){
  const code=$('#loginCode').value.trim();
  if(!/^\d{6}$/.test(code)){showLoginError('Введите код из 6 цифр');return}
  const button=$('#verifyCodeBtn');setButtonLoading(button,true,'Входим');
  try{
    await api('/api/web/auth/verify',{method:'POST',body:JSON.stringify({login:state.login||$('#loginId').value.trim(),code})});
    await checkSession();closeLogin();dash.classList.add('open');lock(true);showToast('Вход выполнен');await loadDashboard(true);
  }catch(error){showLoginError(errorText(error))}
  finally{setButtonLoading(button,false)}
}
async function logout(){
  try{await api('/api/web/logout',{method:'POST',body:'{}'})}catch{}
  state.session={authenticated:false};state.data=null;updateAccountButtons();closeDash();showToast('Вы вышли из кабинета');
}

function showDashboardLoading(value){
  $('#dashboardLoading').style.display=value?'flex':'none';
  $$('.dash-content').forEach(el=>el.classList.toggle('content-muted',value));
}
async function loadDashboard(force=false){
  if(state.loading)return;if(state.data&&!force){renderDashboard(state.data);return}
  state.loading=true;showDashboardLoading(true);$('#dashboardError').hidden=true;
  try{
    const result=await api('/api/web/dashboard');state.data=result.data;renderDashboard(state.data);
  }catch(error){
    if(error.status===401){state.session={authenticated:false};updateAccountButtons();closeDash();openLogin();showLoginError('Сессия закончилась. Войдите снова');}
    else{$('#dashboardError').textContent=errorText(error);$('#dashboardError').hidden=false;showToast(errorText(error),'error')}
  }finally{state.loading=false;showDashboardLoading(false)}
}

function renderDashboard(data){
  const user=data.user||{},ov=data.overview||{},analytics=data.analytics||{},af=data.antifraud||{};
  $('#dashUserName').textContent=user.displayName||`LinkRay ID ${user.id}`;
  $('#dashUserAvatar').textContent=initials(user.displayName);
  $('#dashboardUpdated').textContent=`Обновлено ${formatDate(data.generatedAt)}`;
  $('#ovChannels').textContent=formatNumber(ov.channels);
  $('#ovSubscribers').textContent=formatNumber(ov.subscribers);
  $('#ovDelta').textContent=formatSigned(ov.deltaDay);$('#ovDelta').className=Number(ov.deltaDay)>=0?'up':'down';
  $('#ovScheduled').textContent=formatNumber(ov.scheduled);
  $('#overviewViews').textContent=`Просмотры 24ч: ${formatNumber(ov.views24)}`;
  $('#anSubscribers').textContent=formatNumber(analytics.subscribers);
  $('#anDelta').textContent=formatSigned(analytics.deltaDay);$('#anDelta').className=Number(analytics.deltaDay)>=0?'up':'down';
  $('#anViews').textContent=formatNumber(analytics.views24);
  $('#anEr').textContent=`${Number(analytics.er24||0).toFixed(2).replace('.',',')}%`;
  renderChart('#audienceChart',analytics.days||[],'subscribers');
  renderChart('#analyticsChart',analytics.days||[],'views24');
  renderChannels(data.channels||[]);
  renderPosts(data.posts||[]);
  renderAntifraud(af);
  renderProfile(user,ov);
  renderServices(data);
}

function renderChart(selector,days,key){
  const root=$(selector);if(!root)return;
  if(!days.length){root.innerHTML='<div class="empty-inline">Данные появятся после накопления аналитики</div>';return}
  const values=days.map(d=>Number(d[key]||0));const max=Math.max(...values,1),min=Math.min(...values,0);const range=Math.max(1,max-min);
  const width=900,height=240,pad=18;
  const points=values.map((value,index)=>{const x=pad+(index*(width-pad*2)/Math.max(1,values.length-1));const y=height-pad-((value-min)/range)*(height-pad*2);return `${x.toFixed(1)},${y.toFixed(1)}`}).join(' ');
  const labels=days.slice(-5).map((d,i)=>{const date=new Date(d.day);return `<span>${date.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'})}</span>`}).join('');
  root.innerHTML=`<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="График"><defs><linearGradient id="lrChartFill${key}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6ee7a8" stop-opacity=".28"/><stop offset="1" stop-color="#6ee7a8" stop-opacity="0"/></linearGradient></defs><polygon points="${pad},${height-pad} ${points} ${width-pad},${height-pad}" fill="url(#lrChartFill${key})"/><polyline points="${points}" fill="none" stroke="#6ee7a8" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="chart-labels">${labels}</div><div class="chart-current">${formatNumber(values.at(-1))}</div>`;
}

function renderChannels(channels){
  const body=$('#channelsBody'),empty=$('#channelsEmpty');body.innerHTML='';empty.hidden=channels.length>0;
  for(const channel of channels){
    const tr=document.createElement('tr');
    const analytics=channel.analytics?pill('Собирается'):pill('Нет данных','muted');
    const antifraud=channel.antifraud?.enabled?pill('Активен'):pill('Выключен','red');
    const role=channel.role==='owner'?'Владелец':'Администратор';
    tr.innerHTML=`<td><div class="channel-cell"><span class="table-avatar">${escapeHtml(initials(channel.title))}</span><div><b>${escapeHtml(channel.title)}</b>${channel.link?`<a href="${escapeHtml(channel.link)}" target="_blank" rel="noopener">Открыть канал</a>`:''}</div></div></td><td>${formatNumber(channel.analytics?.subscribers)}</td><td>${analytics}</td><td>${antifraud}</td><td>${escapeHtml(role)}</td>`;
    body.appendChild(tr);
  }
}

function renderPosts(posts){
  const body=$('#postsBody'),empty=$('#postsEmpty');body.innerHTML='';empty.hidden=posts.length>0;
  for(const post of posts){
    const tr=document.createElement('tr');const raw=String(post.statusRaw||'').toLowerCase();const kind=['failed','error','cancelled','canceled'].includes(raw)?'red':(['published','sent','done'].includes(raw)?'':'muted');
    tr.innerHTML=`<td><b>${escapeHtml(post.title)}</b>${post.isAd?'<small class="row-note">Рекламный пост</small>':''}</td><td>${escapeHtml(post.channelTitle)}</td><td>${escapeHtml(formatDate(post.date))}</td><td>${pill(post.status,kind)}</td>`;
    body.appendChild(tr);
  }
}

function renderAntifraud(af){
  const items=af.channels||[],list=$('#antifraudList'),empty=$('#antifraudEmpty');list.innerHTML='';empty.hidden=items.length>0;
  $('#afProtected').textContent=formatNumber(af.protectedChannels);$('#afRisk').textContent=af.currentRisk||'—';$('#afEvents').textContent=formatNumber(af.events24);$('#afUpdated').textContent='Сейчас';
  $('#antifraudRiskPill').textContent=`Риск: ${af.currentRisk||'—'}`;$('#antifraudRiskPill').className=`pill ${af.currentRisk==='Высокий'?'red':af.currentRisk==='Средний'?'warn':''}`;
  for(const item of items){
    const card=document.createElement('article');card.className='af-channel-card';
    const wave=item.latestWave;const details=wave?`Последний наплыв: ${formatDate(wave.startedAt)} · вступило ${formatNumber(wave.joined)} · высокий риск ${formatNumber(wave.high)}`:'Подозрительных наплывов не зафиксировано';
    card.innerHTML=`<div><div class="af-card-title"><span class="table-avatar">${escapeHtml(initials(item.title))}</span><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(details)}</span></div></div></div><label class="switch-control"><input type="checkbox" ${item.enabled?'checked':''} data-antifraud-toggle="${item.channelId}"><span class="switch-ui"></span><b>${item.enabled?'Включён':'Выключен'}</b></label>`;
    list.appendChild(card);
  }
  $$('[data-antifraud-toggle]',list).forEach(input=>input.addEventListener('change',()=>toggleAntifraud(input)));
}

async function toggleAntifraud(input){
  const channelId=input.dataset.antifraudToggle,enabled=input.checked;input.disabled=true;
  try{await api(`/api/web/antifraud/${channelId}/toggle`,{method:'POST',body:JSON.stringify({enabled})});showToast(enabled?'AntiFraud включён':'AntiFraud выключен');await loadDashboard(true)}
  catch(error){input.checked=!enabled;showToast(errorText(error),'error')}
  finally{input.disabled=false}
}

function renderProfile(user,ov){
  $('#profileName').textContent=user.displayName||'—';$('#profileId').textContent=user.id||'—';$('#profileMaxId').textContent=user.maxUserId||'—';$('#profileChannels').textContent=formatNumber(ov.channels);
}
function renderServices(data){
  const root=$('#serviceState');const channels=data.channels||[],af=data.antifraud||{};
  const items=[['Связь с аккаунтом','Активна',true],['Сбор аналитики',channels.some(c=>c.analytics)?'Данные поступают':'Ожидает данные',channels.some(c=>c.analytics)],['AntiFraud',af.protectedChannels?`Защищено каналов: ${af.protectedChannels}`:'Не включён',Boolean(af.protectedChannels)],['Публикации',data.overview?.scheduled?`В очереди: ${data.overview.scheduled}`:'Очередь свободна',true]];
  root.innerHTML=items.map(([title,text,ok])=>`<div class="check-item"><span class="check-circle ${ok?'':'inactive'}"><svg class="icon-svg" aria-hidden="true"><use href="#${ok?'i-check':'i-clock'}"></use></svg></span><div><b>${escapeHtml(title)}</b><span>${escapeHtml(text)}</span></div></div>`).join('');
}

$$('[data-login]').forEach(button=>button.addEventListener('click',()=>state.session?.authenticated?openDash():openLogin()));
$('#closeLogin').addEventListener('click',closeLogin);modal.addEventListener('click',event=>{if(event.target===modal)closeLogin()});
$('#loginRequestForm').addEventListener('submit',event=>{event.preventDefault();requestCode()});
$('#loginVerifyForm').addEventListener('submit',event=>{event.preventDefault();verifyCode()});
$('#changeLoginBtn').addEventListener('click',()=>setLoginStep('request'));
$('#resendCodeBtn').addEventListener('click',()=>{setLoginStep('request');$('#loginId').value=state.login||'';requestCode()});
$('#closeDashboard').addEventListener('click',closeDash);$('#closeDashboardMobile').addEventListener('click',closeDash);
$('#refreshDashboard').addEventListener('click',()=>loadDashboard(true));$('#logoutBtn').addEventListener('click',logout);
$('#menuBtn').addEventListener('click',()=>$('#navLinks').classList.toggle('mobile-open'));
$$('#navLinks a').forEach(a=>a.addEventListener('click',()=>$('#navLinks').classList.remove('mobile-open')));
$$('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>{$$('.tab-btn').forEach(x=>x.classList.remove('active'));$$('.product-panel').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$('#product-'+btn.dataset.product)?.classList.add('active')}));
$$('.dash-nav button[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{$$('.dash-nav button[data-tab]').forEach(x=>x.classList.remove('active'));$$('.dash-content').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$('#tab-'+btn.dataset.tab)?.classList.add('active');$('#dashTitle').textContent=btn.dataset.title}));
$$('#openCabinetDemo,#openCabinetDemo2').forEach(button=>button?.addEventListener('click',()=>state.session?.authenticated?openDash():openLogin()));
window.addEventListener('keydown',event=>{if(event.key==='Escape'){closeLogin();closeDash()}});
checkSession();
