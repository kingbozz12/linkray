
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const modal=$('#loginModal'), dash=$('#dashboardDemo'), toast=$('#toast');
function lock(v){document.body.classList.toggle('locked',v)}
function openLogin(){modal.classList.add('open');lock(true)}
function closeLogin(){modal.classList.remove('open');if(!dash.classList.contains('open'))lock(false)}
function openDash(){closeLogin();dash.classList.add('open');lock(true)}
function closeDash(){dash.classList.remove('open');lock(false)}
$$('[data-login]').forEach(b=>b.addEventListener('click',openLogin));
$('#closeLogin').addEventListener('click',closeLogin);modal.addEventListener('click',e=>{if(e.target===modal)closeLogin()});
$('#openCabinetDemo').addEventListener('click',openDash);$('#openCabinetDemo2').addEventListener('click',openDash);$('#closeDashboard').addEventListener('click',closeDash);$('#closeDashboardMobile').addEventListener('click',closeDash);
$('#loginForm').addEventListener('submit',e=>{e.preventDefault();openDash();showToast('Открыт демонстрационный кабинет LinkRay')});
$('#menuBtn').addEventListener('click',()=>$('#navLinks').classList.toggle('mobile-open'));
$$('#navLinks a').forEach(a=>a.addEventListener('click',()=>$('#navLinks').classList.remove('mobile-open')));
$$('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>{$$('.tab-btn').forEach(x=>x.classList.remove('active'));$$('.product-panel').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$('#product-'+btn.dataset.product).classList.add('active')}));
$$('.dash-nav button[data-tab]').forEach(btn=>btn.addEventListener('click',()=>{$$('.dash-nav button[data-tab]').forEach(x=>x.classList.remove('active'));$$('.dash-content').forEach(x=>x.classList.remove('active'));btn.classList.add('active');$('#tab-'+btn.dataset.tab).classList.add('active');$('#dashTitle').textContent=btn.dataset.title}));
$$('[data-demo-action]').forEach(btn=>btn.addEventListener('click',()=>showToast(btn.dataset.demoAction+' будет подключено к текущему боту после утверждения')));
function showToast(t){toast.textContent=t;toast.classList.add('show');setTimeout(()=>toast.classList.remove('show'),2800)}
window.addEventListener('keydown',e=>{if(e.key==='Escape'){closeLogin();closeDash()}});
