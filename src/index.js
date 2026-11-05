const JSON_HEADERS = {"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const enc = new TextEncoder();
const json = (body,status=200,extra={}) => new Response(JSON.stringify(body),{status,headers:{...JSON_HEADERS,...extra}});
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const randomToken = (n=32) => { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
const sha256 = async s => b64url(await crypto.subtle.digest("SHA-256",enc.encode(s)));
const passwordHash = async (password,salt,iterations=210000) => {
 const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
 return b64url(await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations,hash:"SHA-256"},key,256));
};
const parseCookie = (request,name) => (request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="))?.slice(name.length+1);
const bodyJson = async req => { try { return await req.json(); } catch { return null; } };
const validEmail = s => typeof s==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length<=254;
const slugify = s => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,50);
async function currentAdmin(request,env){
 const token=parseCookie(request,"q_session"); if(!token)return null;
 const row=await env.DB.prepare("SELECT a.id,a.email FROM sessions s JOIN admin_users a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?").bind(await sha256(token),Math.floor(Date.now()/1000)).first();
 return row||null;
}

const escapeHtml = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const numberWords = n => {
 const ones=["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
 const tens=["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
 const under1000=x=>{let out=[];if(x>=100){out.push(ones[Math.floor(x/100)],"hundred");x%=100;}if(x>=20){out.push(tens[Math.floor(x/10)]);if(x%10)out.push(ones[x%10]);}else if(x>0)out.push(ones[x]);return out.join(" ");};
 if(!Number.isSafeInteger(n)||n<0||n>999999999)return "amount not available";
 if(n===0)return "zero";
 let parts=[];for(const [v,label] of [[1000000,"million"],[1000,"thousand"],[1,""]]){const q=Math.floor(n/v);if(q){parts.push(under1000(q)+(label?" "+label:""));n%=v;}}
 return parts.join(" ");
};
const DEFAULT_TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><title>Quotation {{quote_number}}</title><style>
body{font-family:Arial,sans-serif;color:#202020;margin:0;padding:36px}header{display:flex;justify-content:space-between;border-bottom:2px solid #222;padding-bottom:18px}h1{font-size:24px;margin:0 0 8px}.meta{ text-align:right}table{width:100%;border-collapse:collapse;margin:26px 0}td,th{border:1px solid #777;padding:11px;text-align:left}th{background:#f0f0f0}.amount{font-size:18px;font-weight:bold}.foot{margin-top:48px;font-size:12px;color:#555}@media print{body{padding:15mm}button{display:none}}
</style></head><body><header><div><h1>{{company_name}}</h1><div>{{company_address}}</div><div>{{company_phone}} · {{company_email}}</div></div><div class="meta"><b>QUOTATION</b><div>{{quote_number}}</div><div>{{quote_date}}</div></div></header><table><tr><th>Vehicle / Model</th><td>{{model}}</td></tr><tr><th>Year</th><td>{{year}}</td></tr><tr><th>Chassis Number</th><td>{{chassis}}</td></tr><tr><th>Estimated Market Value</th><td class="amount">{{currency}} {{amount}}</td></tr></table><p>Estimated market value as of {{quote_date}} is {{currency}} {{amount}} ({{amount_words}} only).</p><p>We trust the above is in order.</p><div class="foot">{{company_name}} · {{company_address}}</div><script>window.onload=()=>{if(new URLSearchParams(location.search).has("print"))window.print()}</script></body></html>`;
const renderQuote = (html,fields) => html.replace(/\\{\\{([a-z_]+)\\}\\}/g,(_,k)=>escapeHtml(fields[k]??""));

async function handleApi(request,env,url){
 if(url.pathname==="/api/health" && request.method==="GET"){
  try{const r=await env.DB.prepare("SELECT 1 AS ok").first();return json({ok:r?.ok===1,service:"challenger-quotation-platform",version:"0.2.0"});}
  catch{return json({ok:false,error:"database_unavailable"},503);}
 }
 if(url.pathname==="/api/setup" && request.method==="POST"){
  if(!env.BOOTSTRAP_SECRET)return json({error:"setup_secret_not_configured"},503);
  const body=await bodyJson(request); if(!body||request.headers.get("x-setup-secret")!==env.BOOTSTRAP_SECRET)return json({error:"unauthorized"},401);
  if(!validEmail(body.email)||typeof body.password!=="string"||body.password.length<14)return json({error:"valid_email_and_password_minimum_14_characters_required"},400);
  const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first();
  if(count.n>0)return json({error:"setup_already_completed"},409);
  const id=crypto.randomUUID(),salt=randomToken(16),hash=await passwordHash(body.password,salt);
  await env.DB.prepare("INSERT INTO admin_users(id,email,password_salt,password_hash) VALUES(?,?,?,?)").bind(id,body.email,salt,hash).run();
  return json({created:true,message:"Administrator created. Sign in at /api/auth/login"},201);
 }
 if(url.pathname==="/api/auth/login" && request.method==="POST"){
  const body=await bodyJson(request);if(!body||!validEmail(body.email)||typeof body.password!=="string")return json({error:"invalid_credentials"},400);
  const ip=request.headers.get("CF-Connecting-IP")||"unknown",ipHash=await sha256(ip),now=Math.floor(Date.now()/1000);
  await env.DB.prepare("DELETE FROM login_attempts WHERE attempted_at<?").bind(now-900).run();
  const attempts=await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash=? AND attempted_at>?").bind(ipHash,now-900).first();
  if(attempts.n>=10)return json({error:"too_many_attempts"},429);
  await env.DB.prepare("INSERT INTO login_attempts(ip_hash,attempted_at) VALUES(?,?)").bind(ipHash,now).run();
  const admin=await env.DB.prepare("SELECT id,email,password_salt,password_hash,password_iterations FROM admin_users WHERE email=? COLLATE NOCASE").bind(body.email).first();
  const actual=admin?await passwordHash(body.password,admin.password_salt,admin.password_iterations):await passwordHash(body.password,"dummy-salt");
  if(!admin||actual!==admin.password_hash)return json({error:"invalid_credentials"},401);
  const token=randomToken(32),expires=now+SESSION_SECONDS;
  await env.DB.prepare("INSERT INTO sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)").bind(await sha256(token),admin.id,expires).run();
  await env.DB.prepare("UPDATE admin_users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?").bind(admin.id).run();
  return json({authenticated:true,admin:{id:admin.id,email:admin.email}},200,{"set-cookie":`q_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`});
 }
 if(url.pathname==="/api/auth/logout" && request.method==="POST"){
  const token=parseCookie(request,"q_session");if(token)await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
  return json({authenticated:false},200,{"set-cookie":"q_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"});
 }
 if(url.pathname==="/api/auth/me" && request.method==="GET"){
  const admin=await currentAdmin(request,env);return json({authenticated:!!admin,admin:admin||null});
 }
 const admin=await currentAdmin(request,env);if(!admin)return json({error:"unauthorized"},401);
 if(url.pathname==="/api/companies" && request.method==="GET"){
  const result=await env.DB.prepare("SELECT id,name,slug,legal_name,phone,email,address,quotation_prefix,currency,logo_key,letterhead_key,font_name,active,created_at FROM companies ORDER BY name").all();
  return json({companies:result.results});
 }
 if(url.pathname==="/api/companies" && request.method==="POST"){
  const body=await bodyJson(request);
  if(!body||typeof body.name!=="string"||body.name.trim().length<2||body.name.length>120)return json({error:"company_name_required"},400);
  const slug=slugify(body.slug||body.name);if(!slug)return json({error:"invalid_company_slug"},400);
  const id=crypto.randomUUID();
  try{
   await env.DB.prepare("INSERT INTO companies(id,name,slug,legal_name,phone,email,address,quotation_prefix,currency) VALUES(?,?,?,?,?,?,?,?,?)")
    .bind(id,body.name.trim(),slug,String(body.legal_name||""),String(body.phone||""),String(body.email||""),String(body.address||""),String(body.quotation_prefix||"QA-").slice(0,12),String(body.currency||"AED").slice(0,3)).run();
  }catch(e){return json({error:"company_slug_already_exists_or_invalid"},409);}
  return json({company:{id,name:body.name.trim(),slug}},201);
 }

 if(url.pathname==="/api/quotations" && request.method==="GET"){
  const companyId=url.searchParams.get("company_id");if(!companyId)return json({error:"company_id_required"},400);
  const q=url.searchParams.get("q")||"",limit=Math.min(Math.max(Number(url.searchParams.get("limit")||50),1),100);
  const rows=await env.DB.prepare("SELECT id,quote_number,quote_date,model,year,chassis,amount_cents,created_at FROM quotations WHERE company_id=? AND deleted_at IS NULL AND (quote_number LIKE ? OR model LIKE ? OR chassis LIKE ?) ORDER BY quote_date DESC,created_at DESC LIMIT ?")
   .bind(companyId,"%"+q+"%","%"+q+"%","%"+q+"%",limit).all();
  return json({quotations:rows.results});
 }
 if(url.pathname==="/api/quotations" && request.method==="POST"){
  const b=await bodyJson(request);
  if(!b||!b.company_id||typeof b.model!=="string"||!b.model.trim()||typeof b.year!=="string"||!b.year.trim()||typeof b.chassis!=="string"||!b.chassis.trim())return json({error:"company_model_year_and_chassis_required"},400);
  const amount=Number(b.amount);if(!Number.isFinite(amount)||amount<0||amount>99999999.99)return json({error:"invalid_amount"},400);
  const date=typeof b.quote_date==="string"?b.quote_date:new Date().toISOString().slice(0,10);
  if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||Number.isNaN(Date.parse(date+"T00:00:00Z")))return json({error:"invalid_quote_date"},400);
  const company=await env.DB.prepare("SELECT * FROM companies WHERE id=? AND active=1").bind(b.company_id).first();
  if(!company)return json({error:"company_not_found"},404);
  const cents=Math.round(amount*100),whole=Math.floor(cents/100),fraction=cents%100;
  const words=numberWords(whole)+(fraction?" and "+numberWords(fraction)+" fils":"");
  const id=crypto.randomUUID(),period=date.slice(0,4),prefix=company.quotation_prefix||"QA-";
  const template=await env.DB.prepare("SELECT id,html FROM templates WHERE company_id=? AND active=1 ORDER BY version DESC LIMIT 1").bind(company.id).first();
  const templateHtml=template?.html||DEFAULT_TEMPLATE;
  const sequenceUpdate=env.DB.prepare("INSERT INTO quote_sequences(company_id,period,last_number) VALUES(?,?,1) ON CONFLICT(company_id,period) DO UPDATE SET last_number=last_number+1").bind(company.id,period);
  const sequenceRead=env.DB.prepare("SELECT last_number FROM quote_sequences WHERE company_id=? AND period=?").bind(company.id,period);
  const results=await env.DB.batch([sequenceUpdate,sequenceRead]);
  const serial=String(results[1].results?.[0]?.last_number||1).padStart(5,"0");
  const quoteNumber=typeof b.quote_number==="string"&&b.quote_number.trim()?b.quote_number.trim():prefix+period+"-"+serial;
  const companySnapshot={name:company.name,legal_name:company.legal_name,address:company.address,phone:company.phone,email:company.email,currency:company.currency};
  try{
   await env.DB.prepare("INSERT INTO quotations(id,company_id,template_id,quote_number,quote_date,model,year,chassis,amount_cents,amount_words,template_html_snapshot,company_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,company.id,template?.id||null,quoteNumber,date,b.model.trim().slice(0,120),b.year.trim().slice(0,20),b.chassis.trim().slice(0,120),cents,words,templateHtml,JSON.stringify(companySnapshot)).run();
  }catch(e){return json({error:"quotation_number_already_exists_or_save_failed"},409);}
  return json({quotation:{id,quote_number:quoteNumber,quote_date:date,model:b.model.trim(),year:b.year.trim(),chassis:b.chassis.trim(),amount_cents:cents,amount_words:words}},201);
 }
 const printMatch=url.pathname.match(/^\\/api\\/quotations\\/([a-f0-9-]+)\\/print$/i);
 if(printMatch && request.method==="GET"){
  const row=await env.DB.prepare("SELECT q.*,c.name AS current_company_name FROM quotations q JOIN companies c ON c.id=q.company_id WHERE q.id=? AND q.deleted_at IS NULL").bind(printMatch[1]).first();
  if(!row)return json({error:"quotation_not_found"},404);
  let company={};try{company=JSON.parse(row.company_snapshot_json||"{}")}catch{}
  const fields={quote_number:row.quote_number,quote_date:row.quote_date,model:row.model,year:row.year,chassis:row.chassis,amount:(row.amount_cents/100).toFixed(2),amount_words:row.amount_words,currency:company.currency||"AED",company_name:company.legal_name||company.name||row.current_company_name,company_address:company.address||"",company_phone:company.phone||"",company_email:company.email||""};
  return new Response(renderQuote(row.template_html_snapshot||DEFAULT_TEMPLATE,fields),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"}});
 }
 const detailMatch=url.pathname.match(/^\\/api\\/quotations\\/([a-f0-9-]+)$/i);
 if(detailMatch && request.method==="GET"){
  const row=await env.DB.prepare("SELECT id,company_id,quote_number,quote_date,model,year,chassis,amount_cents,amount_words,created_at FROM quotations WHERE id=? AND deleted_at IS NULL").bind(detailMatch[1]).first();
  return row?json({quotation:row}):json({error:"quotation_not_found"},404);
 }
 if(detailMatch && request.method==="DELETE"){
  await env.DB.prepare("UPDATE quotations SET deleted_at=CURRENT_TIMESTAMP WHERE id=? AND deleted_at IS NULL").bind(detailMatch[1]).run();
  return json({deleted:true});
 }

 if(url.pathname==="/api/companies" && request.method==="DELETE"){
  const id=url.searchParams.get("id");if(!id)return json({error:"company_id_required"},400);
  await env.DB.prepare("UPDATE companies SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
  return json({deactivated:true});
 }
 return json({error:"not_found"},404);
}
export default {async fetch(request,env){
 const url=new URL(request.url);
 if(url.pathname.startsWith("/api/")){
  try{return await handleApi(request,env,url);}catch(e){return json({error:"internal_error"},500);}
 }
 return new Response("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Challenger Quotation Platform</title><style>\n:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f3f5f8}*{box-sizing:border-box}body{margin:0}.shell{max-width:1000px;margin:48px auto;padding:0 22px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}.eyebrow{font-size:11px;letter-spacing:.16em;color:#64748b;font-weight:700}h1{font-size:32px;margin:8px 0}.muted{color:#667085}.panel{background:#fff;border:1px solid #e5e9f0;border-radius:14px;padding:22px;margin:18px 0}input,select{width:100%;padding:11px;border:1px solid #d0d5dd;border-radius:8px;margin:6px 0 14px}label{font-size:13px;font-weight:600}button{border:0;background:#172b4d;color:white;border-radius:8px;padding:11px 16px;cursor:pointer;font-weight:600}.secondary{background:#e9edf3;color:#172033}.row{display:flex;gap:12px;align-items:center}.row>*{flex:1}.hidden{display:none}.notice{padding:10px;background:#fef3f2;color:#b42318;border-radius:8px;margin:12px 0}.company{padding:14px;border:1px solid #eaecf0;border-radius:10px;margin:10px 0;display:flex;justify-content:space-between}.pill{font-size:12px;color:#17663b;background:#e5f5ec;padding:6px 10px;border-radius:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:650px){.grid{grid-template-columns:1fr}.row{display:block}header{align-items:flex-start;flex-direction:column}}\n</style></head><body><main class=\"shell\"><header><div><p class=\"eyebrow\">CHALLENGER QUOTATION PLATFORM</p><h1>Administration</h1><p class=\"muted\">Central control for company quotation workspaces.</p></div><span class=\"pill\" id=\"status\">Cloudflare Worker</span></header>\n<section class=\"panel\" id=\"login\"><h2>Administrator sign in</h2><form id=\"loginForm\"><label>Email</label><input name=\"email\" type=\"email\" required autocomplete=\"username\"><label>Password</label><input name=\"password\" type=\"password\" required autocomplete=\"current-password\"><button>Sign in</button></form><p id=\"loginError\" class=\"notice hidden\"></p><p class=\"muted\">Initial setup must be completed using the protected bootstrap API.</p></section>\n<section class=\"panel hidden\" id=\"dashboard\"><div class=\"row\"><h2>Companies</h2><button class=\"secondary\" id=\"logout\">Sign out</button></div><form id=\"companyForm\"><div class=\"grid\"><div><label>Company name</label><input name=\"name\" required minlength=\"2\"></div><div><label>URL slug (optional)</label><input name=\"slug\" placeholder=\"company-name\"></div><div><label>Quotation prefix</label><input name=\"quotation_prefix\" value=\"QA-\"></div><div><label>Currency</label><input name=\"currency\" value=\"AED\" maxlength=\"3\"></div><div><label>Email</label><input name=\"email\" type=\"email\"></div><div><label>Phone</label><input name=\"phone\"></div></div><label>Address</label><input name=\"address\"><button>Add company</button></form><p id=\"companyError\" class=\"notice hidden\"></p><div id=\"companies\"></div></section>\n<script>\nconst $=s=>document.querySelector(s);\nasync function api(path,options={}){const r=await fetch(path,{...options,headers:{\"content-type\":\"application/json\",...(options.headers||{})},credentials:\"same-origin\"});const d=await r.json();if(!r.ok)throw Error(d.error||\"Request failed\");return d}\nasync function load(){try{const m=await api(\"/api/auth/me\");$(\"#login\").classList.toggle(\"hidden\",m.authenticated);$(\"#dashboard\").classList.toggle(\"hidden\",!m.authenticated);if(m.authenticated)await companies()}catch(e){$(\"#loginError\").textContent=\"Application API unavailable\";$(\"#loginError\").classList.remove(\"hidden\")}}\nasync function companies(){const d=await api(\"/api/companies\");$(\"#companies\").innerHTML=d.companies.map(c=>'<div class=\"company\"><div><b>'+esc(c.name)+'</b><div class=\"muted\">'+esc(c.slug)+' · '+esc(c.quotation_prefix)+' · '+esc(c.currency)+'</div></div><span class=\"pill\">'+(c.active?'Active':'Inactive')+'</span></div>').join(\"\")||'<p class=\"muted\">No companies created yet.</p>'}\nfunction esc(s){return String(s||\"\").replace(/[&<>\"']/g,c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]))}\n$(\"#loginForm\").addEventListener(\"submit\",async e=>{e.preventDefault();$(\"#loginError\").classList.add(\"hidden\");const f=new FormData(e.target);try{await api(\"/api/auth/login\",{method:\"POST\",body:JSON.stringify(Object.fromEntries(f))});e.target.reset();await load()}catch(err){$(\"#loginError\").textContent=err.message;$(\"#loginError\").classList.remove(\"hidden\")}});\n$(\"#companyForm\").addEventListener(\"submit\",async e=>{e.preventDefault();$(\"#companyError\").classList.add(\"hidden\");try{await api(\"/api/companies\",{method:\"POST\",body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});e.target.reset();e.target.querySelector('[name=quotation_prefix]').value=\"QA-\";e.target.querySelector('[name=currency]').value=\"AED\";await companies()}catch(err){$(\"#companyError\").textContent=err.message;$(\"#companyError\").classList.remove(\"hidden\")}});\n$(\"#logout\").addEventListener(\"click\",async()=>{await api(\"/api/auth/logout\",{method:\"POST\"});await load()});load();\n</script></main></body></html>",{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
}};